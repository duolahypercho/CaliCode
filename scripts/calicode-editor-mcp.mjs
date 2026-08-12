#!/usr/bin/env node

// Dependency-free stdio MCP adapter for Codex CLI, Claude Code, and any
// other MCP client. The process cwd resolves the CaliCode session/worktree;
// CALI_SESSION_ID or --session can pin an explicit task instead.

import readline from "node:readline";

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const coreUrl = valueAfter("--core") ?? process.env.CALI_CORE_URL ?? "http://127.0.0.1:8765";
let sessionId = valueAfter("--session") ?? process.env.CALI_SESSION_ID ?? null;

async function rpc(method, params = {}) {
  const response = await fetch(`${coreUrl.replace(/\/$/, "")}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
  });
  const envelope = await response.json();
  if (!response.ok || envelope.error) {
    throw new Error(envelope.error?.message ?? `CaliCode RPC ${method} failed`);
  }
  return envelope.result;
}

async function targetSession() {
  if (sessionId) return sessionId;
  const resolved = await rpc("session_resolve_workspace", { path: process.cwd() });
  sessionId = resolved.id;
  return sessionId;
}

function response(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function error(id, cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } })}\n`);
}

async function handle(message) {
  if (message.method === "initialize") {
    response(message.id, {
      protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "calicode-editor", version: "0.1.0" },
    });
    return;
  }
  if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return;
  if (message.method === "ping") {
    response(message.id, {});
    return;
  }
  if (message.method === "tools/list") {
    const tools = await rpc("tool_list");
    response(message.id, {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: `${tool.description} (runs in the CaliCode editor attached to this task)`,
        inputSchema: tool.parameters,
      })),
    });
    return;
  }
  if (message.method === "tools/call") {
    try {
      const result = await rpc("editor_tool_call", {
        sessionId: await targetSession(),
        tool: message.params?.name,
        arguments: message.params?.arguments ?? {},
      });
      response(message.id, {
        content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
      });
    } catch (cause) {
      response(message.id, {
        content: [{ type: "text", text: cause instanceof Error ? cause.message : String(cause) }],
        isError: true,
      });
    }
    return;
  }
  if (message.id != null) error(message.id, new Error(`method not found: ${message.method}`));
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  void Promise.resolve()
    .then(() => handle(JSON.parse(line)))
    .catch((cause) => error(null, cause));
});

