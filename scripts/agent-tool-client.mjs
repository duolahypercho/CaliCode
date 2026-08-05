#!/usr/bin/env node
// Simulates the browser agent panel: subscribes to SSE, answers browser tool
// requests, and prints the agent chat result. Used to verify the live loop.
const BASE = process.env.CALI_CORE || "http://127.0.0.1:8765";

async function rpc(method, params) {
  try {
    const response = await fetch(`${BASE}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
    });
    return await response.json();
  } catch (error) {
    console.error("[rpc_error]", method, error);
    throw error;
  }
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

console.log("[rpc_ping]", JSON.stringify(await rpc("ping", {})));

let sessionId = null;

async function listenForEvents() {
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
          sessionId = event.sessionId;
          console.log(`[tool_request] ${event.tool}`, JSON.stringify(event.arguments));
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
}

await listenForEvents();

const payload = {
  jsonrpc: "2.0",
  id: "agent-test",
  method: "agent_chat",
  params: {
    projectSlug: "starter",
    maxTurns: 6,
    messages: [
      {
        role: "user",
        content: "Call editor_echo with message hello-agent. Then reply with the echoed value.",
      },
    ],
  },
};

const response = await fetch(`${BASE}/rpc`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
const envelope = await response.json();
console.log("[agent_chat]", JSON.stringify(envelope, null, 2));
