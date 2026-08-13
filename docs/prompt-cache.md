# Prompt cache: what a 99%-cached agent turn requires

A provider prompt cache only hits on a **byte-identical prefix**. So the cache
rate of an agent turn is not a provider feature you switch on — it is a
property of how the harness assembles each request. Two things decide it:

1. **Prefix stability.** Everything before the first changed byte can be
   reused. One unstable byte near the front — a timestamp in the system
   prompt, a tool list in hash order, a re-sorted project digest — throws away
   the whole window regardless of what the provider supports.
2. **Append-only growth.** A turn that only *appends* (previous transcript
   plus one new result) reuses everything before the append. The cache rate is
   then `shared / total`, which rises naturally as a conversation grows.

Harnesses that report ~99% cached input are describing a loop where the system
prompt and tool schemas are fixed, history is never rewritten mid-run, and each
turn appends a small result to a large stable prefix.

## Measured, on this harness

`scripts/mock-model.py` records, per request, the fraction of the body the
previous request from the same conversation already contained. From one
one-prompt run (7 parent turns, 20 node calls, 5 monitors, 2 judges):

| caller | prefix reuse (min / median / max) |
| --- | --- |
| parent (top-level chat) | 0.877 / 0.914 / 0.970 |
| graph node (build subagent) | 0.972 / 0.990 / 0.994 |
| monitor, judge | single-shot — nothing to reuse |

What already holds:

- **The tool payload is byte-identical across every call** — one distinct
  35,249-char schema block across all 7 parent calls. Rust's `HashMap`
  iteration does not leak into the wire.
- **The system prompt is stable per role** — one distinct parent prompt across
  the run. Nothing time-varying sits in the prefix.
- Growth is append-only within a turn loop, so reuse climbs with transcript
  size rather than falling.

## What broke it, and what that cost

One node turn measured **220,229 base64 characters inside a 264,264-character
request** — 83% of the body — and prefix reuse for that call fell to **0.163**.

The cause was `editor_capture_frame` returning its full `data:image/...` URL
into the calling agent's own transcript. Core harvests those frames from the
tool *event* to build the contact sheet the monitor and judge actually look at,
so the transcript copy was read by nobody while costing three ways: it is
re-sent on every later turn of that agent, it evicts the cached prefix, and it
is most of a small model's context window.

`bound_tool_result` now replaces any `data:image/…` string over 512 characters
with a receipt naming `editor_persist_capture(path)` as the way to keep a
frame. Same workload, after:

| | before | after |
| --- | --- | --- |
| worst node body | 264,264 chars | 45,162 chars |
| base64 in node transcripts | 220,229 chars | 23 (a schema example) |
| node prefix reuse (min) | 0.163 | 0.972 |
| sheets reaching monitor / judge | 5/5, 2/2 | 5/5, 2/2 |

The last row is the one that matters most: images the graders are *meant* to
see travel as `image_url` content parts assembled by core, and are untouched.
Only the dead copy in the conversation is gone.

## Where the remaining gap is

The parent sits at ~0.91 because each turn appends a whole tool result to a
still-small transcript — arithmetic, not waste, and it improves as the session
grows. Two levers remain if the parent's rate matters:

- Keep large one-off results (a full `graph_run` snapshot) out of the
  transcript in favour of a digest plus an id to re-read on demand.
- Avoid mid-run rewrites of history. Compaction necessarily invalidates the
  prefix, so it should run at a turn boundary and rarely, which is what
  `compaction.auto` plus the threshold already arrange.

Provider-side signalling is separate and already handled: `sends_cache_key`
gates the OpenAI-style `prompt_cache_key`, and Anthropic models routed through
OpenRouter get explicit `cache_control` breakpoints (see CALI-SOAK-026). Those
only pay off if the prefix is stable in the first place — which is what this
document measures.

## Re-running the measurement

```bash
python3 scripts/mock-model.py 8811 graph 0.4 &
CALI_PORT=8799 CALI_PROJECTS_DIR=/tmp/p CALI_CONFIG=/tmp/mock.yaml ./core/target/debug/cali-core &
# drive one prompt through the editor, then:
curl -s localhost:8811/    # prefixRatio, wireChars, dataUrlChars per request
```
