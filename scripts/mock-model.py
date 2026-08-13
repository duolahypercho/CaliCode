#!/usr/bin/env python3
"""A scripted OpenAI-compatible model, so the agent loop can be exercised
without a live provider.

The harness's control flow — fan-out, dependency ordering, monitor/judge
gating, punch-list re-queue — is worth testing on its own, and a provider
outage or a usage cap should not stop that. Core skips its API-key check for
`127.0.0.1` base URLs, so no key is needed.

    python3 scripts/mock-model.py 8811 fanout &
    # point a throwaway config at it, then run core against that config:
    #   model: {default: mock-model, provider: openai,
    #           base_url: "http://127.0.0.1:8811/v1"}
    CALI_PORT=8799 CALI_PROJECTS_DIR=/tmp/p CALI_CONFIG=/tmp/mock.yaml \\
        ./core/target/debug/cali-core

    curl -s localhost:8811/   # per-request log with timing windows

Two scenarios:

* `fanout` — the parent's first turn emits three `subagent_spawn` calls in one
  assistant message, the exact shape `agent.rs` fans out concurrently.
* `graph`  — the whole /loop shape the system prompt prescribes: start a loop
  report, plan a five-node graph (three dependency-free build roots, an
  integration node, a judge), run it, append one iteration report per pass,
  then close the report. The judge scores 70 on its first verdict and 95 on
  its second, so a re-queue must happen for the graph to finish at all, and
  the two appended iterations carry that rejection into the rendered report.

Each worker response is held open for HOLD seconds, so the logged windows are
the measurement: overlapping windows mean parallel, and a wall time near N×HOLD
means the wave silently serialised.

Callers are told apart only by their system prompt — that is the sole
discriminator available on the wire. Note the parent prompt also contains the
word "subagent" (it documents `subagent_spawn`), so the child prompts are
matched on their own longer phrasing.

When stopping a run, kill listeners with `lsof -ti:PORT -sTCP:LISTEN`. A bare
`lsof -ti:PORT` also lists core, which holds a *client* connection to this
port, and killing that takes core down with it.
"""
import json
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8811
MODE = sys.argv[2] if len(sys.argv) > 2 else "fanout"
HOLD = float(sys.argv[3]) if len(sys.argv) > 3 else 1.5

T0 = time.time()
LOCK = threading.Lock()
LOG = []
STATE = {"parent": 0, "judge": 0}
CALL_SEQ = [0]
# Paths the build nodes actually persisted this run. The loop report has to
# cite real evidence: core refuses to mark a loop completed when its last
# iteration carries none, and the report page embeds whatever it cites.
PERSISTED = []
# Prefix stability per caller. A provider prompt cache only hits on a
# byte-identical prefix, so "what fraction of this request did the previous one
# already contain" is the ceiling on the cache rate — measured here rather than
# assumed, because anything unstable near the front (tool order, a timestamp in
# the system prompt) silently costs the whole window.
PREFIX = {}


def common_prefix_len(a, b):
    n = min(len(a), len(b))
    lo, hi = 0, n
    while lo < hi:                      # binary search: these bodies are large
        mid = (lo + hi + 1) // 2
        if a[:mid] == b[:mid]:
            lo = mid
        else:
            hi = mid - 1
    return lo
# One report id per process: a rerun against a fresh projects dir starts clean,
# and a rerun against a used one must collide loudly rather than silently append.
LOOP_ID = "loop-mock-%d" % PORT

GRAPH_NODES = [
    {"id": "gameplay", "title": "Gameplay and entities", "kind": "build", "role": "coder",
     "instructions": "Build the player, arena and scoring.",
     "acceptance": ["entities exist"], "deps": []},
    {"id": "assets", "title": "Assets and lighting", "kind": "build", "role": "artist",
     "instructions": "Author the neon palette and lighting.",
     "acceptance": ["materials vary"], "deps": []},
    {"id": "scripts", "title": "Scripts and tests", "kind": "build", "role": "tester",
     "instructions": "Write movement scripts and invariants.",
     "acceptance": ["tests pass"], "deps": []},
    {"id": "integration", "title": "Integration", "kind": "build", "role": "coder",
     "instructions": "Wire the three slices together.",
     "acceptance": ["scene runs"], "deps": ["gameplay", "assets", "scripts"]},
    {"id": "critic", "title": "Blind judge", "kind": "judge", "role": "critic",
     "instructions": "Score the integrated slice.", "acceptance": ["score >= 90"],
     "deps": ["integration"], "reference": "Hades arena combat slice", "threshold": 90},
]


def sse(payloads):
    parts = ["data: " + json.dumps(p) + "\n\n" for p in payloads]
    parts.append("data: [DONE]\n\n")
    return "".join(parts).encode()


def text_reply(text):
    return sse([
        {"choices": [{"delta": {"role": "assistant", "content": text}}]},
        {"choices": [{"delta": {}, "finish_reason": "stop"}]},
    ])


def tool_reply(calls):
    """Call ids are globally unique. Reusing `call-0` across turns is not what
    a real provider does, and the client pairs its activity rows by call id —
    a repeated id makes a later failure land on an earlier row's label."""
    deltas = []
    for i, (name, args) in enumerate(calls):
        with LOCK:
            CALL_SEQ[0] += 1
            call_id = "call-%d" % CALL_SEQ[0]
        deltas.append({"choices": [{"delta": {"tool_calls": [{
            "index": i, "id": call_id, "type": "function",
            "function": {"name": name, "arguments": json.dumps(args)},
        }]}}]})
    deltas.append({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]})
    return sse(deltas)


def classify(system):
    s = system.lower()
    if "you are the monitor" in s:
        return "monitor"
    if "you are a judge" in s:
        return "judge"
    if "graph engine, executing one node" in s:
        return "graph-node"
    if "subagent inside calicode" in s:
        return "subagent"
    return "parent"


def slug_from(system):
    """The project digest opens with `slug "<slug>" — N entities...`, which is
    the only place the bound project's identity reaches the model."""
    hit = re.search(r'slug "([^"]+)"', system)
    return hit.group(1) if hit else "graph-demo"


def iteration_args(slug, nth, passed):
    """One loop_report_iteration payload. The two iterations mirror the judge's
    70-then-95 verdicts, so a report rendered from them shows a rejection and
    the fix that answered it rather than a single flattering pass."""
    # Real wall-clock, never backdated: core rejects an iteration that starts
    # before the loop report it belongs to, and this script's report was
    # started seconds ago — so any fixed or rolled-back stamp is refused.
    base = int(time.time() * 1000)
    return {
        "slug": slug, "loopId": LOOP_ID,
        "iteration": {
            # Never future-dated: the loop's own completion stamp must not
            # precede any iteration's, and the update follows within a second.
            "startedAtMs": base, "completedAtMs": base + nth,
            "outcome": "passed" if passed else "needs-work",
            "summary": ("Rim light landed; silhouettes read against the arena."
                        if passed else
                        "Slice runs, but lighting is flat and silhouettes mush together."),
            "agents": [
                {"role": "coder", "agentId": "node-gameplay", "task": "Player, arena, scoring",
                 "outcome": "passed", "summary": "Entities and scoring wired.", "durationMs": 21_000},
                {"role": "artist", "agentId": "node-assets", "task": "Neon palette and lighting",
                 "outcome": "passed" if passed else "failed",
                 "summary": "Rim light added." if passed else "Palette authored; lighting flat.",
                 "durationMs": 19_000},
                {"role": "tester", "agentId": "node-scripts", "task": "Movement invariants",
                 "outcome": "passed", "summary": "3 invariants green.", "durationMs": 12_000},
            ],
            "checks": [
                {"kind": "build", "name": "scene builds", "status": "passed", "durationMs": 3_100},
                {"kind": "play", "name": "PIE 10s", "status": "passed", "durationMs": 10_400},
                {"kind": "test", "name": "movement invariants", "status": "passed", "durationMs": 2_050},
            ],
            "changedFiles": [
                {"path": "scenes/arena.json", "additions": 84 if passed else 210, "deletions": 12},
                {"path": "scripts/player.js", "additions": 26, "deletions": 4},
            ],
            "evidence": [{"kind": "screenshot", "path": path,
                          "caption": "PIE frame persisted by a build node"}
                         for path in (PERSISTED[:4] or ["reports/frames/frame-1.png"])],
            "scores": [{"criterion": "Blind judge vs Hades arena combat slice",
                        "score": 95 if passed else 70, "maximum": 100, "passThreshold": 90,
                        "rationale": "Rim light landed." if passed else "Flat lighting."}],
            "punchList": ([{"priority": "low", "item": "Tighten arena wall falloff.",
                            "source": "judge", "resolved": False}] if passed else
                          [{"priority": "high", "item": "Add a rim light", "source": "judge",
                            "resolved": False},
                           {"priority": "medium", "item": "Vary prop heights", "source": "judge",
                            "resolved": False}]),
            "nextIterationMemory": {
                "observations": ["Judge reads silhouette separation before palette."],
                "decisions": ["Keep the three build roots independent."],
                "risks": ["Wall falloff may wash out at low exposure."],
                "nextActions": ["Tighten arena wall falloff."] if passed else
                               ["Add a rim light", "Vary prop heights"],
            },
        },
    }


def tool_turns(messages):
    """How many tool-calling turns this caller has already taken. The mock is
    stateless per request, so the transcript it is handed is the only place a
    node's progress is recorded."""
    return sum(1 for m in messages if m.get("role") == "assistant" and m.get("tool_calls"))


def graph_id_from(messages):
    """graph_plan's id comes back in its own tool result, already in history."""
    found = None
    for message in messages:
        if message.get("role") != "tool":
            continue
        content = message.get("content")
        text = content if isinstance(content, str) else json.dumps(content)
        if "graphId" not in text:
            continue
        try:
            found = json.loads(text).get("graphId") or found
        except ValueError:
            hit = re.search(r'"graphId"\s*:\s*"([^"]+)"', text)
            found = hit.group(1) if hit else found
    return found


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        messages = body.get("messages", [])
        system = ""
        for message in messages:
            if message.get("role") == "system":
                content = message.get("content")
                system = content if isinstance(content, str) else json.dumps(content)
                break

        kind = classify(system)
        started = round(time.time() - T0, 3)
        # Key by caller identity, not by kind: two sibling nodes are different
        # conversations and must not be compared against each other.
        first_user = ""
        for message in messages:
            if message.get("role") == "user":
                c = message.get("content")
                first_user = c if isinstance(c, str) else json.dumps(c)
                break
        # Full hashes, not prefixes: sibling nodes share the opening of both
        # their system prompt and their first user message, and comparing two
        # different conversations reports a cache miss that never happened.
        import hashlib as _h
        caller = "%s|%s|%s" % (kind,
                               _h.sha256(system.encode()).hexdigest()[:8],
                               _h.sha256(first_user.encode()).hexdigest()[:8])
        wire = json.dumps({"tools": body.get("tools"), "messages": messages},
                          separators=(",", ":"))
        with LOCK:
            previous = PREFIX.get(caller)
            PREFIX[caller] = wire
        shared = common_prefix_len(previous, wire) if previous else 0
        prefix_ratio = round(shared / len(wire), 4) if previous else None
        tools_json = json.dumps(body.get("tools"), separators=(",", ":"))
        # Base64 image payloads inside the *transcript* are the thing most
        # likely to blow a cache window and a context budget at once.
        found = re.findall(r"data:image/[a-zA-Z]+;base64,[A-Za-z0-9+/=]*", wire)
        data_urls = len(found)
        data_chars = sum(len(match) for match in found)
        # Whether this caller received rendered frames, not prose about them.
        images = 0
        for message in messages:
            content = message.get("content")
            if isinstance(content, list):
                images += sum(1 for part in content if part.get("type") == "image_url")

        if kind == "monitor":
            payload = text_reply(json.dumps({"pass": True, "notes": ["evidence present"]}))
        elif kind == "judge":
            with LOCK:
                STATE["judge"] += 1
                nth = STATE["judge"]
            if nth == 1:
                payload = text_reply(json.dumps({
                    "score": 70, "summary": "Flat lighting; silhouettes mush together.",
                    "punch_list": ["Add a rim light", "Vary prop heights"]}))
            else:
                payload = text_reply(json.dumps({
                    "score": 95, "summary": "Rim light landed; silhouettes read.",
                    "punch_list": ["Minor: tighten arena wall falloff."]}))
        elif kind in ("graph-node", "subagent"):
            # A node that only talks about frames teaches us nothing: core
            # builds its contact sheet from real editor_capture_frame results,
            # and the monitor and judge only see pixels if these calls happen.
            turn = tool_turns(messages)
            if turn == 0:
                payload = tool_reply([("editor_run_pie", {"frames": 12})])
            elif turn == 1:
                payload = tool_reply([
                    ("editor_capture_frame", {}),
                    ("editor_capture_frame", {}),
                    ("editor_capture_frame", {}),
                ])
            elif turn == 2:
                with LOCK:
                    path = "reports/frames/frame-%d.png" % (len(PERSISTED) + 1)
                    PERSISTED.append(path)
                payload = tool_reply([("editor_persist_capture", {"path": path})])
            else:
                payload = text_reply(
                    "Node complete: ran PIE for 12 frames, captured 3 frames and persisted one "
                    "to reports/frames/. Entities and scoring wired.")
                time.sleep(HOLD)
        else:
            with LOCK:
                STATE["parent"] += 1
                turn = STATE["parent"]
            if MODE == "graph":
                graph_id = graph_id_from(messages)
                slug = slug_from(system)
                # The order the system prompt prescribes for a /loop run:
                # start the report, plan, fan out, then append one iteration
                # per build/judge pass before closing the report out.
                if turn == 1:
                    payload = tool_reply([("loop_report_start", {
                        "slug": slug, "loopId": LOOP_ID,
                        "objective": "Build a neon arena game.",
                        "reference": "Hades arena combat slice"})])
                elif turn == 2:
                    payload = tool_reply([("graph_plan", {
                        "goal": "Build a neon arena game.",
                        "slug": slug, "nodes": GRAPH_NODES})])
                elif graph_id and turn == 3:
                    payload = tool_reply([("graph_run", {"graphId": graph_id})])
                elif turn == 4:
                    payload = tool_reply([("loop_report_iteration",
                                           iteration_args(slug, 1, False))])
                elif turn == 5:
                    payload = tool_reply([("loop_report_iteration",
                                           iteration_args(slug, 2, True))])
                elif turn == 6:
                    payload = tool_reply([("loop_report_update", {
                        "slug": slug, "loopId": LOOP_ID,
                        "update": {"status": "completed",
                                   "completedAtMs": int(time.time() * 1000),
                                   "summary": "Judge passed at 95 against the reference."}})])
                else:
                    payload = text_reply("DONE")
            elif turn == 1:
                payload = tool_reply([
                    ("subagent_spawn", {"role": "coder", "instructions": "Build the arena geometry"}),
                    ("subagent_spawn", {"role": "artist", "instructions": "Author the neon palette"}),
                    ("subagent_spawn", {"role": "tester", "instructions": "Write movement invariants"}),
                ])
            else:
                payload = text_reply("All three slices are done.")

        with LOCK:
            LOG.append({"kind": kind, "model": body.get("model"), "startedAt": started,
                        "caller": caller, "wireChars": len(wire),
                        "toolsChars": len(tools_json),
                        "toolsSha": __import__("hashlib").sha256(tools_json.encode()).hexdigest()[:12],
                        "systemSha": __import__("hashlib").sha256(system.encode()).hexdigest()[:12],
                        "prefixRatio": prefix_ratio, "sharedChars": shared,
                        "dataUrls": data_urls, "dataUrlChars": data_chars,
                        "finishedAt": round(time.time() - T0, 3),
                        "images": images, "tools": len(body.get("tools") or [])})

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        with LOCK:
            data = json.dumps({"mode": MODE, "log": LOG, "state": STATE}, indent=1).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class Server(ThreadingMixIn, HTTPServer):
    """Threaded: a single-threaded server would serialise the fan-out itself
    and manufacture the very result this script exists to measure."""

    daemon_threads = True


if __name__ == "__main__":
    Server(("127.0.0.1", PORT), Handler).serve_forever()
