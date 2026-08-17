---
name: goal-loop
description: The quality loop for GOAL-tier work — a feature, a system, a game, or any request with quality language ("polished", "beautiful", "AAA", "like <game>"). Load before calling graph_plan. Names the reference bar, decomposes into a task graph, fans out, judges blind, and iterates per item.
---

# The loop: name the bar -> decompose -> fan out -> judge blind -> iterate

1. NAME THE BAR. Restate the user's goal against a specific, named reference —
   the best-in-class published game (or asset/scene) in the same genre. Prefer
   a matching template's reference (template_list; ids are in '## This
   session'); else pick the obvious genre flagship and tell the user which you
   chose; if the genre is genuinely ambiguous, ask. If you cannot name the
   reference you are matching, you do not yet understand the goal.

2. DECOMPOSE. Call graph_plan: small tasks, one owner each, explicit
   acceptance criteria, dependency edges. Criteria must demand primary
   evidence — files written, entities present, tests green, frames captured —
   because unevidenced claims count as unmet. For a multi-domain game, use at
   least three dependency-free Build roots (gameplay/entities, assets/visuals,
   scripts/tests), then a separate Integration Build depending on every root,
   and a terminal Judge depending on Integration. Never serialize independent
   roots. Every plan ends in a judge node carrying the named reference and a
   threshold (90 = would pass review at a top studio; 100 = utterly perfect).

   For a /loop run, call loop_report_start before graph_plan and append one
   loop_report_iteration after every build/play/judge pass. Carry its
   nextIterationMemory into the next pass; finish with loop_report_update.

3. FAN OUT. Call graph_run. Each node runs as a fresh subagent (planner,
   coder, artist, tester, critic) owning only its own item — focused context
   beats one overloaded transcript, and per-item quality beats averaged
   quality: nothing weak may hide behind something strong.

4. JUDGE BLIND. The judge is a fresh critic that never sees how anything was
   built and has no stake in it passing. It inspects the live artifact itself —
   frames, scene state, test runs — and judges as a blind side-by-side against
   the reference: "if these two screenshots were unlabeled, which would a
   player pick, and why?" The 'why not ours' becomes the punch list. Harshness
   is its job: finding flaws is success, approval without evidence is failure.

5. ITERATE PER ITEM. Below threshold, only the failed item's builders re-run,
   armed with the judge's punch list; passed items are left alone. Rejection
   is the system working. The judge — never a builder — decides when an item
   is done, and "done" means the score crossed the threshold, not "good
   progress was made". If attempts are exhausted, report the graph as BLOCKED
   with the last punch list — never present it as finished. If a graph ends
   blocked, read graph_status, repair the stuck node's plan, and re-run.

The acceptance criteria are the floor; the reference is the bar. Pursue every
quality dimension the reference exhibits — lighting, materials, silhouette,
motion feel, feedback, readability, audio hooks — whether or not anyone listed
it. That surplus beyond the criteria is the difference between "meets spec"
and a result the judge is genuinely wowed by, and the loop runs until it is.
