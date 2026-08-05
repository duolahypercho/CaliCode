#!/usr/bin/env node
// Simulates the browser agent panel for a vision loop: it answers PIE and
// capture tool requests with real screenshots, then lets the agent save and
// compare screenshot baselines through the core.
const BASE = process.env.CALI_CORE || "http://127.0.0.1:8765";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function rpc(method, params) {
  const response = await fetch(`${BASE}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
  });
  return response.json();
}

await rpc("tool_register", {
  tools: [
    {
      name: "editor_run_pie",
      description: "Run the game in Play-In-Editor for a number of frames.",
      parameters: {
        type: "object",
        properties: { frames: { type: "number" } },
      },
    },
    {
      name: "editor_capture_frame",
      description: "Capture the current rendered frame as a screenshot.",
      parameters: { type: "object", properties: {} },
    },
  ],
});

const controller = new AbortController();
const response = await fetch(`${BASE}/events`, {
  headers: { Accept: "text/event-stream" },
  signal: controller.signal,
});
const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";

void (async () => {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const dataLine = block
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim();
      if (!dataLine) continue;
      let event;
      try {
        event = JSON.parse(dataLine);
      } catch {
        continue;
      }
      if (event.type === "agent.tool_request" && event.requestId && event.sessionId) {
        console.log(`[tool_request] ${event.tool}`, JSON.stringify(event.arguments));
        let result;
        if (event.tool === "editor_run_pie") {
          result = { frames: 12, captures: 4 };
        } else if (event.tool === "editor_capture_frame") {
          result = { dataUrl: `data:image/png;base64,${PNG}` };
        } else {
          result = { error: `unknown tool ${event.tool}` };
        }
        const submit = await rpc("agent_tool_result", {
          sessionId: event.sessionId,
          requestId: event.requestId,
          result,
        });
        console.log("[submit_result]", JSON.stringify(submit));
      }
      if (event.type === "agent.tool_finished") {
        console.log("[tool_finished]", event.tool, JSON.stringify(event.result));
      }
    }
  }
})();

const payload = {
  jsonrpc: "2.0",
  id: "vision-loop",
  method: "agent_chat",
  params: {
    projectSlug: "starter",
    maxTurns: 10,
    messages: [
      {
        role: "user",
        content:
          "Call editor_run_pie with frames 12. Then call editor_capture_frame. " +
          "Then call test_baseline_save with name vision and the returned dataUrl image. " +
          "Then call test_baseline_compare with the same name and image. " +
          "Reply with the compare pass value and distance.",
      },
    ],
  },
};

const chatResponse = await fetch(`${BASE}/rpc`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
const envelope = await chatResponse.json();
console.log("[agent_chat]", JSON.stringify(envelope, null, 2));
process.exit(0);
