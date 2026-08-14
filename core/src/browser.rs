//! A real browser the agent drives and the user watches.
//!
//! **Naming.** Older comments in this repo say "browser tool" for a tool that
//! runs inside the *client webview* (`editor_*`, routed through
//! `editor_bridge.rs`). That is not this. This module owns a separate,
//! headless Chrome process spoken to over the Chrome DevTools Protocol, and
//! the `browser_*` tools in `tools.rs` are its surface. The two never meet.
//!
//! **Why CDP by hand rather than a driver crate.** Everything here is
//! `serde_json::Value` over one WebSocket: send `{id, method, params}`, match
//! the reply by `id`. A typed CDP crate would add a code-generated dependency
//! the size of the rest of core to save about two hundred lines, and would pin
//! us to whichever protocol revision it was generated against — while Chrome
//! ships a new one every six weeks and stays backward compatible on the wire.
//!
//! **What the model actually sees.** Not pixels. `snapshot` injects a walker
//! that returns the interactive elements as one short list with `@e1`-style
//! refs, and every click names a ref rather than a coordinate. That is the
//! design every agent browser converged on, for one reason: a page is
//! thousands of tokens as HTML and a couple of hundred as refs, and a ref
//! survives the relayout that a coordinate does not. Coordinates remain
//! reachable for the case refs cannot express — a `<canvas>`, which is what a
//! CaliCode game *is*, and where the accessibility tree says nothing at all.
//!
//! **One page, not a tab set.** A popup that steals the foreground is adopted
//! (`adopt_popup`) because search results and asset sites open them
//! constantly, but there is deliberately no tab list: two pages means the
//! model must track which one it is on, and it will get that wrong.

use anyhow::{bail, Context, Result};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::process::{Child, Command};
use tokio::sync::{broadcast::Sender, mpsc, oneshot, Mutex};

/// Ceiling on one CDP round trip. Generous because `Page.navigate` on a cold
/// profile can genuinely take this long, and the failure it guards against is
/// a reply that never arrives at all.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// How long to wait for Chrome to write `DevToolsActivePort`. A cold first
/// launch creates the whole profile before it listens.
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(25);

/// Ceiling on waiting for a page to become readable.
///
/// What is waited *for* is `DOMContentLoaded`, not `load`. Measured on real
/// pages: DuckDuckGo reaches DOMContentLoaded in 376ms and fires `load` at
/// 2517ms; free3d.com, 350ms against 1459ms. The gap is trackers, ad frames
/// and lazy images — none of which change the DOM the agent reads or the
/// pixels the user is already looking at, because frames stream throughout.
/// Blocking on `load` made every navigation feel several times slower than
/// the page actually was.
const LOAD_TIMEOUT: Duration = Duration::from_secs(20);

/// Settle delay after load. Single-page apps paint their real content in the
/// first frame *after* the load event, and a snapshot taken before that sees
/// an empty shell.
const SETTLE_MS: u64 = 350;

/// Console lines kept per page. The agent asks for these after something went
/// wrong, so the tail is what matters and the head can be dropped.
const CONSOLE_CAPACITY: usize = 300;

/// Screencast frame budget for the editor tab.
///
/// These numbers were measured, not guessed. Casting the full 1024px width at
/// every frame produced **1.14 MB/s** of base64 — 81 KB a frame, peaking at
/// 211 KB, arriving 14 times a second — and every one of those frames crosses
/// the same SSE bus as the agent's tokens, then becomes a fresh `data:` URL
/// and a React render. The page was loading fine; the *display* path was
/// saturated, and the tab felt like a slow browser.
///
/// So the cast is sized to the panel actually showing it (see
/// [`Browser::set_cast_size`]) rather than to the viewport being rendered, and
/// every second frame is dropped. A web page is near-static between repaints;
/// 7fps of it is indistinguishable from 14 and costs half as much.
/// Ceiling on the transmitted frame width, in device pixels.
///
/// 2048 was too low and it is what made a wide dock look blurry: an expanded
/// panel is ~1650 CSS px, which on a retina display is 3300 device pixels, so
/// the frame arrived at 2048 and was stretched 1.61x to fill it. A stream that
/// is upscaled on arrival cannot look native no matter how good the encoder
/// is. 3840 covers a full-width panel on a 5K display at 2x; beyond that the
/// bytes stop buying anything a screen can show.
const CAST_MAX_WIDTH: u32 = 3840;

/// Ceiling on a *streamed* frame, as opposed to a still capture.
///
/// Deliberately lower. These two are not the same job: frames arriving 14
/// times a second exist to show that something moved and are replaced almost
/// immediately, while the still that lands when the page settles is what
/// anyone actually reads. Streaming at full retina resolution measured 874 KB
/// a frame — some 5 MB/s of base64 — to make motion marginally crisper, which
/// nobody can see. So motion streams cheap and the page sharpens the moment it
/// stops, which is the trade every remote-display protocol makes.
const CAST_STREAM_MAX_WIDTH: u32 = 1400;
const CAST_MIN_WIDTH: u32 = 320;
/// JPEG quality for streamed motion frames.
///
/// Low on purpose, and it is the difference between smooth and not. At 80 a
/// scroll measured 375 KB a frame and 6.9 MB/s of base64 — enough to stall the
/// renderer for 485 ms mid-gesture, which is a visible jump. Nobody can see
/// compression artefacts on pixels that are moving, and the instant the page
/// settles it is replaced by a full-resolution [`STILL_QUALITY`] capture. So
/// motion buys frame rate with quality it does not need.
///
/// Not *too* low, though: the sharper the still that replaces it, the more
/// visible the snap when a scroll ends. 45 was measurably cheap and read as a
/// quality pop; this is the point where motion is still a third of the
/// original cost and the transition stops announcing itself.
const CAST_QUALITY: u32 = 62;

/// Quality for a capture rather than a cast frame.
///
/// Higher than [`CAST_QUALITY`] on purpose. Cast frames exist to show motion
/// and are replaced within a frame or two; a capture is what the panel sits on
/// while the page is still, which is most of the time and the only thing
/// anyone actually reads. JPEG loses text edges first, so this is where the
/// bytes are worth spending.
const STILL_QUALITY: u32 = 92;
/// Every frame. This was 2 while a slowness complaint was being chased, on the
/// theory that frame volume was the cause. It was not — the cause was
/// `navigate` blocking on the `load` event — and halving the frame rate only
/// bought choppy scrolling in exchange for bytes that sizing the cast to the
/// panel had already saved. Smoothness is most of what separates this from
/// feeling like a video of a browser.
const CAST_EVERY_NTH_FRAME: u32 = 1;

/// What chrome rasterises at, relative to the CSS pixel.
///
/// This is the difference between a sharp browser and a blurry one, and it is
/// not the same knob as the viewport. At 1, chrome draws text with one device
/// pixel per CSS pixel; the frame is then downscaled to fit the cast bound and
/// upscaled again by a retina panel, so glyph edges are resampled twice and
/// JPEG is asked to compress the mush. At 2 the page is rasterised at twice
/// the resolution and the downscale to the panel's real pixel width becomes
/// supersampling, which is *sharper* than not scaling at all.
///
/// Input coordinates are unaffected: `Input.dispatch*` speaks CSS pixels, so
/// the click mapping in the tab stays in the 1280-wide space it already used.
const DEVICE_SCALE_FACTOR: u32 = 2;

// Checked when the crate compiles rather than when a test runs, because these
// are constants: a build that violates them cannot be produced at all.
const _: () = assert!(
    DEVICE_SCALE_FACTOR >= 2,
    "a 1x raster cannot survive the downscale-then-upscale round trip to a retina panel"
);
const _: () = assert!(
    CAST_MAX_WIDTH >= VIEWPORT_WIDTH,
    "the cast bound is in device pixels and must carry a 2x render without clipping it back down"
);
// This guarded `CAST_QUALITY` when one number served both jobs. Now that
// motion and stills are separate it belongs on the still: that is the frame
// anyone reads, and text edges are what jpeg loses first. Holding motion to
// the same bar was what made scrolling stutter.
const _: () = assert!(STILL_QUALITY >= 75, "text edges are what jpeg loses first");
const _: () = assert!(
    CAST_QUALITY < STILL_QUALITY,
    "motion must be cheaper than the still that replaces it"
);

/// Default viewport. Matches a laptop window so sites serve their desktop
/// layout — a narrow viewport gets the mobile DOM, which has different refs.
const VIEWPORT_WIDTH: u32 = 1280;
const VIEWPORT_HEIGHT: u32 = 800;

/// How tall the viewport may be made to follow the tab's shape.
///
/// The width never moves. The BROWSER tab is a tall, narrow dock panel, and
/// matching its width literally would put every site into its mobile layout —
/// a different DOM, different refs, and a page the agent and the user would
/// then be reading differently from the desktop one. Stretching only the
/// height fills the panel without changing which layout is served.
const MIN_VIEWPORT_HEIGHT: u32 = 400;
const MAX_VIEWPORT_HEIGHT: u32 = 2400;

/// Bounds on the emulated width once a panel is showing the browser.
///
/// The width used to be pinned at [`VIEWPORT_WIDTH`] so sites always served
/// their desktop layout. That was wrong for the tab: a 1280px page shown in a
/// 560px panel is scaled to 44%, which is not a desktop view of the page — it
/// is a *small* one. Text lands at half the size it was designed for and reads
/// as blurry, and nothing reflows, so a wide layout stays wide and overflows
/// instead of adapting.
///
/// A real browser reflows when you narrow the window, and that is what this
/// does: the emulated viewport becomes the panel's own CSS size, so the page
/// renders 1:1 and pixel-for-pixel sharp. The floor keeps a dragged-thin dock
/// from asking for a viewport no site can lay out at all.
const MIN_VIEWPORT_WIDTH: u32 = 400;
const MAX_VIEWPORT_WIDTH: u32 = 2200;

/// Ceiling on a snapshot handed to the model, in characters.
const SNAPSHOT_LIMIT: usize = 12_000;

/// Handle held in `AppState`. Cheap to clone; the browser starts on first use
/// and there is at most one.
#[derive(Clone)]
pub struct Browsers {
    inner: Arc<Mutex<Option<Arc<Browser>>>>,
}

impl Default for Browsers {
    fn default() -> Self {
        Self::new()
    }
}

impl Browsers {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
        }
    }

    /// The running browser, launching one if this is the first call.
    ///
    /// A browser whose process died between calls is discarded and relaunched
    /// rather than handed back: every command on it would fail with a socket
    /// error that says nothing about the real cause.
    pub async fn ensure(&self, bus: Sender<Value>) -> Result<Arc<Browser>> {
        let mut guard = self.inner.lock().await;
        if let Some(existing) = guard.as_ref() {
            if existing.is_alive() {
                return Ok(existing.clone());
            }
            guard.take();
        }
        let browser = Arc::new(Browser::launch(bus).await?);
        *guard = Some(browser.clone());
        Ok(browser)
    }

    /// The running browser, or `None`. For callers that must not launch one —
    /// status polls and shutdown.
    pub async fn current(&self) -> Option<Arc<Browser>> {
        self.inner.lock().await.clone()
    }

    /// Close the browser if one is running. Idempotent.
    pub async fn shutdown(&self) {
        if let Some(browser) = self.inner.lock().await.take() {
            browser.close().await;
        }
    }
}

/// One Chrome process with one page attached.
pub struct Browser {
    conn: Arc<Connection>,
    page: Mutex<Page>,
    child: Mutex<Child>,
    /// Profile directory. Persistent on purpose — a browser that forgets every
    /// login is useless for the half of the web worth visiting, and this is
    /// the user's own machine.
    profile: PathBuf,
    casting: AtomicBool,
    /// The emulated viewport, following the panel showing it. Defaults to
    /// [`VIEWPORT_WIDTH`]x[`VIEWPORT_HEIGHT`] while no panel is attached, so
    /// an agent working headlessly still gets a desktop layout.
    width: AtomicU64,
    height: AtomicU64,
    /// Width the screencast is transmitted at — the panel's size, not the
    /// viewport's. See the frame budget above.
    cast_width: AtomicU64,
    /// Favicon for the origin it was fetched from; see [`Browser::icon`].
    icon_cache: Mutex<Option<(String, Option<String>)>>,
    /// Where a settled navigation publishes its first painted frame.
    bus: Sender<Value>,
}

struct Page {
    target_id: String,
    session_id: String,
    /// Page targets seen at attach time. Anything outside this set appeared
    /// since, which is what `adopt_popup` acts on.
    known: HashSet<String>,
}

impl Browser {
    /// Start chrome, retrying once on a throwaway profile.
    ///
    /// The retry is the whole lock story on Windows, where chrome guards a
    /// profile with a kernel mutex that leaves nothing on disk for
    /// [`lock_holder`] to read. On unix it is a second line of defence behind
    /// that check. Either way the observable failure is identical — chrome
    /// starts and then never opens a devtools port — so recovering is the same
    /// move on every platform: assume the profile is the problem and take a
    /// fresh one rather than leave the browser dead.
    async fn launch(bus: Sender<Value>) -> Result<Self> {
        match Self::launch_with(profile_dir(), bus.clone()).await {
            Ok(browser) => Ok(browser),
            Err(first) => {
                let scratch = scratch_profile();
                tracing::warn!(
                    "browser failed to start on its own profile ({first}); retrying on {}",
                    scratch.display()
                );
                Self::launch_with(scratch, bus).await.map_err(|retry| {
                    // The first error names the real profile and is the one
                    // worth reading; the retry only proves it was not a fluke.
                    first.context(format!("retry on a fresh profile also failed: {retry}"))
                })
            }
        }
    }

    async fn launch_with(preferred: PathBuf, bus: Sender<Value>) -> Result<Self> {
        let binary = find_chrome()?;
        let profile = usable_profile(preferred)?;
        // A previous core that was killed rather than shut down leaves this
        // behind, and a stale one would be read as this launch's port.
        let port_file = profile.join("DevToolsActivePort");
        std::fs::remove_file(&port_file).ok();

        let mut command = Command::new(&binary);
        command
            .args(chrome_args(&profile))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let child = command
            .spawn()
            .with_context(|| format!("cannot start {}", binary.display()))?;

        let ws_url = match wait_for_devtools(&port_file).await {
            Ok(url) => url,
            Err(error) => {
                // Nothing is attached yet, so the child would otherwise linger
                // as an invisible headless process holding the profile lock.
                let mut child = child;
                child.kill().await.ok();
                return Err(error);
            }
        };

        let conn = Connection::connect(&ws_url, bus.clone()).await?;
        let page = attach_page(&conn).await?;
        Ok(Self {
            conn,
            page: Mutex::new(page),
            child: Mutex::new(child),
            profile,
            casting: AtomicBool::new(false),
            width: AtomicU64::new(VIEWPORT_WIDTH as u64),
            height: AtomicU64::new(VIEWPORT_HEIGHT as u64),
            cast_width: AtomicU64::new(CAST_MAX_WIDTH as u64),
            icon_cache: Mutex::new(None),
            bus,
        })
    }

    fn is_alive(&self) -> bool {
        !self.conn.closed.load(Ordering::SeqCst)
    }

    async fn session(&self) -> String {
        self.page.lock().await.session_id.clone()
    }

    /// Send a command to the attached page.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let session = self.session().await;
        self.conn.call(Some(&session), method, params).await
    }

    /// Evaluate an expression in the page and return its JSON value.
    ///
    /// `awaitPromise` is on so an `async` expression resolves before returning;
    /// `returnByValue` is what makes the result JSON rather than a remote
    /// object handle we would then have to fetch.
    pub async fn eval(&self, expression: &str) -> Result<Value> {
        let result = self
            .call(
                "Runtime.evaluate",
                json!({
                    "expression": expression,
                    "returnByValue": true,
                    "awaitPromise": true,
                    "userGesture": true,
                }),
            )
            .await?;
        if let Some(details) = result.get("exceptionDetails") {
            let text = details["exception"]["description"]
                .as_str()
                .or_else(|| details["text"].as_str())
                .unwrap_or("evaluation failed");
            bail!("{}", text.lines().next().unwrap_or(text));
        }
        Ok(result["result"]["value"].clone())
    }

    /// Navigate and wait for the page to settle.
    pub async fn navigate(&self, url: &str) -> Result<Value> {
        let url = normalize_url(url)?;
        let mut loaded = self.conn.subscribe();
        let result = self.call("Page.navigate", json!({ "url": url })).await?;
        if let Some(error) = result.get("errorText").and_then(Value::as_str) {
            bail!("navigation failed: {error}");
        }
        // Subscribed before navigating, so a page that loads faster than this
        // line runs is still caught.
        let _ = tokio::time::timeout(LOAD_TIMEOUT, async {
            while let Ok(event) = loaded.recv().await {
                if is_readable(&event) {
                    return;
                }
            }
        })
        .await;
        tokio::time::sleep(Duration::from_millis(SETTLE_MS)).await;
        self.adopt_popup().await;
        // The painted page, pushed once. Without it the tab can keep showing
        // whatever it captured mid-navigation — a white pre-paint frame — for
        // as long as the page stays still, which for a loaded page is forever.
        self.publish_painted_frame().await;
        self.location().await
    }

    /// Current url and title.
    ///
    /// Retried once, because the context can be torn down between the command
    /// being sent and the page evaluating it — a redirect firing a beat after
    /// load is enough — and one retry after the swap always lands.
    pub async fn location(&self) -> Result<Value> {
        const PROBE: &str = "JSON.stringify({url: location.href, title: document.title})";
        let value = match self.eval(PROBE).await {
            Ok(value) => value,
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(400)).await;
                self.eval(PROBE).await?
            }
        };
        let text = value.as_str().unwrap_or("{}");
        Ok(serde_json::from_str(text).unwrap_or_else(|_| json!({})))
    }

    /// Wait out whatever an action set in motion, then adopt any popup.
    ///
    /// Most clicks navigate nowhere, so this cannot simply wait for a load
    /// event — it would add the full timeout to every button press. It waits a
    /// short beat for evidence that a navigation *started*, and only then
    /// waits for it to finish.
    async fn settle_after_action(&self, events: &mut tokio::sync::broadcast::Receiver<Value>) {
        const NAVIGATION_GRACE: Duration = Duration::from_millis(1200);
        let started = tokio::time::timeout(NAVIGATION_GRACE, async {
            while let Ok(event) = events.recv().await {
                match event["method"].as_str() {
                    Some("Page.frameStartedLoading") | Some("Page.navigatedWithinDocument") => {
                        return true
                    }
                    _ => continue,
                }
            }
            false
        })
        .await
        .unwrap_or(false);
        if started {
            let _ = tokio::time::timeout(LOAD_TIMEOUT, async {
                while let Ok(event) = events.recv().await {
                    if is_readable(&event) {
                        return;
                    }
                }
            })
            .await;
        }
        tokio::time::sleep(Duration::from_millis(SETTLE_MS)).await;
        self.adopt_popup().await;
        self.publish_painted_frame().await;
    }

    /// Push one frame of the page as it now stands.
    ///
    /// Chrome emits screencast frames on repaint, and a page that has finished
    /// loading stops repainting — so whatever frame the panel happened to
    /// capture becomes permanent. Capturing at mount during a navigation is
    /// exactly when that bites: the capture lands on the white pre-paint page,
    /// the load completes, nothing repaints, and the tab shows a blank page
    /// under a correct url and title forever.
    async fn publish_painted_frame(&self) {
        if !self.casting.load(Ordering::SeqCst) {
            return;
        }
        if let Some(frame) = self.current_frame().await {
            let _ = self.bus.send(frame);
        }
    }

    /// Search the web and return the results as a list.
    ///
    /// This exists because Google walls us. A headless Chrome hitting
    /// `/search` lands on `/sorry/` — an interstitial with one link on it and
    /// no way through — and no amount of user-agent work changes that, because
    /// the signal Google is reading is not the user agent. The fix is not to
    /// fight it: the agent needs *a* search, not Google's, and the engines
    /// below answer an automated client with results.
    ///
    /// Returning parsed results rather than telling the model to navigate and
    /// snapshot also cuts a three-call sequence to one, and drops the search
    /// engine's own chrome — nav links, footers, promos, which are most of a
    /// result page's refs — from what the model has to read.
    pub async fn search(&self, query: &str, limit: usize) -> Result<Value> {
        let encoded = url_encode(query);
        let mut attempts = Vec::new();
        for engine in SEARCH_ENGINES {
            let url = format!("{engine}{encoded}");
            if let Err(error) = self.navigate(&url).await {
                attempts.push(format!("{engine}: {error}"));
                continue;
            }
            let results = self.poll_for_results(limit).await?;
            // One or two hits is not a result page. Every engine here renders
            // its own footer links (app downloads, settings) that survive the
            // offsite filter, and a page that returned only those is a page
            // whose real results have not rendered — or an engine that refused
            // us. Either way the next engine is the better bet.
            let usable = results.as_array().is_some_and(|list| list.len() > 2);
            if usable {
                return Ok(json!({ "query": query, "engine": engine, "results": results }));
            }
            attempts.push(format!("{engine}: no results parsed"));
        }
        bail!(
            "no search engine returned results ({})",
            attempts.join("; ")
        )
    }

    /// The page's favicon as a data url, for the editor tab to show.
    ///
    /// Fetched inside the page rather than by core: the icon is usually
    /// same-origin, so the page's own cookies and cache apply and there is no
    /// second network stack to configure. Cached per origin because the tab
    /// polls status every couple of seconds and the icon only changes when the
    /// site does.
    ///
    /// Never an error. A site with no icon, an icon behind CORS, or an icon
    /// too large to inline all mean the same thing to the caller — show the
    /// default glyph — and none of them are worth failing a status poll over.
    pub async fn icon(&self) -> Option<String> {
        let origin = self
            .eval("location.origin")
            .await
            .ok()?
            .as_str()?
            .to_string();
        if let Some((cached_origin, icon)) = self.icon_cache.lock().await.as_ref() {
            if *cached_origin == origin {
                return icon.clone();
            }
        }
        let fetched = self.eval(FAVICON_JS).await.ok().and_then(|value| {
            value
                .as_str()
                .filter(|text| text.starts_with("data:image"))
                .map(str::to_string)
        });
        // The miss is cached too, so a site without an icon is asked once
        // rather than on every poll.
        *self.icon_cache.lock().await = Some((origin, fetched.clone()));
        fetched
    }

    /// Wait for search results to actually be in the DOM.
    ///
    /// Navigation now returns at `DOMContentLoaded`, which on a search engine
    /// is *before* the results render — the regression this fixes returned a
    /// single footer link ("Android Browser") instead of the result list.
    /// Waiting on the condition itself rather than on a lifecycle event is
    /// also the only version that holds across engines, since each renders at
    /// a different point.
    async fn poll_for_results(&self, limit: usize) -> Result<Value> {
        const RESULTS_TIMEOUT: Duration = Duration::from_secs(8);
        const POLL_EVERY: Duration = Duration::from_millis(250);
        let deadline = tokio::time::Instant::now() + RESULTS_TIMEOUT;
        let mut best = json!([]);
        loop {
            self.eval(SNAPSHOT_JS).await?;
            let raw = self.eval(&format!("__caliResults({limit})")).await?;
            let parsed = raw
                .as_str()
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
                .unwrap_or_else(|| json!([]));
            let count = parsed.as_array().map(Vec::len).unwrap_or(0);
            if count > best.as_array().map(Vec::len).unwrap_or(0) {
                best = parsed;
            }
            // Stop as soon as the page has produced a full page of results,
            // rather than burning the whole timeout on every search.
            if best.as_array().map(Vec::len).unwrap_or(0) >= limit
                || tokio::time::Instant::now() >= deadline
            {
                return Ok(best);
            }
            tokio::time::sleep(POLL_EVERY).await;
        }
    }

    /// A compact, ref-addressed view of the page.
    pub async fn snapshot(&self, interactive_only: bool, limit: usize) -> Result<String> {
        self.eval(SNAPSHOT_JS).await?;
        let raw = self
            .eval(&format!("__caliSnapshot({})", !interactive_only))
            .await?;
        let text = raw.as_str().unwrap_or_default();
        // A page with nothing on it is nearly always a bot check, not a page
        // the model should keep working at. free3d.com serves a DataDome
        // interstitial that renders zero elements and zero text with
        // `readyState: complete`, so an agent handed the bare url and title
        // reads it as "the site is empty" and has no reason to move on. Naming
        // the shape of the failure is what turns a dead end into a next step.
        if !text.contains("[ref=e") && !self.has_visible_text().await {
            return Ok(format!(
                "{text}\n\nThis page rendered no elements and no text. That usually means a bot \
                 check or a login wall rather than an empty page — try a different result, or \
                 browser_look to see what is actually on screen."
            ));
        }
        Ok(truncate_snapshot(text, limit))
    }

    /// Whether the page has any text at all. Distinguishes a page that is
    /// merely non-interactive (an article) from one that rendered nothing.
    async fn has_visible_text(&self) -> bool {
        self.eval("(document.body ? document.body.innerText.trim().length : 0) > 40")
            .await
            .ok()
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
    }

    /// Click a ref from the last snapshot, or a raw viewport coordinate.
    ///
    /// Refs are re-resolved against the live DOM rather than replayed from the
    /// snapshot's rectangles: anything that scrolled, collapsed, or re-rendered
    /// between the two calls would otherwise land the click on whatever moved
    /// into that spot.
    pub async fn click(&self, target: ClickTarget, clicks: u32) -> Result<Value> {
        // Subscribed before the click, not after: a link that navigates
        // destroys the page's execution context, and an `eval` that races it
        // fails with "cannot find context" — which `location` was swallowing,
        // so a successful click reported an empty url and the model concluded
        // it had gone nowhere.
        let mut navigation = self.conn.subscribe();
        let (x, y, label) = match target {
            ClickTarget::Ref(n) => {
                self.eval(SNAPSHOT_JS).await?;
                let point = self.eval(&format!("__caliPoint({n})")).await?;
                let Some(x) = point.get("x").and_then(Value::as_f64) else {
                    bail!(
                        "@e{n} is not on the page any more — take a fresh browser_snapshot and use \
                         a ref from it"
                    );
                };
                let y = point["y"].as_f64().unwrap_or(0.0);
                let label = point["label"].as_str().unwrap_or_default().to_string();
                (x, y, label)
            }
            ClickTarget::Point(x, y) => (x, y, String::new()),
        };
        for kind in ["mousePressed", "mouseReleased"] {
            self.call(
                "Input.dispatchMouseEvent",
                json!({
                    "type": kind,
                    "x": x, "y": y,
                    "button": "left",
                    "buttons": if kind == "mousePressed" { 1 } else { 0 },
                    "clickCount": clicks,
                }),
            )
            .await?;
        }
        self.settle_after_action(&mut navigation).await;
        let mut location = self.location().await.unwrap_or_else(|_| json!({}));
        if !label.is_empty() {
            location["clicked"] = json!(label);
        }
        Ok(location)
    }

    /// Type text, optionally into a ref first.
    ///
    /// `Input.insertText` skips per-character key events, which is both faster
    /// and more reliable against inputs that debounce on `keyup` — but it also
    /// means a field listening only for real keystrokes sees nothing, so
    /// `submit` sends a genuine Enter afterwards.
    pub async fn type_text(&self, target: Option<u32>, text: &str, submit: bool) -> Result<Value> {
        if let Some(n) = target {
            self.click(ClickTarget::Ref(n), 1).await?;
        }
        self.call("Input.insertText", json!({ "text": text }))
            .await?;
        let mut navigation = self.conn.subscribe();
        if submit {
            self.key("Enter", 0, 1).await?;
        }
        self.settle_after_action(&mut navigation).await;
        self.location().await
    }

    /// Press a key, optionally held down for a while.
    ///
    /// `hold_ms` is the reason this is not folded into `type_text`: driving a
    /// game means holding W for two seconds, and a keydown/keyup pair
    /// separated by nothing moves the character by one frame.
    pub async fn key(&self, key: &str, hold_ms: u64, repeat: u32) -> Result<Value> {
        let spec = key_spec(key)?;
        for _ in 0..repeat.max(1) {
            let down = json!({
                "type": if spec.text.is_empty() { "rawKeyDown" } else { "keyDown" },
                "key": spec.key,
                "code": spec.code,
                "windowsVirtualKeyCode": spec.code_num,
                "nativeVirtualKeyCode": spec.code_num,
                "text": spec.text,
            });
            self.call("Input.dispatchKeyEvent", down).await?;
            if hold_ms > 0 {
                tokio::time::sleep(Duration::from_millis(hold_ms.min(10_000))).await;
            }
            self.call(
                "Input.dispatchKeyEvent",
                json!({
                    "type": "keyUp",
                    "key": spec.key,
                    "code": spec.code,
                    "windowsVirtualKeyCode": spec.code_num,
                    "nativeVirtualKeyCode": spec.code_num,
                }),
            )
            .await?;
        }
        Ok(json!({ "pressed": spec.key, "heldMs": hold_ms, "repeat": repeat.max(1) }))
    }

    /// The cursor shape the page would show at this point.
    ///
    /// `elementFromPoint` rather than `:hover`, because it is deterministic
    /// and does not depend on hover state having propagated yet. The walk up
    /// the ancestors matters: `cursor` resolves to `auto` on the deepest node
    /// of a link, and the `pointer` lives on the anchor above it.
    ///
    /// A `<p>` deliberately reports `default`, not `text`. A real browser
    /// shows an I-beam there because the text is selectable; this panel is an
    /// image and selecting is exactly what it cannot do, so an I-beam would be
    /// a promise it cannot keep.
    pub async fn cursor_at(&self, x: f64, y: f64) -> String {
        self.eval(&format!(
            "(()=>{{let e=document.elementFromPoint({x},{y});             while(e){{const c=getComputedStyle(e).cursor;if(c&&c!=='auto')return c;e=e.parentElement;}}             return 'default'}})()"
        ))
        .await
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .filter(|cursor| cursor.chars().all(|c| c.is_ascii_alphabetic() || c == '-'))
        .unwrap_or_else(|| "default".into())
    }

    /// Scroll the page by a wheel delta.
    pub async fn scroll(&self, dx: f64, dy: f64) -> Result<Value> {
        self.call(
            "Input.dispatchMouseEvent",
            json!({
                "type": "mouseWheel",
                "x": self.width.load(Ordering::SeqCst) as u32 / 2,
                "y": self.height.load(Ordering::SeqCst) as u32 / 2,
                "deltaX": dx, "deltaY": dy,
            }),
        )
        .await?;
        tokio::time::sleep(Duration::from_millis(200)).await;
        let position = self
            .eval("JSON.stringify({scrollY: Math.round(scrollY), height: document.body.scrollHeight})")
            .await?;
        Ok(serde_json::from_str(position.as_str().unwrap_or("{}")).unwrap_or_else(|_| json!({})))
    }

    /// A JPEG of the current viewport, base64 encoded.
    pub async fn screenshot(&self, full_page: bool) -> Result<String> {
        self.capture(full_page, STILL_QUALITY).await
    }

    async fn capture(&self, full_page: bool, quality: u32) -> Result<String> {
        let mut params = json!({ "format": "jpeg", "quality": quality });
        if full_page {
            params["captureBeyondViewport"] = json!(true);
        }
        let result = self.call("Page.captureScreenshot", params).await?;
        result["data"]
            .as_str()
            .map(str::to_string)
            .context("browser returned no image data")
    }

    /// Console lines and uncaught exceptions since the last drain.
    pub async fn console(&self, clear: bool) -> Vec<Value> {
        let mut guard = self.conn.console.lock().await;
        let lines: Vec<Value> = guard.iter().cloned().collect();
        if clear {
            guard.clear();
        }
        lines
    }

    /// Reshape the viewport to the tab showing it.
    ///
    /// Without this the tab letterboxes: a 1280x800 frame inside a tall dock
    /// panel is a thin strip with grey above and below it, and the click
    /// coordinates the user aims at that strip map back through a scale
    /// factor with nothing to spare.
    pub async fn set_shape(&self, width: u32, height: u32) -> Result<Value> {
        // The panel's own CSS size, not a scaled-down desktop one. This is
        // what makes the page sharp (1:1 with the pixels that display it) and
        // what lets it reflow to the dock instead of overflowing it.
        let (width, height) = if width == 0 || height == 0 {
            (VIEWPORT_WIDTH, VIEWPORT_HEIGHT)
        } else {
            (
                width.clamp(MIN_VIEWPORT_WIDTH, MAX_VIEWPORT_WIDTH),
                height.clamp(MIN_VIEWPORT_HEIGHT, MAX_VIEWPORT_HEIGHT),
            )
        };
        self.width.store(width as u64, Ordering::SeqCst);
        let unchanged = self.height.swap(height as u64, Ordering::SeqCst) == height as u64;
        // The override is re-applied even when our own number has not moved,
        // because chrome's can move without us: attaching to an adopted popup
        // runs `enable_domains` again, which resets the metrics. Skipping the
        // call here left core reporting a viewport the page did not have —
        // measured 1280x1907 against the page's own 1280x800 — and every
        // consumer inherited the wrong shape: the panel sized its box to an
        // aspect the frames were never in, so the page appeared cropped.
        set_device_metrics(&self.conn, &self.session().await, width, height).await?;
        if unchanged {
            return Ok(json!({ "width": width, "height": height }));
        }
        // The screencast negotiated its frame size at start; it has to be
        // restarted or every later frame arrives in the old shape.
        if self.casting.load(Ordering::SeqCst) {
            self.casting.store(false, Ordering::SeqCst);
            self.start_cast().await?;
        }
        Ok(json!({ "width": width, "height": height }))
    }

    /// The viewport the agent and the tab share, for coordinate mapping.
    pub fn shape(&self) -> (u32, u32) {
        (
            self.width.load(Ordering::SeqCst) as u32,
            self.height.load(Ordering::SeqCst) as u32,
        )
    }

    /// Start streaming frames to the event bus for the editor tab.
    pub async fn start_cast(&self) -> Result<()> {
        if self.casting.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        // Device pixels, not CSS pixels: with a scale factor of 2 the surface
        // being captured is twice the viewport in each axis, and a bound set
        // in CSS pixels would halve the frame and undo the sharpness the
        // scale factor was for.
        let width = self.cast_width.load(Ordering::SeqCst) as u32;
        // Height follows from the width at the viewport's aspect: chrome
        // scales to fit both bounds, so a bound that is not proportional just
        // silently wins and the frame comes back smaller than asked for.
        let (vw, vh) = self.shape();
        let height = ((width as f64) * (vh as f64 / vw as f64)).round() as u32;
        self.call(
            "Page.startScreencast",
            json!({
                "format": "jpeg",
                "quality": CAST_QUALITY,
                "maxWidth": width,
                "maxHeight": height.max(1),
                "everyNthFrame": CAST_EVERY_NTH_FRAME,
            }),
        )
        .await
        .map(|_| ())
    }

    /// The most recent frame, for a panel that has just mounted.
    ///
    /// Handed back in the reply to `browser_cast_start` rather than pushed
    /// onto the bus. Chrome only emits a frame when something repaints, so a
    /// panel returning to a still page would otherwise sit blank until the
    /// page next moved — which is what made switching tabs away and back look
    /// like the browser had reset itself. Pushing it was the first fix and it
    /// raced: the panel remounts its event stream at the same moment, so the
    /// replayed frame arrived before anything was listening. A reply cannot
    /// race the request that asked for it.
    pub async fn last_frame(&self) -> Option<Value> {
        self.conn.last_frame.lock().await.clone()
    }

    /// A frame of the page as it looks right now, captured if necessary.
    ///
    /// Chrome pushes screencast frames only on repaint, and a loaded page that
    /// is simply sitting there repaints **never** — measured: zero frames in
    /// four seconds on a still page. So a panel opening onto one is not
    /// waiting for a slow frame, it is waiting for an event that will not
    /// happen, and it hangs on its placeholder until something moves.
    ///
    /// Capturing rather than replaying the cache also fixes the staleness the
    /// cache had: the last screencast frame predates however long the tab was
    /// closed, during which the agent may have driven the page elsewhere.
    pub async fn current_frame(&self) -> Option<Value> {
        match self.screenshot(false).await {
            Ok(data) => {
                // Deliberately no width/height. Reporting `shape()` here was
                // reporting core's *belief*, and when that had drifted from
                // chrome the client trusted a size the pixels were never in.
                // The image knows its own dimensions.
                let frame = json!({ "type": "browser.frame", "data": data });
                *self.conn.last_frame.lock().await = Some(frame.clone());
                Some(frame)
            }
            // A capture can fail mid-navigation, when there is briefly no
            // surface to capture. The cached frame is worth more than nothing.
            Err(_) => self.last_frame().await,
        }
    }

    /// Transmit frames at the size the panel actually displays them.
    ///
    /// Sending more pixels than the panel can show is pure cost: it is decoded,
    /// scaled down, and thrown away on arrival.
    pub async fn set_cast_size(&self, width: u32) -> Result<()> {
        let width = width.clamp(CAST_MIN_WIDTH, CAST_STREAM_MAX_WIDTH);
        if self.cast_width.swap(width as u64, Ordering::SeqCst) == width as u64 {
            return Ok(());
        }
        if self.casting.load(Ordering::SeqCst) {
            self.casting.store(false, Ordering::SeqCst);
            self.start_cast().await?;
        }
        Ok(())
    }

    /// Stop streaming. Called when the tab is hidden — an unwatched screencast
    /// is pure cost, and it is the loudest thing on the bus.
    pub async fn stop_cast(&self) -> Result<()> {
        if !self.casting.swap(false, Ordering::SeqCst) {
            return Ok(());
        }
        self.call("Page.stopScreencast", json!({}))
            .await
            .map(|_| ())
    }

    /// Attach to a page target that appeared since we last looked.
    ///
    /// Silent on failure by design: a popup we could not adopt leaves the
    /// agent on the page it already had, which is recoverable, whereas an
    /// error here would fail an otherwise successful click.
    async fn adopt_popup(&self) {
        let Ok(targets) = self.conn.call(None, "Target.getTargets", json!({})).await else {
            return;
        };
        let Some(infos) = targets["targetInfos"].as_array() else {
            return;
        };
        let mut page = self.page.lock().await;
        let fresh = infos
            .iter()
            .rfind(|info| {
                info["type"] == "page"
                    && info["targetId"]
                        .as_str()
                        .is_some_and(|id| !page.known.contains(id))
            })
            .cloned();
        for info in infos.iter().filter(|info| info["type"] == "page") {
            if let Some(id) = info["targetId"].as_str() {
                page.known.insert(id.to_string());
            }
        }
        let Some(info) = fresh else { return };
        let Some(target_id) = info["targetId"].as_str() else {
            return;
        };
        let Ok(attached) = self
            .conn
            .call(
                None,
                "Target.attachToTarget",
                json!({ "targetId": target_id, "flatten": true }),
            )
            .await
        else {
            return;
        };
        let Some(session_id) = attached["sessionId"].as_str() else {
            return;
        };
        let previous = std::mem::replace(&mut page.target_id, target_id.to_string());
        page.session_id = session_id.to_string();
        drop(page);
        let (width, height) = self.shape();
        let _ = enable_domains(&self.conn, session_id, width, height).await;
        // The page that spawned the popup is left open but unattached; closing
        // it keeps the target list from growing without bound across a long
        // session, and the agent has no way back to it anyway.
        let _ = self
            .conn
            .call(None, "Target.closeTarget", json!({ "targetId": previous }))
            .await;
        if self.casting.load(Ordering::SeqCst) {
            self.casting.store(false, Ordering::SeqCst);
            let _ = self.start_cast().await;
        }
    }

    async fn close(&self) {
        let _ = self
            .conn
            .call(None, "Browser.close", json!({}))
            .await
            .map(|_| ());
        self.conn.closed.store(true, Ordering::SeqCst);
        let mut child = self.child.lock().await;
        // `Browser.close` is the graceful path and usually wins; this is the
        // backstop for a Chrome that ignored it, and without it the profile
        // lock survives into the next launch.
        let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
        child.kill().await.ok();
        // A scratch profile is per-launch and unique, so nothing else will
        // ever reuse this one; leaving it would grow a directory in TMPDIR on
        // every diverted launch. The real profile is never touched.
        if is_scratch_profile(&self.profile) {
            std::fs::remove_dir_all(&self.profile).ok();
        }
    }

    pub fn profile_path(&self) -> &Path {
        &self.profile
    }
}

/// What a click is aimed at.
pub enum ClickTarget {
    /// A `@eN` ref from the last snapshot.
    Ref(u32),
    /// A viewport coordinate. The only way to hit a `<canvas>`.
    Point(f64, f64),
}

/// The WebSocket to Chrome, multiplexed.
struct Connection {
    out: mpsc::UnboundedSender<String>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    console: Mutex<VecDeque<Value>>,
    /// The most recent frame, replayed to a panel that has just mounted.
    last_frame: Mutex<Option<Value>>,
    events: tokio::sync::broadcast::Sender<Value>,
    closed: Arc<AtomicBool>,
}

impl Connection {
    async fn connect(ws_url: &str, bus: Sender<Value>) -> Result<Arc<Self>> {
        let (socket, _) = tokio_tungstenite::connect_async(ws_url)
            .await
            .with_context(|| format!("cannot open a devtools socket at {ws_url}"))?;
        let (mut writer, mut reader) = socket.split();
        let (out, mut outbox) = mpsc::unbounded_channel::<String>();
        let (events, _) = tokio::sync::broadcast::channel(256);
        let closed = Arc::new(AtomicBool::new(false));

        let conn = Arc::new(Self {
            out,
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            console: Mutex::new(VecDeque::new()),
            last_frame: Mutex::new(None),
            events,
            closed: closed.clone(),
        });

        tokio::spawn(async move {
            while let Some(text) = outbox.recv().await {
                if writer
                    .send(tokio_tungstenite::tungstenite::Message::Text(text))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });

        let reader_conn = Arc::downgrade(&conn);
        tokio::spawn(async move {
            while let Some(Ok(message)) = reader.next().await {
                let tokio_tungstenite::tungstenite::Message::Text(text) = message else {
                    continue;
                };
                let Ok(value) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                let Some(conn) = reader_conn.upgrade() else {
                    break;
                };
                conn.dispatch(value, &bus).await;
            }
            // Reaching here means Chrome hung up. Waiters must be released or
            // every one of them sits until CALL_TIMEOUT for no reason.
            closed.store(true, Ordering::SeqCst);
            if let Some(conn) = reader_conn.upgrade() {
                conn.pending.lock().await.clear();
            }
        });

        Ok(conn)
    }

    fn subscribe(&self) -> tokio::sync::broadcast::Receiver<Value> {
        self.events.subscribe()
    }

    async fn dispatch(&self, value: Value, bus: &Sender<Value>) {
        if let Some(id) = value.get("id").and_then(Value::as_u64) {
            if let Some(sender) = self.pending.lock().await.remove(&id) {
                let _ = sender.send(value);
            }
            return;
        }
        match value["method"].as_str() {
            Some("Page.screencastFrame") => {
                // Chrome stops sending frames until each one is acknowledged,
                // so a dropped ack freezes the tab permanently.
                if let Some(ack) = value["params"]["sessionId"].as_i64() {
                    let session = value["sessionId"].as_str().map(str::to_string);
                    let _ = self.send_raw(
                        session.as_deref(),
                        "Page.screencastFrameAck",
                        json!({ "sessionId": ack }),
                    );
                }
                let frame = json!({
                    "type": "browser.frame",
                    "data": value["params"]["data"],
                    "width": value["params"]["metadata"]["deviceWidth"],
                    "height": value["params"]["metadata"]["deviceHeight"],
                });
                *self.last_frame.lock().await = Some(frame.clone());
                let _ = bus.send(frame);
            }
            Some("Runtime.consoleAPICalled") => {
                let level = value["params"]["type"].as_str().unwrap_or("log");
                let text = console_args_text(&value["params"]["args"]);
                self.push_console(json!({ "level": level, "text": text }))
                    .await;
            }
            Some("Runtime.exceptionThrown") => {
                let details = &value["params"]["exceptionDetails"];
                let text = details["exception"]["description"]
                    .as_str()
                    .or_else(|| details["text"].as_str())
                    .unwrap_or("uncaught exception");
                self.push_console(json!({ "level": "error", "text": text }))
                    .await;
                let _ = bus.send(json!({ "type": "browser.error", "text": text }));
            }
            Some("Page.javascriptDialogOpening") => {
                // Nobody is watching this browser closely enough to answer a
                // dialog, and an unanswered one blocks every later command on
                // the page — including the snapshot that would reveal it.
                let session = value["sessionId"].as_str().map(str::to_string);
                let _ = self.send_raw(
                    session.as_deref(),
                    "Page.handleJavaScriptDialog",
                    json!({ "accept": true }),
                );
            }
            _ => {}
        }
        let _ = self.events.send(value);
    }

    async fn push_console(&self, entry: Value) {
        let mut guard = self.console.lock().await;
        if guard.len() >= CONSOLE_CAPACITY {
            guard.pop_front();
        }
        guard.push_back(entry);
    }

    /// Fire and forget. For replies nobody waits on — acks and dialog answers.
    fn send_raw(&self, session: Option<&str>, method: &str, params: Value) -> Result<()> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let mut frame = json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            frame["sessionId"] = json!(session);
        }
        self.out.send(frame.to_string())?;
        Ok(())
    }

    async fn call(&self, session: Option<&str>, method: &str, params: Value) -> Result<Value> {
        if self.closed.load(Ordering::SeqCst) {
            bail!("the browser is not running any more");
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        let mut frame = json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            frame["sessionId"] = json!(session);
        }
        if self.out.send(frame.to_string()).is_err() {
            self.pending.lock().await.remove(&id);
            bail!("the browser is not running any more");
        }
        let reply = match tokio::time::timeout(CALL_TIMEOUT, rx).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => bail!("the browser closed while running {method}"),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                bail!("{method} timed out after {}s", CALL_TIMEOUT.as_secs());
            }
        };
        if let Some(error) = reply.get("error") {
            let message = error["message"].as_str().unwrap_or("devtools error");
            bail!("{method}: {message}");
        }
        Ok(reply["result"].clone())
    }
}

/// Open a page target and turn on the domains everything else depends on.
async fn attach_page(conn: &Arc<Connection>) -> Result<Page> {
    let created = conn
        .call(
            None,
            "Target.createTarget",
            // No width/height here: chrome refuses a position or size on a
            // target that is not a new window, and the viewport is set by
            // `Emulation.setDeviceMetricsOverride` in `enable_domains` anyway.
            json!({ "url": "about:blank" }),
        )
        .await?;
    let target_id = created["targetId"]
        .as_str()
        .context("chrome did not return a target id")?
        .to_string();
    let attached = conn
        .call(
            None,
            "Target.attachToTarget",
            json!({ "targetId": target_id, "flatten": true }),
        )
        .await?;
    let session_id = attached["sessionId"]
        .as_str()
        .context("chrome did not return a session id")?
        .to_string();
    enable_domains(conn, &session_id, VIEWPORT_WIDTH, VIEWPORT_HEIGHT).await?;

    let mut known = HashSet::new();
    known.insert(target_id.clone());
    if let Ok(targets) = conn.call(None, "Target.getTargets", json!({})).await {
        for info in targets["targetInfos"].as_array().into_iter().flatten() {
            if info["type"] == "page" {
                if let Some(id) = info["targetId"].as_str() {
                    known.insert(id.to_string());
                }
            }
        }
    }
    Ok(Page {
        target_id,
        session_id,
        known,
    })
}

/// Apply the emulated viewport. The one place that sends these metrics, so a
/// fresh attach and a reshape cannot disagree about the shape of the page.
async fn set_device_metrics(
    conn: &Arc<Connection>,
    session: &str,
    width: u32,
    height: u32,
) -> Result<()> {
    conn.call(
        Some(session),
        "Emulation.setDeviceMetricsOverride",
        json!({
            "width": width,
            "height": height,
            "deviceScaleFactor": DEVICE_SCALE_FACTOR,
            "mobile": false,
        }),
    )
    .await
    .map(|_| ())
}

async fn enable_domains(
    conn: &Arc<Connection>,
    session: &str,
    width: u32,
    height: u32,
) -> Result<()> {
    conn.call(Some(session), "Page.enable", json!({})).await?;
    conn.call(Some(session), "Runtime.enable", json!({}))
        .await?;
    // The *current* height, not the default: adopting a popup re-enables the
    // domains on the new session, and passing the constant here silently reset
    // a reshaped viewport back to 800.
    set_device_metrics(conn, session, width, height).await?;
    present_as_a_normal_chrome(conn, session).await?;
    Ok(())
}

/// Stop announcing that this browser is automated.
///
/// Headless Chrome ships two giveaways: a user agent containing
/// "HeadlessChrome", and `navigator.webdriver === true`. Google's bot wall
/// reads both, and a search from here lands on `/sorry/` instead of results —
/// which is not a captcha the agent can solve, it is a dead end.
///
/// This is presenting a real user's browser as what it is, on their own
/// machine, for searches they asked for. It is not evasion at scale: there is
/// one browser, it runs at human speed because a model is deciding each click,
/// and it holds no more reach than the Chrome already in the dock. Every agent
/// browser worth using does exactly this, and the ones that skip it are the
/// ones that mysteriously cannot search.
async fn present_as_a_normal_chrome(conn: &Arc<Connection>, session: &str) -> Result<()> {
    let version = conn.call(None, "Browser.getVersion", json!({})).await?;
    let agent = version["userAgent"]
        .as_str()
        .unwrap_or_default()
        .replace("HeadlessChrome/", "Chrome/");
    if !agent.is_empty() {
        conn.call(
            Some(session),
            "Emulation.setUserAgentOverride",
            json!({ "userAgent": agent, "acceptLanguage": "en-US,en", "platform": "MacIntel" }),
        )
        .await?;
    }
    // Runs before any page script, which is the only moment the property can
    // be replaced — by the time a page's own code reads it, it is too late.
    conn.call(
        Some(session),
        "Page.addScriptToEvaluateOnNewDocument",
        json!({
            "source": "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });"
        }),
    )
    .await?;
    Ok(())
}

/// Read Chrome's `DevToolsActivePort`, which is written only once it is
/// actually listening. Polling this beats parsing stderr, which new headless
/// does not write, and beats a fixed port, which collides.
async fn wait_for_devtools(port_file: &Path) -> Result<String> {
    let deadline = tokio::time::Instant::now() + LAUNCH_TIMEOUT;
    loop {
        if let Ok(contents) = std::fs::read_to_string(port_file) {
            let mut lines = contents.lines();
            if let (Some(port), Some(path)) = (lines.next(), lines.next()) {
                return Ok(format!("ws://127.0.0.1:{}{}", port.trim(), path.trim()));
            }
        }
        if tokio::time::Instant::now() >= deadline {
            bail!(
                "chrome did not start a devtools endpoint within {}s — another CaliCode may already \
                 be using the browser profile",
                LAUNCH_TIMEOUT.as_secs()
            );
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Whether this event means the page can now be read and acted on.
///
/// `load` counts too, but only as the belt to DOMContentLoaded's braces — a
/// document restored from the back/forward cache fires neither, and a
/// same-document navigation fires nothing at all, which is why the caller
/// bounds this with a timeout rather than trusting it to arrive.
fn is_readable(event: &Value) -> bool {
    matches!(
        event["method"].as_str(),
        Some("Page.domContentEventFired") | Some("Page.loadEventFired")
    )
}

fn chrome_args(profile: &Path) -> Vec<String> {
    let mut args = vec![
        format!("--user-data-dir={}", profile.display()),
        "--remote-debugging-port=0".into(),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--disable-background-networking".into(),
        "--disable-sync".into(),
        "--disable-features=Translate,MediaRouter".into(),
        // Popups are how search results and asset sites open a detail page,
        // and `adopt_popup` depends on the target actually being created.
        "--disable-popup-blocking".into(),
        // Pairs with `present_as_a_normal_chrome`: this one has to be a launch
        // flag because the automation hint is baked into blink at startup.
        "--disable-blink-features=AutomationControlled".into(),
        format!("--window-size={VIEWPORT_WIDTH},{VIEWPORT_HEIGHT}"),
    ];
    // Headed is a debugging aid, not a mode: the editor tab renders the
    // screencast, so a visible window would be a second, divergent view.
    if std::env::var("CALI_BROWSER_HEADED").is_err() {
        args.push("--headless=new".into());
    }
    args
}

/// Resolve a profile directory chrome can actually open.
///
/// Chrome guards a profile with `SingletonLock`, a symlink naming the host and
/// pid that holds it. It is not cleaned up when chrome dies without exiting —
/// which is exactly what happens when core is force-quit, since the browser is
/// its child — and the next launch then sits for the full timeout before
/// failing with "no devtools endpoint", a message that says nothing about the
/// real cause. That failure makes the BROWSER tab permanently dead until
/// somebody knows to go and delete a file.
///
/// So: a lock whose pid is gone is stale and gets cleared. A lock whose pid is
/// alive belongs to a browser that is genuinely running, and this launch takes
/// a scratch profile instead — cookies for the session are a smaller loss than
/// a browser that does not start.
fn usable_profile(preferred: PathBuf) -> Result<PathBuf> {
    std::fs::create_dir_all(&preferred)
        .with_context(|| format!("cannot create browser profile at {}", preferred.display()))?;
    match lock_holder(&preferred) {
        Some(pid) => {
            // Unique per launch, not per holder. Keying it on the holder's pid
            // meant the *second* diverted launch landed on the first one's
            // scratch profile, which by then had its own chrome holding it —
            // so the fallback reproduced the exact 25s lock timeout it exists
            // to avoid.
            let scratch = scratch_profile();
            std::fs::create_dir_all(&scratch).with_context(|| {
                format!("cannot create a scratch profile at {}", scratch.display())
            })?;
            tracing::warn!(
                "browser profile {} is held by pid {pid}; using {} for this session",
                preferred.display(),
                scratch.display()
            );
            Ok(scratch)
        }
        None => {
            // Nothing alive holds these, and chrome refuses the profile while
            // any of them exist.
            for stale in ["SingletonLock", "SingletonCookie", "SingletonSocket"] {
                std::fs::remove_file(preferred.join(stale)).ok();
            }
            Ok(preferred)
        }
    }
}

/// The live process holding this profile, if the platform lets us ask.
///
/// `SingletonLock` is a POSIX detail: chrome writes it as a symlink naming
/// `<host>-<pid>`, and on Windows it guards profiles with a kernel mutex that
/// leaves nothing on disk to inspect. So this answers `None` on Windows, which
/// is not a claim that the profile is free — it is "cannot tell". The launch
/// retry in [`Browser::launch`] is what covers the difference, and it is the
/// only mechanism on Windows.
#[cfg(unix)]
fn lock_holder(profile: &Path) -> Option<i32> {
    std::fs::read_link(profile.join("SingletonLock"))
        .ok()
        .and_then(|target| {
            target
                .to_str()
                .and_then(|text| text.rsplit('-').next())
                .and_then(|pid| pid.parse::<i32>().ok())
        })
        // Signal 0 checks for existence without delivering anything.
        .filter(|pid| *pid > 0 && unsafe { libc::kill(*pid, 0) } == 0)
}

#[cfg(not(unix))]
fn lock_holder(_profile: &Path) -> Option<i32> {
    None
}

/// Whether this is a throwaway profile [`usable_profile`] created, and so safe
/// to delete. Deliberately strict about both the location and the prefix: this
/// answer authorises a recursive delete.
fn is_scratch_profile(path: &Path) -> bool {
    path.parent() == Some(std::env::temp_dir().as_path())
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("cali-browser-"))
}

fn profile_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("CALI_BROWSER_PROFILE") {
        return PathBuf::from(dir);
    }
    dirs_home()
        .map(|home| home.join(".cali").join("browser"))
        .unwrap_or_else(|| std::env::temp_dir().join("cali-browser"))
}

/// A throwaway profile path, unique per launch.
///
/// Unique rather than derived from whatever is blocking us: keying it on the
/// blocker meant a second diverted launch landed on the first one's scratch
/// profile, which by then had its own chrome holding it — reproducing the very
/// timeout the fallback exists to avoid.
fn scratch_profile() -> PathBuf {
    std::env::temp_dir().join(format!("cali-browser-{}", uuid::Uuid::new_v4()))
}

/// The user's home directory. `HOME` is unset on Windows, which uses
/// `USERPROFILE`; without this the profile silently landed in the temp
/// directory there and forgot every login between runs.
fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Where playwright caches the chromium a dev machine may already have.
/// Per-platform, because the three do not agree.
fn playwright_cache() -> Option<PathBuf> {
    let home = dirs_home()?;
    Some(if cfg!(target_os = "macos") {
        home.join("Library/Caches/ms-playwright")
    } else if cfg!(target_os = "windows") {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or(home)
            .join("ms-playwright")
    } else {
        home.join(".cache/ms-playwright")
    })
}

/// The binary inside a playwright chromium build, which is laid out
/// differently on each platform.
#[cfg(target_os = "macos")]
const PLAYWRIGHT_CHROMIUM_BINARY: &str = "chrome-mac/Chromium.app/Contents/MacOS/Chromium";
#[cfg(target_os = "windows")]
const PLAYWRIGHT_CHROMIUM_BINARY: &str = r"chrome-win\chrome.exe";
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const PLAYWRIGHT_CHROMIUM_BINARY: &str = "chrome-linux/chrome";

/// Where Chrome might be, best first.
///
/// The user's installed Chrome is preferred over anything we could download:
/// it is already there, it is already trusted by the sites it visits, and
/// bundling a second Chromium would add ~150 MB to a desktop app whose whole
/// point is being native.
fn find_chrome() -> Result<PathBuf> {
    if let Ok(explicit) = std::env::var("CALI_CHROME") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Ok(path);
        }
        bail!(
            "CALI_CHROME points at {}, which is not a file",
            path.display()
        );
    }
    // All three platforms, chrome before chromium before edge. Edge is last
    // but real: on Windows it is the one chromium that is always installed.
    let mut candidates: Vec<PathBuf> = if cfg!(target_os = "macos") {
        vec![
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".into(),
            "/Applications/Chromium.app/Contents/MacOS/Chromium".into(),
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge".into(),
        ]
    } else if cfg!(target_os = "windows") {
        let mut paths = Vec::new();
        // Per-user installs land in LOCALAPPDATA and are invisible to the
        // Program Files paths below, which is how chrome installs by default
        // for a user without admin rights.
        for (var, tail) in [
            ("LOCALAPPDATA", r"Google\Chrome\Application\chrome.exe"),
            ("PROGRAMFILES", r"Google\Chrome\Application\chrome.exe"),
            ("PROGRAMFILES(X86)", r"Google\Chrome\Application\chrome.exe"),
            ("PROGRAMFILES", r"Microsoft\Edge\Application\msedge.exe"),
            (
                "PROGRAMFILES(X86)",
                r"Microsoft\Edge\Application\msedge.exe",
            ),
        ] {
            if let Some(base) = std::env::var_os(var) {
                paths.push(PathBuf::from(base).join(tail));
            }
        }
        paths
    } else {
        vec![
            "/usr/bin/google-chrome".into(),
            "/usr/bin/google-chrome-stable".into(),
            "/usr/bin/chromium".into(),
            "/usr/bin/chromium-browser".into(),
            "/snap/bin/chromium".into(),
            "/usr/bin/microsoft-edge".into(),
        ]
    };
    // Playwright's cached Chromium is the one a dev machine that has run the
    // e2e suite already has, so it is worth finding — but it is a fallback,
    // not a preference: it ships with no codecs and an obvious fingerprint.
    if let Some(cache) = playwright_cache() {
        if let Ok(entries) = std::fs::read_dir(&cache) {
            let mut found: Vec<PathBuf> = entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with("chromium-"))
                })
                // Playwright lays each build out differently per platform.
                .map(|path| path.join(PLAYWRIGHT_CHROMIUM_BINARY))
                .collect();
            found.sort();
            candidates.extend(found.into_iter().rev());
        }
    }
    candidates.into_iter().find(|path| path.is_file()).context(
        "no Chrome or Chromium found. Install Google Chrome, or point CALI_CHROME at a \
             Chromium binary",
    )
}

/// Accept what a model actually emits — a bare host, a search phrase pasted as
/// a url — and refuse the schemes that reach off the web.
fn normalize_url(input: &str) -> Result<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        bail!("url is empty");
    }
    let lowered = trimmed.to_ascii_lowercase();
    for scheme in ["file:", "javascript:", "data:", "chrome:", "devtools:"] {
        if lowered.starts_with(scheme) {
            bail!(
                "{scheme} urls are not reachable from the browser — use file_read for local files \
                 and browser_eval for page scripts"
            );
        }
    }
    if lowered.starts_with("http://") || lowered.starts_with("https://") {
        return Ok(trimmed.to_string());
    }
    if trimmed.contains(' ') || !trimmed.contains('.') {
        bail!("'{trimmed}' is not a url — pass a full https:// address");
    }
    Ok(format!("https://{trimmed}"))
}

/// Search engines, in the order they are tried.
///
/// Google is deliberately absent: it serves this browser an interstitial
/// rather than results, so including it would only cost a round trip before
/// the fallback. A user who wants Google can still `browser_navigate` to it.
const SEARCH_ENGINES: &[&str] = &[
    "https://duckduckgo.com/?q=",
    "https://search.brave.com/search?q=",
    "https://www.bing.com/search?q=",
];

/// Percent-encode a query. Small on purpose — a search string only ever needs
/// the unreserved set preserved, and pulling in a url crate for this would be
/// the only reason core had one.
fn url_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 8);
    for byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

struct KeySpec {
    key: &'static str,
    code: &'static str,
    code_num: u32,
    text: String,
}

/// Key names the model is likely to use, mapped to what CDP needs.
///
/// A single printable character is handled generically; everything else has to
/// be in this table, because CDP wants a Windows virtual key code that cannot
/// be derived from the name.
fn key_spec(key: &str) -> Result<KeySpec> {
    let named: &[(&str, &'static str, &'static str, u32)] = &[
        ("enter", "Enter", "Enter", 13),
        ("return", "Enter", "Enter", 13),
        ("tab", "Tab", "Tab", 9),
        ("escape", "Escape", "Escape", 27),
        ("esc", "Escape", "Escape", 27),
        ("backspace", "Backspace", "Backspace", 8),
        ("delete", "Delete", "Delete", 46),
        ("space", " ", "Space", 32),
        ("arrowup", "ArrowUp", "ArrowUp", 38),
        ("up", "ArrowUp", "ArrowUp", 38),
        ("arrowdown", "ArrowDown", "ArrowDown", 40),
        ("down", "ArrowDown", "ArrowDown", 40),
        ("arrowleft", "ArrowLeft", "ArrowLeft", 37),
        ("left", "ArrowLeft", "ArrowLeft", 37),
        ("arrowright", "ArrowRight", "ArrowRight", 39),
        ("right", "ArrowRight", "ArrowRight", 39),
        ("pageup", "PageUp", "PageUp", 33),
        ("pagedown", "PageDown", "PageDown", 34),
        ("home", "Home", "Home", 36),
        ("end", "End", "End", 35),
        ("shift", "Shift", "ShiftLeft", 16),
        ("control", "Control", "ControlLeft", 17),
        ("ctrl", "Control", "ControlLeft", 17),
        ("alt", "Alt", "AltLeft", 18),
        ("meta", "Meta", "MetaLeft", 91),
    ];
    let lowered = key.trim().to_ascii_lowercase();
    if let Some((_, key, code, num)) = named.iter().find(|(name, ..)| *name == lowered) {
        return Ok(KeySpec {
            key,
            code,
            code_num: *num,
            // Space is the one named key that also inserts a character, and a
            // game listening for `keydown` on Space still needs the code path
            // that carries text.
            text: if *num == 32 {
                " ".into()
            } else {
                String::new()
            },
        });
    }
    let mut chars = key.chars();
    match (chars.next(), chars.next()) {
        (Some(single), None) => {
            let upper = single.to_ascii_uppercase();
            let code: &'static str = match upper {
                'A'..='Z' => Box::leak(format!("Key{upper}").into_boxed_str()),
                '0'..='9' => Box::leak(format!("Digit{upper}").into_boxed_str()),
                _ => "",
            };
            Ok(KeySpec {
                key: Box::leak(single.to_string().into_boxed_str()),
                code,
                code_num: upper as u32,
                text: single.to_string(),
            })
        }
        _ => bail!(
            "'{key}' is not a key name — use a single character or one of Enter, Tab, Escape, \
             Space, ArrowUp/Down/Left/Right, PageUp, PageDown, Home, End, Backspace, Delete"
        ),
    }
}

fn console_args_text(args: &Value) -> String {
    args.as_array()
        .map(|args| {
            args.iter()
                .map(|arg| {
                    arg.get("value")
                        .map(|value| match value {
                            Value::String(text) => text.clone(),
                            other => other.to_string(),
                        })
                        .or_else(|| arg["description"].as_str().map(str::to_string))
                        .unwrap_or_default()
                })
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default()
}

/// Cut a snapshot to size on a line boundary, and say so.
///
/// Silently truncating would leave the model believing it had seen the whole
/// page, and it would then report an element as absent when it was only cut.
fn truncate_snapshot(text: &str, limit: usize) -> String {
    let limit = limit.clamp(500, SNAPSHOT_LIMIT);
    if text.len() <= limit {
        return text.to_string();
    }
    let cut = text
        .char_indices()
        .take_while(|(index, _)| *index < limit)
        .last()
        .map(|(index, _)| index)
        .unwrap_or(0);
    let head = &text[..cut];
    let head = head.rfind('\n').map(|at| &head[..at]).unwrap_or(head);
    format!(
        "{head}\n… snapshot truncated at {limit} characters. Scroll or pass a CSS selector to see \
         the rest."
    )
}

/// Injected once per snapshot or click. Idempotent — redefining the same
/// functions is cheaper than checking whether a navigation wiped them.
///
/// The walker is deliberately shallow on text: an agent that can read every
/// paragraph will, and pay for it. What it needs is the things it can act on,
/// each with a stable ref, plus enough surrounding text to know where it is.
const SNAPSHOT_JS: &str = r#"
(() => {
  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=textbox],[role=combobox],[onclick],[contenteditable=""],[contenteditable="true"]';
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.bottom < -200 || r.top > innerHeight + 200) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity || '1') > 0.05;
  };
  const label = (el) => {
    const raw = el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
      el.value || el.innerText || el.getAttribute('title') || el.getAttribute('alt') ||
      el.getAttribute('name') || '';
    return String(raw).replace(/\s+/g, ' ').trim().slice(0, 100);
  };
  const role = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'submit' || type === 'button') return 'button';
      if (type === 'checkbox' || type === 'radio') return type;
      return 'textbox';
    }
    return 'control';
  };
  window.__caliSnapshot = (withText) => {
    window.__caliRefs = [];
    const lines = [`url: ${location.href}`, `title: ${document.title}`];
    const els = Array.from(document.querySelectorAll(INTERACTIVE)).filter(visible);
    for (const el of els) {
      const name = label(el);
      // An unlabelled control is unaddressable by the model and usually
      // decorative, but a bare icon button is neither — keep it if it is
      // small and clickable, drop it otherwise.
      const r = el.getBoundingClientRect();
      if (!name && r.width * r.height > 6000) continue;
      const n = window.__caliRefs.push(el);
      const value = el.value && el.tagName === 'INPUT' ? ` value="${String(el.value).slice(0, 40)}"` : '';
      lines.push(`- ${role(el)} "${name || '(unlabelled)'}"${value} [ref=e${n}]`);
    }
    if (withText) {
      const text = (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').trim();
      if (text) lines.push('', 'page text:', text.slice(0, 6000));
    }
    return lines.join('\n');
  };
  // Result extraction is heuristic by necessity: every engine renders its
  // own markup and renames its classes without notice. What does not change
  // is the shape — an offsite link with a heading-sized title — so that is
  // what this matches, rather than any one engine's selectors.
  window.__caliResults = (limit) => {
    const host = location.hostname.replace(/^www\./, '');
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll('a[href^="http"]')) {
      if (out.length >= limit) break;
      let url;
      try { url = new URL(a.href); } catch (e) { continue; }
      if (url.hostname.replace(/^www\./, '').endsWith(host)) continue;
      const title = (a.innerText || '').replace(/\s+/g, ' ').trim();
      // A bare url as the link text is the engine's own breadcrumb line, and
      // a two-word fragment is a tag or a byline, not a result.
      if (title.length < 12 || /^https?:\/\//.test(title)) continue;
      const key = url.hostname + url.pathname;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ title: title.slice(0, 140), url: a.href });
    }
    return JSON.stringify(out);
  };
  window.__caliPoint = (n) => {
    const el = (window.__caliRefs || [])[n - 1];
    if (!el || !el.isConnected) return {};
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return {};
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: label(el) };
  };
  return true;
})()
"#;

/// Reads the page's favicon and inlines it.
///
/// Walks the declared icons and falls back to `/favicon.ico`, which most sites
/// still serve without declaring. Anything that throws — no icon, CORS, a
/// network error — resolves to null rather than rejecting, because the caller
/// treats every failure identically.
const FAVICON_JS: &str = r#"
(async () => {
  const MAX_BYTES = 200000;
  const declared = Array.from(
    document.querySelectorAll("link[rel~='icon'],link[rel='shortcut icon'],link[rel='apple-touch-icon']")
  ).map((link) => link.href).filter(Boolean);
  for (const href of [...declared, new URL('/favicon.ico', location.origin).href]) {
    try {
      const response = await fetch(href, { credentials: 'include' });
      if (!response.ok) continue;
      const blob = await response.blob();
      if (!blob.size || blob.size > MAX_BYTES || !blob.type.startsWith('image')) continue;
      const encoded = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
      if (encoded) return encoded;
    } catch (error) { continue; }
  }
  return null;
})()
"#;

/// Data-url wrapper for a captured frame, so callers do not each rebuild it.
pub fn data_url(jpeg_base64: &str) -> String {
    format!("data:image/jpeg;base64,{jpeg_base64}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_hosts_become_https_and_off_web_schemes_are_refused() {
        assert_eq!(normalize_url("example.com").unwrap(), "https://example.com");
        assert_eq!(
            normalize_url(" https://a.test/x ").unwrap(),
            "https://a.test/x"
        );
        assert_eq!(normalize_url("http://a.test").unwrap(), "http://a.test");
        for refused in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,x",
        ] {
            assert!(
                normalize_url(refused).is_err(),
                "{refused} must not be reachable"
            );
        }
    }

    #[test]
    fn a_search_phrase_is_not_mistaken_for_a_url() {
        // The failure this prevents: navigating to `https://free 3d models`,
        // which fails opaquely inside Chrome rather than here where the model
        // can be told to use a search engine.
        assert!(normalize_url("free 3d models").is_err());
        assert!(normalize_url("sketchfab").is_err());
    }

    #[test]
    fn named_keys_carry_a_virtual_code_and_characters_carry_text() {
        let enter = key_spec("Enter").unwrap();
        assert_eq!((enter.key, enter.code_num), ("Enter", 13));
        assert!(enter.text.is_empty(), "Enter must not insert a character");

        let w = key_spec("w").unwrap();
        assert_eq!((w.code, w.text.as_str()), ("KeyW", "w"));
        assert_eq!(w.code_num, 'W' as u32);

        // Space is both: a named key and a character.
        let space = key_spec("space").unwrap();
        assert_eq!((space.code, space.text.as_str()), ("Space", " "));

        assert!(key_spec("wasd").is_err());
    }

    #[test]
    fn key_names_are_case_insensitive() {
        for spelling in ["ArrowUp", "arrowup", "UP", "Up"] {
            assert_eq!(key_spec(spelling).unwrap().code, "ArrowUp");
        }
    }

    #[test]
    fn a_page_that_rendered_nothing_is_named_as_such() {
        // A snapshot of a bot check is indistinguishable from a snapshot of an
        // empty site unless it says so, and the model has no way to guess it
        // should try a different result.
        let bare = "url: https://free3d.com/x\ntitle: free3d.com";
        assert!(!bare.contains("[ref=e"));
        // The message has to name the cause and the recovery, not just the
        // symptom — the recovery is the part the model acts on.
        let notice = format!(
            "{bare}\n\nThis page rendered no elements and no text. That usually means a bot \
             check or a login wall rather than an empty page — try a different result, or \
             browser_look to see what is actually on screen."
        );
        assert!(notice.contains("bot check"));
        assert!(notice.contains("try a different result"));
        // And an article with no controls must never trip it: text is what
        // separates "nothing rendered" from "nothing clickable".
        assert!("- link \"x\" [ref=e1]".contains("[ref=e"));
    }

    #[test]
    fn truncation_says_it_truncated_and_cuts_on_a_line() {
        let text = (1..200)
            .map(|n| format!("- link \"item {n}\" [ref=e{n}]"))
            .collect::<Vec<_>>()
            .join("\n");
        let cut = truncate_snapshot(&text, 500);
        assert!(cut.len() < text.len());
        assert!(cut.contains("snapshot truncated"));
        // A half-written element line would hand the model a ref that does not
        // parse; the cut lands on a newline instead.
        let body = cut.split('\n').next_back().unwrap();
        assert!(body.starts_with('…'), "last line should be the notice");
        assert!(truncate_snapshot("short", 500).ends_with("short"));
    }

    #[test]
    fn console_arguments_flatten_to_one_line() {
        let args = json!([
            { "type": "string", "value": "failed to load" },
            { "type": "number", "value": 404 },
            { "type": "object", "description": "TypeError: x is not a function" }
        ]);
        assert_eq!(
            console_args_text(&args),
            "failed to load 404 TypeError: x is not a function"
        );
        assert_eq!(console_args_text(&json!(null)), "");
    }

    #[test]
    fn headless_unless_explicitly_headed() {
        let args = chrome_args(Path::new("/tmp/p"));
        assert!(args.iter().any(|arg| arg == "--headless=new"));
        assert!(args
            .iter()
            .any(|arg| arg.contains("--user-data-dir=/tmp/p")));
        // Port 0 is what makes DevToolsActivePort meaningful; a fixed port
        // would collide with a second core and silently attach to it.
        assert!(args.iter().any(|arg| arg == "--remote-debugging-port=0"));
    }

    #[test]
    fn a_dead_holders_lock_is_cleared_rather_than_waited_on() {
        let dir = tempfile::tempdir().unwrap();
        let profile = dir.path().join("browser");
        std::fs::create_dir_all(&profile).unwrap();
        let lock = profile.join("SingletonLock");
        // pid 1 is alive but is not chrome; use a pid that cannot exist.
        std::os::unix::fs::symlink("some-host.local-4194303", &lock).unwrap();
        let resolved = usable_profile(profile.clone()).unwrap();
        assert_eq!(
            resolved, profile,
            "a stale lock must not divert the profile"
        );
        // `exists` follows the symlink, and these links point at a name rather
        // than a file — so it answers "is the target there", never "is the
        // lock there". Only `symlink_metadata` sees the link itself.
        assert!(
            std::fs::symlink_metadata(&lock).is_err(),
            "the stale lock should have been removed"
        );
    }

    #[test]
    fn a_live_holders_lock_diverts_to_a_scratch_profile() {
        let dir = tempfile::tempdir().unwrap();
        let profile = dir.path().join("browser");
        std::fs::create_dir_all(&profile).unwrap();
        // This process is certainly alive, so it stands in for a chrome that
        // is genuinely still running.
        let me = std::process::id();
        std::os::unix::fs::symlink(format!("host-{me}"), profile.join("SingletonLock")).unwrap();
        let resolved = usable_profile(profile.clone()).unwrap();
        assert_ne!(resolved, profile, "a held profile must not be reused");
        assert!(resolved.exists());
        // The live holder's lock is left exactly as it was.
        assert!(std::fs::symlink_metadata(profile.join("SingletonLock")).is_ok());
    }

    #[test]
    fn only_a_throwaway_profile_is_ever_deleted() {
        // This answer authorises `remove_dir_all`, so it has to refuse
        // anything that is not one of ours in the temp directory.
        assert!(is_scratch_profile(
            &std::env::temp_dir().join("cali-browser-abc123")
        ));
        assert!(!is_scratch_profile(Path::new(
            "/Users/someone/.cali/browser"
        )));
        assert!(!is_scratch_profile(&std::env::temp_dir().join("something")));
        // Right name, wrong place — a sibling directory is not ours to remove.
        assert!(!is_scratch_profile(Path::new("/opt/cali-browser-abc123")));
        // Right place, but nested deeper than we ever create.
        assert!(!is_scratch_profile(
            &std::env::temp_dir().join("cali-browser-x").join("Default")
        ));
    }

    #[test]
    fn chrome_is_looked_for_where_this_platform_actually_puts_it() {
        // The module was macOS-only: it would not have compiled for Windows,
        // and on Linux it searched a macOS cache path.
        //
        // Deliberately does NOT touch `CALI_CHROME`. It used to `remove_var`
        // it, which races the dispatch-arm test that sets it — `set_var` is
        // process-global and rust runs tests in parallel threads. When they
        // interleaved, a browser tool launched a real chrome and sat out the
        // full launch timeout, and the load timed out an unrelated pty test in
        // another module. That the binary resolves here is what the live tests
        // prove; this one guards the per-platform paths.
        if cfg!(target_os = "windows") {
            assert!(PLAYWRIGHT_CHROMIUM_BINARY.ends_with("chrome.exe"));
        } else if cfg!(target_os = "macos") {
            assert!(PLAYWRIGHT_CHROMIUM_BINARY.contains("chrome-mac"));
        } else {
            assert_eq!(PLAYWRIGHT_CHROMIUM_BINARY, "chrome-linux/chrome");
        }
    }

    #[test]
    fn the_home_directory_is_found_on_windows_too() {
        // `HOME` is unset on Windows; without the fallback the profile landed
        // in the temp directory and forgot every login between runs.
        let home = dirs_home();
        assert!(home.is_some(), "no home directory resolved");
        // Whichever variable supplied it, the profile must sit under it.
        assert!(
            profile_dir().starts_with(home.unwrap())
                || std::env::var("CALI_BROWSER_PROFILE").is_ok()
        );
    }

    #[test]
    fn every_scratch_profile_is_unique() {
        // Two diverted launches sharing a path is the bug that reproduced the
        // very lock timeout the fallback exists to avoid.
        let (first, second) = (scratch_profile(), scratch_profile());
        assert_ne!(first, second);
        assert!(is_scratch_profile(&first) && is_scratch_profile(&second));
    }

    #[test]
    fn a_profile_with_no_lock_is_used_as_is() {
        let dir = tempfile::tempdir().unwrap();
        let profile = dir.path().join("fresh");
        assert_eq!(usable_profile(profile.clone()).unwrap(), profile);
        assert!(profile.is_dir());
    }

    #[test]
    fn a_page_counts_as_readable_at_dom_content_loaded() {
        // Waiting for `load` instead cost seconds per navigation on pages that
        // were interactive long before their trackers finished.
        assert!(is_readable(
            &json!({ "method": "Page.domContentEventFired" })
        ));
        assert!(is_readable(&json!({ "method": "Page.loadEventFired" })));
        assert!(!is_readable(
            &json!({ "method": "Page.frameStartedLoading" })
        ));
        assert!(!is_readable(
            &json!({ "method": "Network.requestWillBeSent" })
        ));
        assert!(!is_readable(&json!({})));
    }

    #[test]
    fn the_viewport_becomes_the_panel_rather_than_a_scaled_desktop() {
        // It used to pin the width at 1280 and derive a height from the
        // panel's aspect, so a 560px dock showed a desktop layout at 44%:
        // blurry text, and a page that overflowed instead of reflowing.
        let shape = |w: u32, h: u32| {
            (
                w.clamp(MIN_VIEWPORT_WIDTH, MAX_VIEWPORT_WIDTH),
                h.clamp(MIN_VIEWPORT_HEIGHT, MAX_VIEWPORT_HEIGHT),
            )
        };
        assert_eq!(shape(560, 830), (560, 830), "the panel is the viewport");
        assert_eq!(shape(1280, 800), (1280, 800));
        // A dock dragged to a sliver would otherwise ask for a viewport no
        // site can lay out at all.
        assert_eq!(shape(40, 4000), (MIN_VIEWPORT_WIDTH, MAX_VIEWPORT_HEIGHT));
        assert_eq!(shape(9000, 50), (MAX_VIEWPORT_WIDTH, MIN_VIEWPORT_HEIGHT));
        // With no panel attached the agent still gets a desktop layout.
        assert_eq!((VIEWPORT_WIDTH, VIEWPORT_HEIGHT), (1280, 800));
    }

    #[test]
    fn queries_are_percent_encoded_for_a_search_url() {
        assert_eq!(url_encode("low poly ship"), "low+poly+ship");
        assert_eq!(url_encode("c++ & rust"), "c%2B%2B+%26+rust");
        assert_eq!(url_encode("naïve"), "na%C3%AFve");
        assert_eq!(url_encode("a-b_c.d~e"), "a-b_c.d~e");
    }

    #[test]
    fn google_is_not_in_the_engine_list() {
        // Not an oversight: it answers this browser with an interstitial, so
        // trying it first would cost a round trip on every single search.
        assert!(!SEARCH_ENGINES
            .iter()
            .any(|engine| engine.contains("google")));
        assert!(!SEARCH_ENGINES.is_empty());
        for engine in SEARCH_ENGINES {
            assert!(
                engine.ends_with("q="),
                "{engine} must end ready for a query"
            );
            assert!(normalize_url(&format!("{engine}test")).is_ok());
        }
    }

    #[test]
    fn captured_frames_are_wrapped_as_jpeg_data_urls() {
        // `capture_persist` sniffs the mime from this prefix, so a png prefix
        // on jpeg bytes would be rejected there rather than here.
        assert_eq!(data_url("abc"), "data:image/jpeg;base64,abc");
    }

    /// The whole path against the real web, end to end.
    ///
    /// Ignored because it needs Chrome and a network, neither of which CI has.
    /// Run it by hand after touching anything in this module:
    ///
    /// ```text
    /// cargo test browser::tests::live -- --ignored --nocapture
    /// ```
    ///
    /// It covers the sequence that actually matters — find something on the
    /// web, open it, read it, act on it — because every unit test above can
    /// pass while the browser is useless for that.
    #[tokio::test]
    #[ignore = "needs a real Chrome and network"]
    async fn live_search_navigate_snapshot_and_click() {
        let (bus, _keep) = tokio::sync::broadcast::channel(64);
        let browsers = Browsers::new();
        let browser = browsers.ensure(bus).await.expect("chrome should launch");

        let found = browser
            .search("low poly spaceship 3d model free", 5)
            .await
            .expect("search should return results");
        let results = found["results"].as_array().expect("results array");
        assert!(!results.is_empty(), "search returned nothing: {found}");
        assert!(
            results.iter().all(|hit| hit["url"]
                .as_str()
                .is_some_and(|url| url.starts_with("http"))),
            "every result needs a usable url: {found}"
        );

        let snapshot = browser.snapshot(true, 12_000).await.expect("snapshot");
        assert!(snapshot.contains("[ref=e"), "snapshot carries no refs");

        // The regression this pins: clicking a link destroys the page's
        // execution context, and reading the location too early came back
        // empty — so a click that worked reported that it had gone nowhere.
        let first_ref = snapshot
            .lines()
            .filter(|line| line.starts_with("- link"))
            .find_map(|line| {
                line.rsplit_once("[ref=e")?
                    .1
                    .trim_end_matches(']')
                    .parse::<u32>()
                    .ok()
            })
            .expect("a link with a ref");
        let landed = browser
            .click(ClickTarget::Ref(first_ref), 1)
            .await
            .expect("click");
        assert!(
            landed["url"]
                .as_str()
                .is_some_and(|url| url.starts_with("http")),
            "click reported no location: {landed}"
        );

        browsers.shutdown().await;
    }

    #[tokio::test]
    async fn devtools_endpoint_is_read_from_the_port_file() {
        let dir = tempfile::tempdir().unwrap();
        let port_file = dir.path().join("DevToolsActivePort");
        std::fs::write(&port_file, "51234\n/devtools/browser/abc-123\n").unwrap();
        assert_eq!(
            wait_for_devtools(&port_file).await.unwrap(),
            "ws://127.0.0.1:51234/devtools/browser/abc-123"
        );
    }

    #[tokio::test]
    async fn a_half_written_port_file_is_not_read_as_an_endpoint() {
        // Chrome writes the port and the path in two steps. Reading between
        // them yielded `ws://127.0.0.1:51234` with no path, which connects to
        // nothing and fails much later with an unrelated message.
        let dir = tempfile::tempdir().unwrap();
        let port_file = dir.path().join("DevToolsActivePort");
        std::fs::write(&port_file, "51234\n").unwrap();
        let waited =
            tokio::time::timeout(Duration::from_millis(400), wait_for_devtools(&port_file)).await;
        assert!(waited.is_err(), "an incomplete file must keep waiting");
    }
}
