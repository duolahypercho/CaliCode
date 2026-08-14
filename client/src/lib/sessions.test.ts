import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./rpc", () => ({ rpc: mocks.rpc }));

import { listSessions } from "./sessions";

beforeEach(() => mocks.rpc.mockReset());

describe("listSessions", () => {
  test("drops entries with no id", async () => {
    // What core returned for a non-session file in the sessions directory —
    // `usage.json`, the token ledger. It rendered as a blank sidebar row that
    // could not be opened, renamed or deleted, because every session RPC is
    // keyed by id.
    mocks.rpc.mockResolvedValue([
      { id: "session-1", title: "hi" },
      { id: null, title: null },
      { id: "   ", title: "" },
    ]);

    const sessions = await listSessions();
    expect(sessions.map((session) => session.id)).toEqual(["session-1"]);
  });

  test("survives a core that answers with nothing", async () => {
    mocks.rpc.mockResolvedValue(null);
    await expect(listSessions()).resolves.toEqual([]);
  });
});
