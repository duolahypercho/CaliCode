# SF city game — CaliCode session prompt

Prompts to paste into CaliCode's agent panel, with the **San Fransisco**
workspace open (`/Volumes/OWC 2TB EXternal SSD/Code/San Fransisco`).

## State of the game (read this first)

This is **not greenfield**. `san-francisco-realtime` is a mature Three.js +
WebGL2 project with real OSM-derived SF data, elevation terrain, traffic
signals, pedestrians, NPC behaviour trees, streaming, and multiplayer.

It already has a harsh-critic harness and **has passed it**:

| | |
|---|---|
| Critic passes run | 26 |
| Trajectory | pass 11b **FAIL 5.4** → pass 26 **PASS 8.4 — SHIP** |
| Gate | ≥8.0/10 with zero hard blockers |
| Method | blind A/B against real SF references + per-criterion scoring |

Existing harness commands (`package.json`):

```
pnpm qa:realmap              # capture the QA frame pack
pnpm qa:realmap-critic       # harsh critic scoring pass
pnpm qa:realmap-blind-ab     # blind A/B vs real SF references
pnpm verify:city             # city simulation invariants
pnpm verify:traffic-rules    # signal + one-way correctness
pnpm verify:performance      # framerate / budget
pnpm verify:gauntlet         # full matrix
```

**Do not rebuild what exists.** The job is to push 8.4 → 9.5+ and kill the
remaining blockers, using the harness that is already there.

## Phase 0 — orient (plain message, not `/loop`)

```
This workspace is `san-francisco-realtime`, a mature Three.js r180 + WebGL2
stylized SF city game. It has already passed its harsh-critic gate at 8.4/10
(pass 26). Do NOT rebuild it.

Read, then report back in <=10 bullets before changing anything:
- .qa-critic-pass26.md   (the passing verdict + what still scored lowest)
- .qa-critic-pass25.md   (what changed to get there)
- package.json           (the qa: and verify: harness scripts)
- src/world.js, src/traffic-graph.js, src/signals.js

Tell me: the three lowest-scoring criteria in pass 26, any hard blockers still
listed, and which harness command verifies each.
```

## Phase 1 — re-baseline

```
/loop Re-run the existing critic harness against the current HEAD to get a
fresh, honest baseline: `pnpm qa:realmap` then `pnpm qa:realmap-critic` then
`pnpm qa:realmap-blind-ab`. Do not change any game code this loop — only fix
harness breakage if a script errors.
DONE when: a fresh critic report exists for current HEAD with a numeric score
per criterion and an explicit blocker list, and you have posted that score
table in chat.
```

## Phase 2..N — one loop per lowest criterion

Take the **lowest-scoring criterion** from Phase 1 and run this, substituting
`<CRITERION>` and its target. Repeat for the next-lowest, one at a time.

```
/loop Raise the "<CRITERION>" score from <CURRENT> toward 9.5/10 in the
san-francisco-realtime game. Work only on that criterion — do not regress the
others.
Method each iteration: make one focused improvement, then `pnpm qa:realmap` to
recapture, then `pnpm qa:realmap-critic` to rescore, then read the critic's
specific complaints and address the worst one next.
Constraints: Three.js r180 + WebGL2, keep >=60fps (`pnpm verify:performance`),
keep `pnpm verify:traffic-rules` and `pnpm verify:city` green.
DONE when: the critic scores "<CRITERION>" >= 9.5/10 with zero hard blockers,
and no other criterion dropped below its pass-26 value.
```

Known weakest areas from the pass-11b→26 history, in likely order:

1. **Art cohesion** — material clash (photo texture on greybox), repetitive
   window grids, flat ambient, 2D fog sprites.
2. **Actor/life** — stick-figure NPC silhouettes, no cable-car passengers.
3. **District identity** — Presidio reads generic; missing City Hall dome,
   Painted Ladies, Presidio gate/barracks vocabulary.
4. **Traffic** — verify no simultaneous green+red on any signal.

## Final gate — blind A/B

```
/loop Act as a HARSH art director with zero attachment to this codebase. Run
`pnpm qa:realmap` and `pnpm qa:realmap-blind-ab`. For every pair, state which
image you prefer WITHOUT knowing which is the sim, and justify flaw-by-flaw
against the real SF reference. Fix the single worst flaw, recapture, repeat.
DONE when: the sim wins or ties at least half the blind pairs against real SF
references, overall score >= 9.5/10, and zero hard blockers remain.
```

## Operating notes

- Set permission mode to **Auto** or **Full access** — Supervised blocks on
  every tool call.
- `/compact` between phases; `/fork` before a risky phase.
- Spawn a **critic** subagent (··· menu) for an independent read — the point of
  the harness is that the critic is not the author.
- CaliCode's PLAY tab runs the workspace's own dev server, so `pnpm dev` in the
  project is what you see.
