#!/usr/bin/env node
// Proves the native subagent orchestration loop: the coordinator calls
// subagent_spawn, the subagent calls a browser tool, and the simulated
// browser answers over SSE before the coordinator reports.
const BASE = process.env.CALI_CORE || "http://127.0.0.1:8765";

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
      name: "editor_echo",
      description: "Echo arguments back to the agent.",
      parameters: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
  ],
});

const response = await fetch(`${BASE}/events`, {
  headers: { Accept: "text/event-stream" },
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
        console.log(`[tool_request] session=${event.sessionId} tool=${event.tool}`, JSON.stringify(event.arguments));
        const result =
          event.tool === "editor_echo"
            ? { message: event.arguments.message }
            : { error: `unknown tool ${event.tool}` };
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
  id: "subagent-loop",
  method: "agent_chat",
  params: {
    projectSlug: "starter",
    maxTurns: 10,
    messages: [
      {
        role: "user",
        content:
          "Call subagent_spawn with role tester and instructions: " +
          "Call editor_echo with message subagent-ok and reply with the echoed message. " +
          "Then reply with the subagent result.",
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

