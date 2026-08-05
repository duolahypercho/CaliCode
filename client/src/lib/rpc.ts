export async function rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch("/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
  });
  const envelope = (await response.json()) as {
    result?: T;
    error?: { message?: string; code?: number };
  };
  if (!response.ok || envelope.error) {
    throw new Error(envelope.error?.message ?? `RPC ${method} failed`);
  }
  return envelope.result as T;
}

export type AgentEvent = {
  type: string;
  sessionId?: string;
  delta?: string;
  tool?: string;
  arguments?: unknown;
  requestId?: string;
  result?: unknown;
  approved?: boolean;
};

export function connectEvents(onEvent: (event: AgentEvent) => void): () => void {
  const source = new EventSource("/events");
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as AgentEvent);
    } catch {
      // Ignore malformed keepalive payloads.
    }
  };
  return () => source.close();
}

