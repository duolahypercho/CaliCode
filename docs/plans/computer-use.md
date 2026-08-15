# Computer use

Status: **plan only, nothing built.** TCC spike run 2026-08-14; results in §1.
Recommendation: **§4 — built-in `computer_*` tools in `tools.rs`, over an embedded
`cua-driver-rs`.** Codex-style from the user's side: zero install, zero config, tools always
present. But we do not write the input/capture stack, and we do not ship it as a
user-configured MCP server either.

---

## 0. The decision in one paragraph

CaliCode already has more computer use than it looks: `browser.rs` drives a real Chrome over
CDP, and `browser_click` takes raw viewport coordinates specifically so the agent can reach a
`<canvas>`, which is how it plays a running three.js game. The gap is **native windows** — a
packaged build, Blender's GUI, an engine editor, `CaliCode.app` itself. Closing that gap does
not require inventing anything: the industry converged during 2026 on one architecture, and
there is a mature MIT-licensed implementation of it (`trycua/cua`, 21.4k stars) that already
speaks MCP over stdio — the exact transport `mcp.rs` already implements. The work worth doing
here is **not the driver**. It is the policy layer the driver deliberately leaves to its host:
what the agent may attach to, how a click gets approved, and where the user watches. That is
where CaliCode's existing invariants — the spawn ledger, `approvals.rs`, the BROWSER tab —
already give us something the competitors do not have.

Ship it **built-in**, the way Codex does: `computer_*` tools sitting in `tools.rs` beside
`browser_*`, present with no install and no config. That is a statement about the product
surface, not about who writes the private-SPI code underneath — and §4 keeps those two
questions apart, because collapsing them is the mistake that leads to spending months
reimplementing `cua-driver-rs` badly.

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

## 3. What I got wrong in the first sketch

Recorded because the correction is load-bearing.

I proposed `CGEventPostToPid` for background input. Hermes/cua use
**`SLPSPostEventRecordTo`**, a private SkyLight SPI, for pid-scoped posting without a cursor
warp. Both avoid moving the cursor; the SkyLight path is what actually works across the app
surface in practice, and it is also why this is a **maintained dependency, not a weekend
module** — private SPIs move between macOS releases, and absorbing that maintenance is a
standing cost we should decline. That single fact is the strongest argument for §4.

I also proposed the AX tree as the snapshot analogue of `browser_snapshot`. That was right,
and it is what cua already does (`capture` with `mode: "ax"` for text, `mode: "som"` for a
numbered-element overlay). The known failure — sparse or empty AX trees on custom-drawn apps
and modern UWP/Electron — is exactly the case CaliCode already has an answer for: fall back to
coordinates, the way `browser_click` already does for `<canvas>`.

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

### 4.1 Why not native `computer.rs`, and why not Python

`cua-driver-rs` is a **Rust workspace** — a daemon, platform crates, and a UniFFI SDK sitting
above a versioned C ABI — MIT-licensed, covering macOS, Windows and Linux. The Python and
TypeScript SDKs are *generated bindings over that same native runtime*, not the runtime itself.
An earlier draft called this "a new runtime dependency class (Python/Swift/TS)"; that was
wrong, and it removes the main objection to adopting it.

It exposes 49 tools, including `get_window_state`, which returns a structured accessibility
tree grounded on `element_index` rather than raw pixels — the direct analogue of
`browser_snapshot`, and confirmation that the snapshot-first discipline in §4.2.4 is native to
the driver rather than something we would be bolting on.

Caveats to settle during the spike, not to assume:

- The crates are **not published to crates.io**; SDKs are assembled from `cua-driver-rs-v*`
  release artifacts. Embedding means a pinned git or artifact dependency. Pin it, vendor the
  C ABI header, and treat driver upgrades as deliberate.
- Sources conflict on whether the Rust port has reached **macOS parity** with the original
  Swift driver (the README presents macOS as supported; release notes elsewhere describe
  parity as in progress). CaliCode is macOS-first, so this is the single fact most likely to
  change the shape below. Verify against the pinned version before committing.

### 4.1a Embed in-process (B), or bundle as a sidecar (C)

Both deliver built-in UX. Both keep `computer_*` native in `tools.rs`. The fork is only where
the driver runs.

**B — link `cua-driver-rs` into `cali-core` over its C ABI.** No second process, no IPC, no
`externalBin` entry. Viable *because* of the spike: cua's macOS daemon-proxy exists to preserve
TCC grants by routing through a signed `CuaDriver.app`, and a host that already holds the
grants does not need it — "embedded host integration for apps holding TCC permissions" is a
documented mode, and §1.2 says `CaliCode.app` is such a host. Cleanest, and needs no Seatbelt
carve-out at all, since core is the host and is already unconfined.

**C — ship the driver as a second Tauri sidecar.** `externalBin` already carries
`binaries/cali-core`; adding one more is the pattern the repo has, not a new one. Core talks to
it over its Unix socket. Still zero-install for the user. More robust operationally: a driver
crash does not take core down, and upgrading the driver does not mean recompiling core. Costs a
Seatbelt carve-out (§4.4) and a process to supervise.

**Recommendation: start at C, migrate to B if it proves worth it.** C is the lower-risk first
landing — it is the existing sidecar pattern, it isolates a dependency we have not run before,
and it keeps the driver swappable while §4.1's two caveats are still open. B is strictly nicer
once the macOS-parity question is settled and the dependency has earned trust.

**These two are also the risk hedge for each other.** If §1.3's bundled-attribution assumption
fails and grants do *not* land on `com.calicode.desktop`, B is dead — an in-process driver has
no way to hold a grant the host lacks. C survives, by falling back to cua's own signed
`CuaDriver.app` daemon, which exists precisely for that case. Do not close off C before the
spike closes §1.3.

### 4.2 The four things CaliCode must own

**1. Attach scoping — the invariant that makes this safe.** The agent may attach only to
windows of processes core itself spawned. Core already has that ledger: dev server, Blender,
Chrome. A window whose pid is not in it is not attachable, and `computer_attach` refuses with a
reason. This makes "the agent read your email" *unrepresentable* rather than merely
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
- **macOS parity of the Rust port** may lag the original Swift driver (§4.1). This is the
  fact most likely to reshape the plan, and CaliCode is macOS-first.
- **macOS-first.** `cfg`-gate; the driver covers Windows/Linux later if the app ever does.

---

## 6. Phasing

1. **Finish the spike (~half day).** Three questions, all cheap, all shape-determining:
   (a) five-line patch so the bundled app spawns the probe — confirm attribution lands on
   `com.calicode.desktop`, then revert (§1.3); (b) pin a `cua-driver-rs` version and establish
   whether its macOS backend is at parity (§4.1); (c) confirm the embedded-host mode works for
   a host holding its own TCC grants, which is what decides B vs C (§4.1a).
2. **Driver + policy.** Sidecar (shape C) under `externalBin`, Seatbelt carve-out, native
   `computer_*` tools in `tools.rs` with plan-mode classification, attach scoping against the
   spawn ledger, and a `computer_doctor` preflight reporting which TCC subject actually holds
   the grant. Rust tests for scoping refusal, plan-mode classification, and the carve-out.
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

## 7. Honest scoping note

For three.js games specifically, `browser_click` on canvas already covers the play-test loop.
What this buys is native surfaces: packaged builds, Blender's GUI, engine editors, and
`CaliCode.app` verifying itself. That is a real gap and worth closing — but it is worth being
clear-eyed that it is the gap being bought, not "the agent can finally see."
