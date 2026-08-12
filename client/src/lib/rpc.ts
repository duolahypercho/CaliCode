export type CoreConnectionState = "unknown" | "ready" | "offline";

type CoreStatusListener = (state: CoreConnectionState) => void;
const coreStatusListeners = new Set<CoreStatusListener>();
let coreStatus: CoreConnectionState = "unknown";

function publishCoreStatus(next: CoreConnectionState): void {
  if (coreStatus === next) return;
  coreStatus = next;
  for (const listener of coreStatusListeners) listener(next);
}

/** Subscribe to transport-level core availability (not JSON-RPC app errors). */
export function subscribeCoreStatus(listener: CoreStatusListener): () => void {
  coreStatusListeners.add(listener);
  return () => coreStatusListeners.delete(listener);
}

export function currentCoreStatus(): CoreConnectionState {
  return coreStatus;
}

export async function rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
    });
  } catch (error) {
    publishCoreStatus("offline");
    throw error;
  }

  let envelope: {
    result?: T;
    error?: { message?: string; code?: number };
  };
  try {
    envelope = (await response.json()) as typeof envelope;
  } catch (error) {
    // A dead Vite proxy commonly returns an HTML 502/503 page. Treat an
    // unreadable response as transport failure so the UI can explain that
    // core is down instead of rendering a local Starter preview silently.
    publishCoreStatus("offline");
    throw error;
  }

  // JSON-RPC application errors still prove that core is reachable. Keep the
  // connection marked ready so a bad prompt/model does not look like a crash.
  // A non-2xx response, by contrast, usually comes from a dead Vite proxy and
  // should surface as an outage even when the body happens to be JSON.
  publishCoreStatus(response.ok ? "ready" : "offline");
  if (!response.ok || envelope.error) {
    throw new Error(envelope.error?.message ?? `RPC ${method} failed`);
  }
  return envelope.result as T;
}

/** Cumulative per-session token totals carried by `agent.usage` events. */
export type UsageTotals = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Prompt size of the latest model call = current context occupancy. */
  lastPromptTokens: number;
};

export type AgentEvent = {
  type: string;
  sessionId?: string;
  targetSessionId?: string;
  targetClientId?: string;
  projectSlug?: string;
  workspaceRoot?: string;
  delta?: string;
  tool?: string;
  /** Stable provider tool-call id used to pair start/finish events. */
  toolCallId?: string;
  /** Client-owned Enter-level group, when a producer already has one. */
  turnId?: string;
  /** Tool lifecycle timestamps (epoch milliseconds). */
  startedAtMs?: number;
  finishedAtMs?: number;
  arguments?: unknown;
  requestId?: string;
  result?: unknown;
  /** Sanitised file activity payload emitted by core tool completion. */
  activity?: {
    operation?: string;
    path?: string;
    before?: string;
    after?: string;
    beforeSnippet?: string;
    afterSnippet?: string;
    truncated?: boolean;
    replacements?: number;
    beforeBytes?: number;
    afterBytes?: number;
  };
  approved?: boolean;
  /** `agent.usage` events only. */
  usage?: UsageTotals;
  /** `agent.compacted` events only (mirrors the session_compact result). */
  compacted?: boolean;
  archivedMessages?: number;
  prunedToolResults?: number;
  estimatedTokensBefore?: number;
  estimatedTokensAfter?: number;
};

export function connectEvents(onEvent: (event: AgentEvent) => void): () => void {
  const source = new EventSource("/events");
  source.onopen = () => publishCoreStatus("ready");
  source.onerror = () => publishCoreStatus("offline");
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as AgentEvent);
    } catch {
      // Ignore malformed keepalive payloads.
    }
  };
  return () => source.close();
}
