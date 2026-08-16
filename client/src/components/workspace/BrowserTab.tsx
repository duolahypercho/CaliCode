import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, Loader2, RotateCw, Search } from "lucide-react";
import { connectEvents, rpc, type AgentEvent } from "../../lib/rpc";
import { electronBridge } from "../../lib/desktop";

interface Status {
  running: boolean;
  url?: string | null;
  title?: string | null;
  viewport?: { width: number; height: number };
}

/**
 * Core's viewport until it reports its own; the frame's coordinate space.
 *
 * Once this panel is mounted, core is told to make the emulated viewport the
 * panel's own CSS size. That is what keeps the page sharp — it renders 1:1
 * with the pixels showing it rather than being a 1280px layout squeezed to
 * 44% — and what makes it reflow to the dock instead of overflowing it.
 */
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

const STATUS_POLL_MS = 2000;

/**
 * Floor between forwarded mouse moves, in milliseconds.
 *
 * ~30/s. A pointer emits moves far faster than a page repaints, and each one
 * costs a round trip; this is dense enough that hover feels continuous and
 * sparse enough that dragging does not flood the channel the frames come back
 * on.
 */
const MOVE_INTERVAL_MS = 33;

/**
 * Quiet period after the last streamed frame before asking for a sharp one.
 *
 * Streamed frames are capped well below retina resolution, because sending
 * motion at full resolution costs megabytes a second to make moving pixels
 * marginally crisper. The page you actually read is the one that has stopped,
 * so when the stream goes quiet the panel fetches a full-resolution capture to
 * replace the last soft motion frame.
 *
 * Measured: the capture itself takes ~45ms, so this delay is essentially the
 * whole wait. At 400ms a scroll ended in nearly half a second of visible blur
 * before snapping sharp, which reads as the browser catching up with you.
 * Firing early during a slow scroll costs one wasted capture that the next
 * motion frame immediately overwrites — far cheaper than the wait.
 */
const SHARPEN_AFTER_IDLE_MS = 180;

const CONTROL =
  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink-strong active:bg-surface-3 disabled:opacity-35";

/**
 * The browser the agent is driving, live.
 *
 * There is exactly one browser and this is a window onto it, not a second one:
 * the same Chrome that `browser_*` tool calls act on renders here, so the user
 * watches the agent work and can take the wheel mid-task without handing
 * anything over. That is the whole reason it is a tab rather than a headless
 * process nobody can see.
 *
 * Frames arrive as JPEGs on the event bus and are painted into an `<img>`;
 * clicks and keystrokes go back the other way as devtools input events. The
 * frame is a picture, so nothing in it is focusable or selectable — the price
 * of showing a real browser inside a webview that cannot host one.
 */
export function BrowserTab() {
  const [status, setStatus] = useState<Status>({ running: false });
  /**
   * Whether any frame has arrived — not the frame itself.
   *
   * Frames are painted straight onto the `<img>` through a ref. Holding a
   * ~180 KB base64 string in state meant a full React render per frame at up
   * to 40 frames a second during a scroll, for a subtree whose only change is
   * one attribute. This keeps React out of the hot path and leaves it doing
   * what it is good at: swapping the placeholder for the image, once.
   */
  const [painted, setPainted] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  // Read by the status poll, which must not re-subscribe every time a frame
  // lands just to know whether one has.
  const frameRef = useRef<string | null>(null);
  /** Consecutive polls that found a running browser and no frame. */
  const starvedRef = useRef(0);
  const lastMoveRef = useRef(0);
  const viewport = status.viewport ?? DEFAULT_VIEWPORT;
  // The address bar is uncontrolled while focused: overwriting what the user
  // is halfway through typing every time a frame lands makes it unusable.
  const editingRef = useRef(false);

  /** Show a frame. Cheap enough to call at video rate. */
  const paint = useCallback((data: string) => {
    frameRef.current = data;
    if (imageRef.current) imageRef.current.src = `data:image/jpeg;base64,${data}`;
    setPainted(true);
  }, []);

  /**
   * In the Electron shell the panel is a real `WebContentsView` the shell
   * positions over this element, so there is nothing to stream and nothing to
   * paint — this component becomes a placeholder that reports where the view
   * should sit. Everything else here (address bar, status, history) still
   * applies, because the view is driven through the same core RPCs.
   */
  const native = electronBridge();

  useEffect(() => {
    if (!native) return;
    const surface = surfaceRef.current;
    if (!surface || typeof ResizeObserver === "undefined") return;
    const report = (visible: boolean) => {
      const box = surface.getBoundingClientRect();
      // Client coordinates are the window's content area for a full-bleed
      // renderer, which is what the shell's `setBounds` expects. A native
      // titlebar inset or a second native view would break that assumption.
      native.setPanelBounds({
        x: box.left,
        y: box.top,
        width: box.width,
        height: box.height,
        visible,
      });
    };
    // A native view floats above the DOM and has its own z-order, so every
    // portalled overlay in the app — the tab strip's dropdown, the settings
    // dialog, the session search, the model picker — would render *behind* it.
    // Radix portals all of them to `document.body`, so watching for one
    // appearing is what keeps a menu from opening underneath the browser.
    const overlayOpen = () =>
      document.querySelector(
        '[data-radix-popper-content-wrapper], [role="dialog"], [role="menu"], [role="listbox"]',
      ) !== null;
    const sync = () => report(!overlayOpen());

    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(surface);
    // The panel also moves when the window resizes or the dock scrolls, and
    // neither resizes this element.
    window.addEventListener("resize", sync);
    // Overlays arrive and leave as body children rather than as anything this
    // component renders, so a mutation watch is the only signal available.
    const overlays = new MutationObserver(sync);
    overlays.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      overlays.disconnect();
      window.removeEventListener("resize", sync);
      // Hide, never destroy: the agent keeps browsing with the tab closed, and
      // a native view left visible would float over whatever replaces it.
      report(false);
    };
  }, [native]);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      rpc<Status>("browser_status")
        .then((next) => {
          if (cancelled) return;
          setStatus(next);
          if (!editingRef.current && next.url) setAddress(next.url);
          // Self-healing. Chrome pushes a frame only when the page repaints,
          // so any moment the screencast is interrupted — the browser
          // relaunching, a popup being adopted, a core that predates the frame
          // being returned on cast start — leaves this panel holding a
          // placeholder over a perfectly live page, forever. Asking for one
          // costs a capture and ends the stall.
          //
          // Only after a second consecutive empty poll: the first one races
          // the cast-start reply that is already bringing a frame, and acting
          // on it spent a capture on every single mount.
          starvedRef.current = next.running && !frameRef.current ? starvedRef.current + 1 : 0;
          if (starvedRef.current > 1) {
            rpc<{ frame?: { data?: string } | null }>("browser_frame")
              .then((caught) => {
                if (!cancelled && typeof caught?.frame?.data === "string") {
                  paint(caught.frame.data);
                }
              })
              .catch(() => undefined);
          }
        })
        .catch(() => undefined);
    };
    poll();
    const timer = window.setInterval(poll, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // Casting is scoped to this tab being mounted. Frames share the SSE bus with
  // agent tokens, so a screencast left running behind a closed tab is the
  // loudest thing on it for nobody's benefit.
  useEffect(() => {
    if (native) return;
    let live = true;
    // Device pixels, so the frame arrives at exactly the resolution this panel
    // paints and is neither upscaled (blurry) nor oversized (measured: a fixed
    // 1024px cast pushed 1.14 MB/s of base64 through the event stream).
    const box = surfaceRef.current?.getBoundingClientRect();
    const width = box?.width
      ? Math.round(box.width * Math.min(window.devicePixelRatio || 1, 2))
      : undefined;
    rpc<{ frame?: { data?: string } | null }>("browser_cast_start", width ? { width } : {})
      .then((started) => {
        // Paint the page as it stands right now. Chrome sends a frame only on
        // repaint, so without this a panel returning to a still page sits
        // blank — which read as the browser having reset itself.
        if (live && typeof started?.frame?.data === "string") paint(started.frame.data);
      })
      .catch(() => undefined);
    let sharpen = 0;
    const disconnect = connectEvents((event: AgentEvent & { data?: string; text?: string }) => {
      if (!live) return;
      if (event.type === "browser.frame" && typeof event.data === "string") {
        paint(event.data);
        // Each frame pushes the sharpen back; it fires only once the page has
        // actually stopped moving.
        window.clearTimeout(sharpen);
        sharpen = window.setTimeout(() => {
          rpc<{ frame?: { data?: string } | null }>("browser_frame")
            .then((still) => {
              if (live && typeof still?.frame?.data === "string") paint(still.frame.data);
            })
            .catch(() => undefined);
        }, SHARPEN_AFTER_IDLE_MS);
      }
      if (event.type === "browser.error" && typeof event.text === "string") {
        setError(event.text);
      }
    });
    return () => {
      live = false;
      window.clearTimeout(sharpen);
      disconnect();
      rpc("browser_cast_stop").catch(() => undefined);
    };
  }, []);

  // Keep the emulated viewport equal to this panel. Pinning it at a desktop
  // 1280 and scaling down was what made pages look blurry — a 1280px layout at
  // 44% — and what stopped them reflowing, so a wide page overflowed instead
  // of adapting to the dock.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || typeof ResizeObserver === "undefined") return;
    let timer = 0;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box || box.width < 1 || box.height < 1) return;
      // Debounced: a drag of the dock divider fires this on every frame, and
      // each call restarts the screencast.
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        // CSS pixels, deliberately: the emulated viewport is a layout size, so
        // the page reflows to exactly this panel. The screencast is sized
        // separately, in device pixels, so the frame arrives at the resolution
        // the panel paints.
        rpc<{ width?: number; height?: number }>("browser_viewport", {
          width: Math.round(box.width),
          height: Math.round(box.height),
        })
          .then((shape) => {
            // Adopt the shape core actually applied, immediately.
            //
            // Clicks are mapped through this number. Waiting for the next
            // status poll left it up to two seconds stale after every resize,
            // and core clamps the values besides — so during that window every
            // click was mapped through the *previous* viewport and landed
            // somewhere the user did not point at. That reads as "clicking
            // does nothing", which is precisely what it did.
            if (typeof shape?.width === "number" && typeof shape?.height === "number") {
              setStatus((prev) => ({ ...prev, viewport: { width: shape.width!, height: shape.height! } }));
            }
          })
          .catch(() => undefined);
      }, 250);
    });
    observer.observe(surface);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  const run = useCallback(async (method: string, params: Record<string, unknown> = {}) => {
    setBusy(true);
    setError(null);
    try {
      await rpc(method, params);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }, []);

  const go = useCallback(
    async (raw: string) => {
      const value = raw.trim();
      if (!value) return;
      editingRef.current = false;
      // A query rather than an address goes to the same search the agent uses,
      // so the two halves of one browser cannot disagree about what a bare
      // phrase in the address bar means.
      const looksLikeUrl = /^https?:\/\//i.test(value) || (/\./.test(value) && !/\s/.test(value));
      await run(looksLikeUrl ? "browser_navigate" : "browser_search", looksLikeUrl ? { url: value } : { query: value });
    },
    [run],
  );

  /** Frame coordinates from a pointer event, in core's viewport space. */
  const pointAt = (event: React.MouseEvent): { x: number; y: number } | null => {
    const image = surfaceRef.current?.querySelector("img");
    if (!image) return null;
    const box = image.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return null;
    // Map against the *painted* image, not the element box.
    //
    // `object-contain` fits the frame inside the element and letterboxes the
    // remainder, so the two are the same rectangle only while the panel and
    // the viewport share an aspect. Any moment they do not — the beat after a
    // resize, before a reshaped frame lands — every click was offset by the
    // letterbox and landed somewhere the user did not point at. It reads as
    // "clicking does nothing", because it lands on empty page.
    const natural = { w: image.naturalWidth || box.width, h: image.naturalHeight || box.height };
    const scale = Math.min(box.width / natural.w, box.height / natural.h);
    const painted = { w: natural.w * scale, h: natural.h * scale };
    // `object-top` pins the frame to the top and centres it horizontally.
    const left = box.left + (box.width - painted.w) / 2;
    const top = box.top;
    // Guard on the *fraction*, never on viewport pixels. Whether a point is
    // inside the painted frame is a fact about this element and needs no
    // knowledge of core's viewport — and the cached viewport can be stale for
    // a moment after a resize. Testing pixels against a stale number rejected
    // perfectly good clicks, which is how a bounds check meant to ignore the
    // letterbox ended up swallowing every click in a widened panel.
    const fx = (event.clientX - left) / painted.w;
    const fy = (event.clientY - top) / painted.h;
    if (fx < 0 || fy < 0 || fx > 1 || fy > 1) return null;
    return { x: fx * viewport.width, y: fy * viewport.height };
  };

  const forwardClick = (event: React.MouseEvent) => {
    // Focus first, unconditionally. Keystrokes are forwarded from this
    // element's own key handler, so it has to hold focus — and a click that
    // maps to nowhere still means "I am working in this panel now". Taking
    // focus only on a successful hit meant one bad click also cost the user
    // their keyboard.
    surfaceRef.current?.focus({ preventScroll: true });
    const point = pointAt(event);
    if (!point) return;
    // Down and up as two calls rather than one synthetic click: a page that
    // opens a menu on mousedown and commits on mouseup needs both edges.
    rpc("browser_input", { kind: "down", ...point, clickCount: event.detail || 1 })
      .then(() => rpc("browser_input", { kind: "up", ...point, clickCount: event.detail || 1 }))
      .catch(() => undefined);
  };

  /**
   * Hover is most of what makes a page feel alive: links underline, buttons
   * light up, menus open, the cursor changes shape. None of that happened,
   * because only clicks and keys were forwarded — so the panel reacted to
   * nothing until it was clicked, and read as a picture of a browser rather
   * than one.
   *
   * Throttled rather than sent per event: a mouse produces far more moves than
   * a page can repaint, and each one here is a round trip.
   */
  const forwardMove = (event: React.MouseEvent) => {
    const now = Date.now();
    if (now - lastMoveRef.current < MOVE_INTERVAL_MS) return;
    lastMoveRef.current = now;
    const point = pointAt(event);
    if (!point) return;
    // The reply carries the cursor the page would show here, so the panel's
    // own pointer changes shape over links. Without it the arrow never moved,
    // which reads constantly as "this is a picture, not a page".
    rpc<{ cursor?: string }>("browser_input", { kind: "move", ...point })
      .then((reply) => {
        const surface = surfaceRef.current;
        if (surface && typeof reply?.cursor === "string") surface.style.cursor = reply.cursor;
      })
      .catch(() => undefined);
  };

  const forwardWheel = (event: React.WheelEvent) => {
    const point = pointAt(event);
    if (!point) return;
    rpc("browser_input", { kind: "wheel", ...point, deltaX: event.deltaX, deltaY: event.deltaY }).catch(
      () => undefined,
    );
  };

  const forwardKey = (event: React.KeyboardEvent) => {
    // Browser-level shortcuts stay with the editor: swallowing Cmd-R here
    // would reload the page the user is *watching* rather than the one they
    // meant, and Cmd-C has no meaning against a picture of a page.
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    const single = event.key.length === 1;
    rpc("browser_input", single ? { kind: "text", text: event.key } : { kind: "key", key: event.key }).catch(
      () => undefined,
    );
  };

  return (
    // No id or role here: App wraps every view in the tabpanel that the tab
    // strip's aria-controls points at, and repeating them nested a second
    // tabpanel inside the first under a duplicate id.
    <div className="flex h-full flex-col bg-surface-0">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-1.5">
        <button
          type="button"
          className={CONTROL}
          aria-label="Back"
          disabled={!status.running}
          onClick={() => run("browser_history", { delta: -1 })}
        >
          <ArrowLeft size={15} strokeWidth={1.7} />
        </button>
        <button
          type="button"
          className={CONTROL}
          aria-label="Forward"
          disabled={!status.running}
          onClick={() => run("browser_history", { delta: 1 })}
        >
          <ArrowRight size={15} strokeWidth={1.7} />
        </button>
        <button
          type="button"
          className={CONTROL}
          aria-label="Reload"
          disabled={!status.running}
          onClick={() => run("browser_reload")}
        >
          {busy ? (
            <Loader2 size={15} strokeWidth={1.7} className="animate-spin" />
          ) : (
            <RotateCw size={15} strokeWidth={1.7} />
          )}
        </button>
        <button
          type="button"
          className={CONTROL}
          aria-label="Open in your browser"
          title="Open this page in your own browser"
          disabled={!status.url}
          // This panel is a shared view of the agent's browser, not a
          // replacement for yours: it cannot select text or open devtools, and
          // it never will. When the task stops being "watch the agent" and
          // starts being "actually read this", the real browser is one click
          // away and lands on the same page.
          onClick={() => {
            if (status.url) window.open(status.url, "_blank", "noopener");
          }}
        >
          <ExternalLink size={15} strokeWidth={1.7} />
        </button>
        <form
          className="flex min-w-0 flex-1 items-center"
          onSubmit={(event) => {
            event.preventDefault();
            void go(address);
          }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md bg-surface-1 px-2 py-1">
            <Search size={13} strokeWidth={1.7} className="shrink-0 text-ink-faint" />
            <input
              aria-label="Address or search"
              className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-faint"
              placeholder="Search the web, or type a URL"
              value={address}
              onFocus={() => {
                editingRef.current = true;
              }}
              onBlur={() => {
                editingRef.current = false;
              }}
              onChange={(event) => setAddress(event.target.value)}
            />
          </div>
        </form>
      </div>

      {error ? (
        <div className="shrink-0 border-b border-line bg-danger-soft px-3 py-1.5 text-[12px] text-ink">{error}</div>
      ) : null}

      <div
        ref={surfaceRef}
        className="relative min-h-0 flex-1 overflow-hidden bg-surface-1"
        onClick={forwardClick}
        onMouseMove={forwardMove}
        onWheel={forwardWheel}
        onKeyDown={forwardKey}
        // The surface is a picture, so it is not focusable on its own. Without
        // this the tab could never receive a keystroke to forward.
        tabIndex={0}
        role="application"
        aria-label="Browser view"
      >
        {/* Always mounted so `paint` has a node to write to; hidden until the
            first frame lands, which is what `painted` tracks. */}
        <img
          ref={imageRef}
          alt={status.title ? `Browser showing ${status.title}` : "Browser view"}
          // `contain`, never `cover`. The viewport is reshaped to this panel's
          // aspect so the two normally match exactly and the choice is
          // invisible — but they drift every time the panel is resized, during
          // the beat before a reshaped frame arrives, and whenever a capture
          // and the live cast disagree. `cover` resolves that drift by
          // cropping, which silently hides part of the page and looks like the
          // browser is zoomed in. `contain` letterboxes instead, and never
          // hides anything.
          className={`h-full w-full object-contain object-top ${painted ? "" : "hidden"}`}
          draggable={false}
        />
        {painted ? null : (
          <div className="flex h-full items-center justify-center px-8 text-center">
            <p className="max-w-sm text-[12px] leading-relaxed text-ink-faint">
              {status.running
                ? // Core replays the last frame the moment a cast starts, so
                  // this is a brief gap on a live page, not an empty browser —
                  // saying "nothing open" here made switching tabs and back
                  // look like the browser had reset itself.
                  `Reconnecting to ${status.title || status.url || "the open page"}…`
                : "Nothing open yet. Search or enter a URL above — the agent shares this browser, so whatever it opens with browser_navigate shows up here too."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
