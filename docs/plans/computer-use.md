# Computer use

Status: **shipped, deliberately partial.** `computer_targets`, `computer_doctor`,
`computer_look`, `computer_type`, `computer_key` are live and verified. `computer_click` and
`computer_scroll` are built, measured, and **withheld** — see §4.1b.

**Scope decision (2026-08-15): the current target is three.js and WebGPU only.** Unity, Godot
and Unreal are future work. That is what makes the withheld click a non-issue rather than a
gap: web games run in the agent browser, and `browser_click` already takes raw viewport
coordinates to reach a `<canvas>` — over CDP, which works. Computer use is staged for the day a
native engine target exists, and the click question should be reopened then, not before.
Recommendation: **§4 — built-in `computer_*` tools in `tools.rs`, over our own capture and
input built on public macOS API.** Codex-style from the user's side: zero install, zero
config, tools always present — and no third-party driver, because every part we need turned
out to be public API. Targets are game engines (§4.1a), which makes capture the feature and
input the smaller half.

---

## 0. The decision in one paragraph

CaliCode already has more computer use than it looks: `browser.rs` drives a real Chrome over
CDP, and `browser_click` takes raw viewport coordinates specifically so the agent can reach a
`<canvas>`, which is how it plays a running three.js game. **That already covers the web
half — three.js and WebGPU need nothing new.** The gap is native windows, and the decided
roadmap says which ones: Unity, Godot and Unreal, later.

That target set determines the whole design. Engine editors are custom-drawn and running
builds are a single GPU surface, so there is no useful accessibility tree to read — **pixels
and coordinates are the primary interface, not the fallback** (§4.1a). And since the editors
are all scriptable anyway, what computer use uniquely adds is not a hand but an eye: the
answer to *does it look right*, which is the question `baselines.rs`, `capture_persist` and
`video_analysis` already exist to ask.

Build it ourselves. ScreenCaptureKit, `AXUIElement` and `CGEventPostToPid` are all public API
with Rust crates on crates.io (§4.1); adopting `cua-driver` would mean re-signing a
third-party macOS app bundle inside ours and adding Swift, for ten actions where it ships 49.
Ship it **built-in**, the way Codex does: `computer_*` tools in `tools.rs` beside `browser_*`,
present with no install and no config.

The policy layer is the part that is already built and green: the spawn ledger, attach
scoping, `approvals.rs`, and a COMPUTER tab to watch it. That is what makes an unattended
`/loop` defensible, and it is deliberately what exists first.

---

## 1. TCC spike: what was measured

The question was: do macOS Screen Recording and Accessibility grants attribute to
`CaliCode.app`, or to the `cali-core` sidecar binary? Everything downstream depends on it.

### 1.1 Signing (verified)

```
CaliCode.app   Identifier=com.calicode.desktop   Authority=CaliCode Dev   TeamIdentifier=not set
cali-core      Identifier=cali-core              Authority=CaliCode Dev   Info.plist=not bound
```

The sidecar lives at `Contents/MacOS/cali-core`, signed separately, under its own identifier,
with no embedded `Info.plist`.

### 1.2 Responsibility inheritance (verified empirically)

A throwaway Swift probe calling `CGPreflightScreenCaptureAccess()` and `AXIsProcessTrusted()`
was compiled and run as a child of this shell. Both returned `true`.

That probe is an unbundled, freshly-signed binary that has never appeared in System Settings.
It did not prompt, and it was not enrolled as its own TCC subject — it **inherited the
terminal's grants**. This is the responsible-process mechanism working as documented: TCC
attributes a non-bundled child to its responsible ancestor, not to itself.

**Consequence, and it is the good outcome:** `cali-core` spawned by `CaliCode.app` should
attribute to `com.calicode.desktop`, so the user grants once, to CaliCode, in System Settings,
and the sidecar inherits it. No sidecar `Info.plist` is needed. Screen Recording and
Accessibility are system-managed prompts with no usage-string requirement, so the existing
three-key `Info.plist` needs no additions for them.

### 1.3 The one thing still unverified

Whether attribution actually lands on `com.calicode.desktop` rather than on `launchd` for the
*bundled* case was not proven, because proving it requires the app to spawn the probe — a
five-line temporary patch, which is out of scope for a plan-only pass. The prior is strong
(§1.2 shows the mechanism working) but it is a prior, not a measurement. **Do this first when
implementation starts; it is an hour and it de-risks everything after it.**

### 1.4 Two real findings that came out of the spike

**`dev.sh` and the packaged app will behave differently, permanently.** Under `dev.sh`,
`cali-core` is a child of the user's terminal, so it inherits *the terminal's* grants (which,
on this machine, are already both `true` — that is why the probe passed). Under the packaged
app it inherits CaliCode's. So a developer can have working computer use in dev and a
first-run prompt in the bundle, or vice versa. This must be surfaced, not discovered: a
`computer_doctor`-style preflight that reports which subject actually holds the grant.

**`signingIdentity: "CaliCode Dev"` with `TeamIdentifier=not set` is a latent grant-loss
bug.** TCC keys grants to the designated requirement. A stable self-signed cert holds across
rebuilds; regenerating or losing that cert silently invalidates every grant the user made, and
the failure mode is "computer use just stopped working" with no message. Before shipping this
to anyone else, that identity needs to be stable and documented — and for real distribution,
properly signed and notarized.

---

## 2. How the field ships this (surveyed 2026-08-14)

The user's question was *"is that in plugin or tools etc"*. The answer differs per product,
and the split is informative:

| Product | Delivery | Scope | Notes |
| --- | --- | --- | --- |
| **Claude Code** | **Built-in tool**, Desktop app only | User's real desktop | Research preview, macOS, Pro/Max, v2.1.85+, interactive sessions only. Not in the CLI. |
| **OpenAI Codex** | **Built-in**, Codex app | User's real desktop, background agents | macOS Apr 2026, Windows 11 May 2026. Phone-based approve/steer via ChatGPT mobile. |
| **Hermes (Nous)** | **Toolset → MCP over stdio → `cua-driver`** | User's real desktop, background | Model-agnostic by design; text-only models degrade to AX-tree mode. |
| **opencode** | **Nothing built-in** | — | Issue #20490 (Apr 2026) open, assigned, **no maintainer decision**. Users bolt on third-party MCP servers. |
| **Anthropic API** | `computer_20251124` tool type | A sandboxed VM/container you provide | Reference impl is Docker + Xvfb + Mutter. Docs are emphatic: use a dedicated VM. |

Two things to take from this table.

**First: nobody who ships this as a product makes the user configure it.** Claude Code, Codex
and Hermes all put approvals, scoping and the viewing surface in their own harness, and all
three present computer use as a capability of the app rather than a server the user wires up.
opencode is the one that has not shipped it — and it is also the one whose users are bolting on
third-party MCP servers by hand. That contrast is the argument for §4: built-in is the product,
and it is orthogonal to who wrote the driver. Hermes proves the driver underneath can be
someone else's code without giving up any of the policy that matters.

**Second: Anthropic's own guidance and every shipping product disagree, and both are right.**
The API docs say *use a dedicated VM* because the API's threat model is a model driving an
untrusted internet with no supervisor. The products all drive the real desktop because that is
where the user's actual work is. CaliCode sits closer to the products — the whole point is
verifying a build the user cares about — but it inherits the API's risk, because a `/loop`
runs unattended for hours. §5 is about resolving that, and it is the part of this plan that
matters most.

---

## 3. Corrections, in order

Recorded because each one moved the design.

**(a) "Background input needs a private SPI."** Wrong, and it was the load-bearing argument for
adopting a driver. `CGEventPostToPid` is public and posts to a target process without
activating it or moving the real cursor. `SLPSPostEventRecordTo` (private SkyLight, what
Hermes/cua use) is *more robust* — background dialogs in particular — but it is not the price
of entry. Superseded by §4.1.

**(b) "cua-driver is a Rust workspace we can link."** Only on Windows and Linux. The
production macOS driver is Swift, and upstream says the Rust port is not at macOS parity.

**(c) "There is an embedded-host mode for apps holding TCC grants."** Misread. The design
requires a signed `CuaDriver.app` bundle, because grants persist only against a bundle
identity.

**(d) "Core already has a spawn ledger."** It did not — spawns were scattered across five
modules with no central record. Built as `spawn_ledger.rs`; see §4.2.1.

**(e) "AX tree first, screenshots second," mirroring `browser_snapshot`.** Right for web,
backwards for game engines, which are custom-drawn. Inverted in §4.1a.

The one thing that survived every revision: the AX tree *is* the right shape wherever an app
exposes one, and coordinates are the honest fallback where it does not — which is exactly what
`browser_click` already does for `<canvas>`.

---

## 4. Recommended design

**Built-in `computer_*` tools in `tools.rs`, backed by an embedded `cua-driver-rs`.**

### 4.0 Separating two things that are easy to conflate

"Built-in like Codex" is really two independent properties:

1. **User-facing**: nothing to install, nothing to configure, the tools are simply there.
   This is what makes Codex *feel* built-in, and it is the property actually worth having.
2. **Implementation**: we write the screen-capture and background-input stack ourselves.

Codex has both. CaliCode should take (1) and decline (2). Declining (2) is not a compromise —
the macOS background-input path rides `SLPSPostEventRecordTo`, a private SkyLight SPI that
moves between OS releases (§3). Owning that is a permanent tax for zero product differentiation.

An earlier draft of this plan proposed shipping it as a **user-configured MCP server**. That is
now rejected: it fails property (1). It would put computer use behind a `~/.cali/config.yaml`
edit, name the tools `mcp__cua__click` instead of `computer_click`, and route them through the
untrusted-server permission path rather than the normal one. Config-gating the feature is the
opposite of built-in.

### 4.1 Build our own — decided 2026-08-15

**Reversing the earlier recommendation to adopt `cua-driver`.** Two things changed it.

**The private-SPI argument was overstated.** An earlier draft called
`SLPSPostEventRecordTo` the price of entry for background input and said owning that was a
permanent tax. It is not. **`CGEventPostToPid` is public API** and delivers events straight to
a target process without activating it and without moving the real cursor — the whole
no-cursor-steal property, on a supported call. The private SkyLight path buys *more
robustness*, notably background app dialogs where the public call does not land. That is a real
difference, and for a narrow target set it is an acceptable one.

Every part we need is public API with a Rust crate already on crates.io:

| Part | API | Crate |
| --- | --- | --- |
| Window capture, incl. occluded | ScreenCaptureKit (macOS 12.3+) | `screencapturekit`, `objc2-screen-capture-kit` |
| Element tree | `AXUIElement` | `accessibility-sys` / objc2 |
| Background input | `CGEventPostToPid` | `core-graphics` |

Against that, adopting means redistributing and **re-signing a third-party macOS `.app`** inside
ours, tracking a 4,000-commit upstream, and adding **Swift** to a Rust + TypeScript repo —
because the Rust port is not at macOS parity (§4.1 caveats, still true). For roughly ten
actions, where cua ships 49. Not worth it.

Consequence: §1.3 stops being the blocking measurement. Our own capture and input live inside
`cali-core`, which is spawned by the app and inherits its grants (§1.2) — there is no second
bundle to keep signed, so C′ and C″ both dissolve.

### 4.1a The targets are game engines, and that inverts the design

Decided use: three.js / WebGPU on the web now; **Unity, Godot and Unreal later**. That is the
roadmap, not a bet, and it settles two things the earlier draft got wrong.

**AX is not the primary interface here.** Unity's editor is IMGUI, Unreal's is Slate, Godot
draws its own UI — all three are custom-drawn, which is precisely the sparse-or-empty
accessibility-tree case. A *running* engine build is worse still: one GPU surface, no tree at
all. So the `browser_snapshot`-style "text first, image second" ordering inverts. **Pixels and
coordinates are primary; AX is an opportunistic bonus where an app happens to expose one.**
This is structurally the same problem `browser_click` already solves for `<canvas>`, and it
removes the most tedious component — AX tree walking — from the critical path.

**Computer use here is primarily an eye, secondarily a hand.** Engine editors are all
scriptable (Unity C# batch mode, Godot headless CLI, Unreal Python and commandlets), and
scripting beats pixels for *driving* them. What scripting cannot do is answer "does it look
right", which is the question this repo is already built around — `baselines.rs`,
`capture_persist`, `video_analysis`, `image3d`. Capture is the feature; input is the smaller
half.

**Open risk, and it is the sharpest one: raw input.** Unity's Input System and Unreal's raw
input read HID directly, and neither `CGEventPostToPid` nor the private SkyLight path is
guaranteed to reach them. Editors are AppKit-hosted and should be fine; *running builds* may
not be. This needs a per-engine spike before anyone promises the agent can play a native build,
and it does not affect capture at all — which is another reason to land the eye first.

**Web games need none of this.** three.js and WebGPU run in the agent browser and are already
reachable by coordinate clicks on `<canvas>`. No computer use required, today or later.

### 4.1b Measured: keyboard reaches a background window, mouse does not

The one result that changes the plan, and it was measured rather than reasoned about.
Real Chrome, macOS 26.4, core-spawned so it is in the ledger, verified through CDP so the
evidence comes back on a different channel than the input went in on:

| Input | `CGEventPostToPid` to a background window | Evidence |
| --- | --- | --- |
| **Keyboard** (`computer_type`, `computer_key`) | **arrives, even to a window that is never key** | CDP reads the typed value back; the AppKit control logs `keyDown` |
| **Mouse — click** | **does not arrive** | page click handler never fires; CDP reads `0` |
| **Mouse — scroll** | **does not arrive** | 5000px page, scroll posted, `window.scrollY` stays `0` |

The split is not arbitrary and it is worth stating as a rule rather than two results: **keyboard
events route to the focused responder and need no hit-test; mouse events carry a location and
need one, and an application that is not under the pointer cannot perform it.** Anything
location-bearing is therefore expected to fail by the same mechanism, and testing each new one
before exposing it is cheaper than discovering it in use.

**Four delivery routes were then tried, against two different kinds of target.** An earlier
version of this section generalised from Chrome alone, which was a mistake — Chromium runs a
renderer-side trust filter that rejects synthetic clicks outright, so it is the documented
*hardest* case and the worst thing to conclude from. The control is a plain AppKit window that
never becomes key, writing to a file on `mouseDown`:

| Route | Chrome | plain AppKit window |
| --- | --- | --- |
| `CGEventPostToPid` | no | no |
| `CGEventPostToPSN` (Carbon addressing) | no | no |
| `SLEventPostToPid` (SkyLight private SPI, `dlsym`) | no | no |
| keyboard, any route | **yes** | — |

The decisive run puts all four routes and the keyboard control **in one process, one non-key
window, one measurement**:

```
target pid=20427 window=15803 bounds=(60,507,420,352)
after PID:      posted=true events=[]
after PSN:      posted=true events=[]
after SKYLIGHT: posted=true events=[]
after KEYBOARD: events=["keyDown:k"]
```

That single line of keyboard output is what makes the empty ones mean something. It rules out
four confounds at once: the target is alive and its logging works; it is not Chromium's trust
filter, because this is plain AppKit; it is not `acceptsFirstMouse` defaulting to false, because
the control overrides it to true; and it is not "the window simply was not key", because the
window is never key and the keystroke still arrived.

Two earlier claims in this document were repaired by that control. The first diagnostic built
its three posts inside an array literal, so all three fired before any sleep ran and the
per-route attribution was meaningless. The second counted log *lines* including the target's
own `ready` marker, so zero clicks read as one. Both are why the run above prints the events
rather than a count.

So it is genuinely background mouse delivery, not one hostile application. And **the private SPI
alone is not the answer either** — the symbol resolves and the call returns, and nothing
arrives. Per cua's own write-up the working recipe is three stages, not one call: two
`SLPSPostEventRecordTo` records to flip AppKit-active state without raising, a primer
`LeftMouseDown`/`Up` at `(-1, -1)` to tick the user-activation gate, and only then the real
click — with a `mouseEventSubtype` byte and window-local coordinate stamp whose values that
write-up does not publish.

**All three implementable stages were then built and measured, and they still do not deliver.**

| Stage attempted | Mouse arrives? |
| --- | --- |
| `CGEventPostToPid` — bare, then `+CLICK_STATE`, then `+WINDOW_UNDER_MOUSE_POINTER` ×2 | no |
| `CGEventPostToPSN` (Carbon addressing) | no |
| `SLEventPostToPid` (SkyLight private SPI, `dlsym`) | no |
| `+ SLPSPostEventRecordTo` activation record (yabai's `make_key_window` layout) | no |
| `+ primer click at (-1,-1)` | no |
| keyboard, throughout | **yes** |

The activation record and the primer click are stages 1 and 2 of the published recipe, and both
were implemented from the open-source layout. What remains is the part cua describes but does
not publish: the `mouseEventSubtype` byte and the window-local coordinate stamp that mark an
event as a trusted user gesture. Without those values the record is incomplete, and no amount of
addressing fixes it.

That is the end of what can be reached by inference. It is a reverse-engineering project against
undocumented byte layouts, not an afternoon. It
is the honest reason to reconsider **adopting cua for the input path only** while keeping our
own capture: they have already paid that cost, under MIT, and the split is clean because
capture and input share nothing but the ledger.

`post_to_psn`, `post_via_skylight` and `click_via` are kept compiled under `#[cfg(test)]` — the
measurements are reproducible, and production carries only the route that works.

`computer_scroll` was built, measured, and **withheld on that evidence** — shipping input that
silently does nothing is worse than shipping none. Its implementation stays compiled under
`#[cfg(test)]` as the executable record and the regression check.

The click was tried three ways: bare down/up; with `MOUSE_EVENT_CLICK_STATE` set; and with both
`MOUSE_EVENT_WINDOW_UNDER_MOUSE_POINTER` and
`..._THAT_CAN_HANDLE_THIS_EVENT` naming the target window. None arrived. In every case the
frontmost application was correctly left alone — the events are being posted, they are simply
not being routed to a window the pointer is not over.

This is the boundary of the public API, and it is exactly what the private SkyLight SPI exists
to cross — cua's own write-up on this is titled *how SkyLight enables multi-cursor background
agents*. §4.1 said "the private SPI buys more robustness"; it is more specific than that.
**It buys background mouse input, and nothing public substitutes.**

So §4.1's "build our own" holds for capture, enumeration and keyboard, and does **not** hold
for clicking. Three ways out, and this is a decision to take deliberately rather than drift
into:

1. **Private SkyLight SPI for the click path only.** Smallest surface — one call — but it
   reintroduces exactly the maintenance tax §4.1 rejected, on an API Apple can change per
   release.
2. **Activate the window, then click.** Public, reliable, and it steals the user's focus —
   which forfeits the property that makes unattended `/loop` acceptable. Defensible only as an
   explicit opt-in mode the user turns on while watching.
3. **Prefer per-target channels over OS-level clicking.** Chrome already has CDP, which is
   strictly better. Unity, Godot and Unreal editors all have scripting bridges. Under this
   reading, OS-level clicking is the fallback for apps with no channel at all, and the eye
   (capture) stays the feature — which is where §4.1a already landed.

`computer_click` ships reporting `delivered: "unconfirmed"` rather than claiming a success it
cannot observe, and its live test is kept failing-and-ignored as the regression check for
whichever option lands.

**Still untested: whether the click lands when the window is frontmost.** Two attempts to force
Chrome to the front failed (the `osascript … to activate` never took), so the frontmost case has
been observed only incidentally, never controlled. It matters because it separates "the
mechanism is sound and only background routing is missing" from "synthetic mouse input does not
reach this app at all", and those point at different options above. Settle it before choosing.

**Two defects found while measuring this, both now fixed:**

- **Captures were squashed to a square.** `MAX_CAPTURE_EDGE` was applied to each axis
  independently, so a 1280x800 window came back 1568x1568 — a distorted picture handed to a
  vision model, and invisible in the bytes because it still decodes cleanly. Both axes now scale
  by one factor, and `a_capture_keeps_the_window_aspect_ratio` asserts the ratio against the real
  window rather than trusting the arithmetic.
- **The "focus was not stolen" assertion was vacuous.** It compared frontmost-app names obtained
  by asking System Events over AppleScript, which needs an Automation grant this context does not
  have and so returned `""` both times — `"" == ""` passes forever. Now read from
  `lsappinfo front`, which needs no grant and returns a real ASN.

### 4.2 The four things CaliCode must own

**1. Attach scoping — the invariant that makes this safe.** The agent may attach only to
windows of processes core itself spawned. A window whose pid is not in the ledger is not
attachable, and `computer_attach` refuses with a reason.

*Correction (2026-08-15): an earlier draft claimed "core already has that ledger". It did not.*
Spawns were scattered across `blender.rs`, `browser.rs`, `devserver.rs`, `mcp.rs` and
`diagnostics.rs`, each holding its own `Child` with no central record. `spawn_ledger.rs` now
supplies it, and it is built rather than assumed because a naive version is worse than none:
**pids are recycled**, so a ledger storing bare pids keeps answering "yes, that is our browser"
after the browser exits and the kernel reissues the number — handing the agent whatever now
owns it. Entries therefore carry the kernel start time and every lookup re-reads and compares,
so a recycled pid misses. Registration that never happens costs a refused attach; a stale entry
that matched would cost the invariant, so everything fails in the first direction — including
platforms where the start time cannot be read, where every lookup misses rather than degrading
to pid-only.

Still outstanding: the spawn sites do not call `register` yet, so the ledger is correct but
empty. Wiring them is the next step, and until it happens attach scoping refuses everything —
which is the right way round to be incomplete. This makes "the agent read your email" *unrepresentable* rather than merely
discouraged — the same construction as the approvals invariant ("only two things may produce a
denial"). No competitor in §2 has this, and it is the difference between a feature that can run
unattended in a `/loop` and one that cannot.

A user-facing escape hatch (`computer.scope: workspace | desktop`) can exist, defaulting to
`workspace`, so the power user can opt into full-desktop control deliberately. Opt-in, never
inferred.

**2. Approvals.** Going built-in makes this *better*, not harder. As native tools the
`computer_*` calls run the normal `tool_gate` path into `approvals.rs` — its 300s bounded timer
and its no-inferred-denial guarantee — instead of the MCP untrusted-server path, which was only
ever an approximation of the right answer. Run cua-driver in its restricted daemon mode and let
CaliCode's wall be the only wall.

Native tools also mean `agent.rs`'s plan-mode classification applies. Every `computer_*` tool
needs a read-only/destructive entry, and `every_plan_mode_tool_is_classified_read_only` fails
loudly if one is missed — a guardrail an MCP server would have bypassed entirely.

**3. A COMPUTER tab.** Reuse BrowserTab's cast plumbing so the user watches the same surface
the agent drives, rather than each having their own — the same call already made for BROWSER,
for the same reason, and it is what makes an unattended run auditable.

**4. Token discipline.** This is where computer use gets expensive, and where `browser.rs`
already set the house rule: text snapshot first (`browser_snapshot`), image second
(`browser_look`), with an explicit hint when the model cannot accept images. Carry it over —
AX/SOM text by default, screenshots on request. Hermes reports ~30K tokens for a 20-action
session with screenshot eviction (keep 3 most recent), image-aware token counting, and
context editing; without that it is ~600K. Budget for the eviction work; it is not optional.

### 4.3 Naming

Expose the driver's tools under CaliCode-side names matching the Anthropic action vocabulary —
`screenshot`, `left_click`, `type`, `key`, `scroll`, `wait` — so computer-use-trained models
transfer. Keep them provider-neutral custom tools rather than the `computer_20251124` block:
core speaks OpenAI-compatible chat completions and the model catalog is not Anthropic-only, so
a native tool type is not available in that shape.

### 4.4 The Seatbelt exception — shape C only

Under **B**, this section is empty: the driver is linked into core, and core is the host
process, already unconfined. One of the quieter arguments for eventually going in-process.

Under **C**, the sidecar needs a deliberate carve-out. **cua-driver cannot work confined** —
screen capture and AX both reach far outside any workspace root — so it joins the exceptions
`sandbox.rs` already documents for Chrome and Blender, written into that module doc alongside
them, with the reason.

Either way the underlying trade is the same: the component that can see the screen and
synthesise input is not confined. That is coherent only because of §4.2.1 — attach scoping is
what keeps an unconfined driver from being an unconfined *agent*. If scoping is cut, this
carve-out must be cut with it.

---

## 5. Risks

- **Prompt injection through pixels.** The model reads screen content, and hostile text in a
  screenshot can carry instructions. Anthropic runs classifiers for this on the native tool;
  custom tools get no such thing. §4.2.1 scoping is the mitigation that actually holds: a
  surface the agent can reach is one core launched.
- **Grant loss on cert change.** §1.4. Silent, and it presents as an unexplained outage.
- **Private SPI drift.** cua's macOS path rides SPIs Apple can change per release. Adopting
  means accepting a dependency that can break on a macOS update. Pin, and test on betas.
- **Raw-input games.** Background posting reaches AppKit/NSEvent apps. A game reading IOKit HID
  or GameController directly will not see synthesised input. Unity/Unreal *editors* are fine;
  some shipped builds are not. Document rather than fight.
- **Hover-dependent UI** cannot be driven without moving the one real cursor. Accept as a
  documented limit.
- **Unpinned upstream.** The crates are not on crates.io (§4.1), so the dependency is a pinned
  git/artifact reference on a fast-moving 4,000-commit project. Pin hard, review diffs on
  bump, and never float the version.
- **The macOS driver is Swift, not Rust** (§4.1, confirmed) — so the dependency is a signed
  macOS app bundle we redistribute and re-sign, not a crate we compile. Rust parity is
  upstream's stated direction but is not here yet.
- **macOS-first.** `cfg`-gate; the driver covers Windows/Linux later if the app ever does.

---

## 6. Phasing

1. **Run §1.3 — the one blocking measurement (~1h).** Five-line patch so the bundled app
   spawns the probe; confirm whether attribution lands on `com.calicode.desktop`; revert.
   Selects C″ (one bundle) or C′ (nested driver bundle) per §4.1a. Questions (b) and (c) from
   the earlier draft are now answered in §4.1 and need no further work.
2. **Driver + policy.** The shape §1.3 selected, Seatbelt carve-out, native `computer_*` tools
   in `tools.rs` with plan-mode classification, attach scoping against the spawn ledger, and a
   `computer_doctor` preflight reporting which TCC subject actually holds the grant. Rust tests
   for scoping refusal, plan-mode classification, and the carve-out.
3. **COMPUTER tab** on BrowserTab's cast plumbing.
4. **Token discipline**: screenshot eviction, image-aware counting.
5. *Optional:* migrate C → B (link in-process, drop the sidecar and its carve-out) once the
   §4.1 caveats are closed and the dependency has earned trust.
6. *Optional:* a disposable Linux container (Xvfb + the Anthropic reference shape) as a
   genuinely isolated second computer, for unrestricted arbitrary-app use. Separate product
   decision.

**Verification** follows CLAUDE.md's ship loop as usual, with one addition worth stating: this
is the first feature where "drive it yourself headlessly" collides with "never drive the user's
live screen." Exercise it against a window **core spawned** — the dev server's Chrome, or a
throwaway app — never against the user's session. The scoping invariant is what makes that
distinction mechanical rather than a matter of care.

---

## 7. The Electron pivot (decided 2026-08-15) — read before Phase 1

The desktop shell is moving from Tauri to Electron. Three consequences for this plan, one of
them blocking.

**Blocking: §1.3 must be re-measured, not carried over.** TCC attribution is a property of the
bundle layout, and Electron's differs completely — `Contents/Frameworks/` carrying nested
`Helper (Renderer).app`, `(GPU).app`, `(Plugin).app`. The Tauri measurement in §1.2 tells us
the *mechanism* (responsibility inheritance) but not the *answer* for the new bundle. **Do the
migration first, then run Phase 1.** Measuring a shell that is about to be deleted is waste.

**C′ gets cheaper.** §4.1a treated nesting a signed `CuaDriver.app` as a wart because it is
unusual under Tauri. Under Electron, per-helper nested bundle signing is exactly what
electron-builder / `@electron/osx-sign` already do four times over. The exotic option becomes
the routine one, which narrows the gap between C′ and C″ considerably.

**`computer_doctor` comes mostly for free.** `systemPreferences.getMediaAccessStatus('screen')`
and `askForMediaAccess` are first-class Electron APIs covering precisely the preflight
§4.2/§6 specifies. Prefer them to hand-rolled `CGPreflight*` calls in core.

**And §1.4 gets worse.** One bundle becomes five nested ones, every one of which needs stable
signing identity or TCC grants die silently. Settle signing during the migration.

Unaffected: everything in `core/`. `sandbox.rs`, `approvals.rs`, the spawn ledger and the
agent loop are shell-agnostic, so §4.2's policy layer is untouched by the pivot.

---

## 8. What this is actually for, today

Nothing. And that is the correct answer, not a failure.

The shipped tools reach native windows, and today there are none worth reaching: three.js and
WebGPU games render in the agent browser, where `browser_snapshot`, `browser_click` on the
canvas and `browser_look` already do the whole job over CDP. `computer_doctor` will say so
plainly — "everything CaliCode started is headless or windowless" — which is the honest report
rather than a confusing empty one.

What has been bought is the boundary and the eye, both proven, waiting for the target that needs
them. The spawn ledger, attach scoping, capture and the permission preflight are the parts that
take real time to get right and that are hard to retrofit safely; the click is the part that can
be revisited in an afternoon once there is a Unity or Unreal window to point at. Building them
in that order was the right way round.

---

## 9. Honest scoping note

For three.js games specifically, `browser_click` on canvas already covers the play-test loop.
What this buys is native surfaces: packaged builds, Blender's GUI, engine editors, and
`CaliCode.app` verifying itself. That is a real gap and worth closing — but it is worth being
clear-eyed that it is the gap being bought, not "the agent can finally see."
