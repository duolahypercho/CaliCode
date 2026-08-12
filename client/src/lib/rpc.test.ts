import { afterEach, describe, expect, it, vi } from "vitest";
import { connectEvents, rpc, subscribeCoreStatus } from "./rpc";

describe("core transport status", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks core ready for a reachable JSON-RPC response", async () => {
    const states: string[] = [];
    const unsubscribe = subscribeCoreStatus((state) => states.push(state));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ result: { pong: true } }), { status: 200 })),
    );

    await expect(rpc("ping")).resolves.toEqual({ pong: true });
    expect(states.at(-1)).toBe("ready");
    unsubscribe();
  });

  it("marks core offline for a transport failure", async () => {
    const states: string[] = [];
    const unsubscribe = subscribeCoreStatus((state) => states.push(state));
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("failed to fetch"))));

    await expect(rpc("ping")).rejects.toThrow("failed to fetch");
    expect(states.at(-1)).toBe("offline");
    unsubscribe();
  });

  it("does not call an application error a core outage", async () => {
    const states: string[] = [];
    const unsubscribe = subscribeCoreStatus((state) => states.push(state));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "unknown method" } }), {
          status: 200,
        }),
      ),
    );

    await expect(rpc("missing")).rejects.toThrow("unknown method");
    expect(states.at(-1)).toBe("ready");
    unsubscribe();
  });

  it("surfaces a non-JSON 413 from an over-sized payload and stays ready", async () => {
    // Regression: a multi-frame editor_analyze_motion RPC used to trip axum's
    // 2 MB default body limit, return 413 with a plain-text body, and the
    // client called that a transport outage. The new server contract returns
    // a structured JSON-RPC error envelope, and even if a misconfigured proxy
    // ever sends a plain-text 4xx, the client should show the body text and
    // keep core marked ready.
    const states: string[] = [];
    const unsubscribe = subscribeCoreStatus((state) => states.push(state));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("Failed to buffer the request body: length limit exceeded", {
          status: 413,
        }),
      ),
    );

    await expect(rpc("video_contact_sheet", { frames: [] })).rejects.toThrow(
      /HTTP 413.*length limit exceeded/s,
    );
    expect(states.at(-1)).toBe("ready");
    unsubscribe();
  });

  it("parses a structured JSON-RPC body-too-large error envelope", async () => {
    const states: string[] = [];
    const unsubscribe = subscribeCoreStatus((state) => states.push(state));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "motion-1",
            error: { code: -32001, message: "request body exceeds the 96 MB RPC limit" },
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(rpc("video_contact_sheet", { frames: [] })).rejects.toThrow(
      "request body exceeds the 96 MB RPC limit",
    );
    expect(states.at(-1)).toBe("ready");
    unsubscribe();
  });

  it("marks a 502 from the proxy as a transport outage", async () => {
    const states: string[] = [];
    const unsubscribe = subscribeCoreStatus((state) => states.push(state));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>502 Bad Gateway</html>", { status: 502 })),
    );

    await expect(rpc("ping")).rejects.toThrow(/HTTP 502/);
    expect(states.at(-1)).toBe("offline");
    unsubscribe();
  });

  it("marks a 503 from the proxy as a transport outage", async () => {
    const states: string[] = [];
    const unsubscribe = subscribeCoreStatus((state) => states.push(state));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Service Unavailable", { status: 503 })),
    );

    await expect(rpc("ping")).rejects.toThrow(/HTTP 503/);
    expect(states.at(-1)).toBe("offline");
    unsubscribe();
  });

  it("marks the SSE connection ready and offline as it opens and drops", () => {
    const states: string[] = [];
    const unsubscribe = subscribeCoreStatus((state) => states.push(state));
    const source = {
      onopen: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onmessage: null,
      close: vi.fn(),
    };
    vi.stubGlobal(
      "EventSource",
      vi.fn(() => source),
    );

    const disconnect = connectEvents(() => {});
    source.onerror?.();
    source.onopen?.();
    disconnect();
    expect(states.slice(-2)).toEqual(["offline", "ready"]);
    unsubscribe();
  });
});
