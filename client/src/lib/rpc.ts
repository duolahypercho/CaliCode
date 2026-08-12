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
  // A late subscriber still needs the current transport state even when the
  // next response repeats it (publishCoreStatus intentionally de-duplicates).
  listener(coreStatus);
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

  // Read the body once. We try JSON first; a non-JSON response (e.g. an axum
  // 413 with a plain-text body, or a Vite proxy HTML error) used to throw
  // here and be mis-classified as a transport outage. Surfacing the HTTP
  // status plus the body text keeps the agent panel honest when core is
  // actually rejecting an over-sized payload.
  let envelope: {
    result?: T;
    error?: { message?: string; code?: number };
  };
  let rawBody = "";
  try {
    rawBody = await response.text();
    envelope = rawBody ? (JSON.parse(rawBody) as typeof envelope) : {};
  } catch (error) {
    // A non-JSON response. Treat 5xx gateway errors and explicit 404/502/503/504
    // as transport failures so the UI can explain that core is down, but keep
    // any other status reachable: the server may legitimately return a 4xx with
    // a plain-text body (e.g. core's plain-text 413 from a misconfigured proxy)
    // and we want the user to see the message, not a confusing outage banner.
    if (looksLikeTransportFailure(response)) {
      publishCoreStatus("offline");
    } else {
      publishCoreStatus("ready");
    }
    throw new Error(
      `RPC ${method} failed: HTTP ${response.status} ${response.statusText} — ${
        rawBody.trim() || (error instanceof Error ? error.message : String(error))
      }`,
    );
  }

  // A JSON-RPC envelope proves core answered. Even an application error
  // (bad method, model switch refused, body over the cap) means the
  // transport is up — marking it offline would mask real failures with a
  // misleading "core is down" banner.
  publishCoreStatus("ready");
  if (!response.ok || envelope.error) {
    throw new Error(envelope.error?.message ?? `RPC ${method} failed`);
  }
  return envelope.result as T;
}

/**
 * A non-JSON response is a transport failure only when the proxy is down
 * (502/503/504) or the route is gone (404). Anything else — including the
 * plain-text 413 axum emits when the body limit trips on a different layer —
 * is a server-side error the caller should see, not a transport outage.
 */
function looksLikeTransportFailure(response: Response): boolean {
  if (response.status === 404) return true;
  if (response.status === 502 || response.status === 503 || response.status === 504) return true;
  return false;
}

/** Cumulative per-session token totals carried by `agent.usage` events. */
export type UsageTotals = {
  /** Uncached input tokens accumulated across this session. */
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens: number;
  /** Prompt size of the latest model call = current context occupancy. */
  lastPromptTokens: number;
  /** Cached prefix tokens in the latest provider request. */
  lastCacheReadTokens?: number;
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
