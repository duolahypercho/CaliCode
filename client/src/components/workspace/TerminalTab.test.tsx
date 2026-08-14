import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalTab } from "./TerminalTab";
import type { AgentEvent } from "../../lib/rpc";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  connectEvents: vi.fn(),
  /** Keystroke handler xterm would call; the test drives typing through it. */
  onData: null as ((data: string) => void) | null,
  write: vi.fn(),
  dispose: vi.fn(),
  fit: vi.fn(),
}));

vi.mock("../../lib/rpc", () => ({ rpc: mocks.rpc, connectEvents: mocks.connectEvents }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

vi.mock("@xterm/xterm", () => ({
  // xterm draws to a canvas jsdom cannot provide, so the surface it exposes to
  // this component is stubbed instead.
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    loadAddon = vi.fn();
    open = vi.fn();
    focus = vi.fn();
    write = mocks.write;
    dispose = mocks.dispose;
    onData(handler: (data: string) => void) {
      mocks.onData = handler;
      return { dispose: vi.fn() };
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = mocks.fit;
  },
}));

let emit: ((event: AgentEvent) => void) | null = null;

beforeEach(() => {
  for (const key of ["rpc", "connectEvents", "write", "dispose", "fit"] as const) mocks[key].mockReset();
  mocks.onData = null;
  emit = null;
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // Models the real transport: the stream connects asynchronously and only
  // then is the caller allowed to start a producer.
  mocks.connectEvents.mockImplementation((handler: (event: AgentEvent) => void, onOpen?: () => void) => {
    emit = handler;
    setTimeout(() => onOpen?.(), 0);
    return () => {
      emit = null;
    };
  });
  mocks.rpc.mockImplementation(async (method: string) => {
    if (method === "terminal_open") return { sessionId: "pty-1", cwd: "/tmp/game", shell: "/bin/zsh" };
    return {};
  });
});

afterEach(cleanup);

async function renderTerminal() {
  const view = render(<TerminalTab projectSlug="demo" />);
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith("terminal_open", expect.anything()));
  return view;
}

describe("TerminalTab", () => {
  it("opens a persistent shell sized to the rendered grid", async () => {
    await renderTerminal();

    expect(mocks.rpc).toHaveBeenCalledWith("terminal_open", { projectSlug: "demo", cols: 80, rows: 24 });
    await waitFor(() => expect(screen.getByText("/tmp/game")).toBeTruthy());
  });

  it("never opens the shell before the event stream is live", async () => {
    // The bus has no replay and core emits the prompt ~10ms after open, so a
    // session started first loses its prompt and the pane looks dead.
    let openStream: (() => void) | undefined;
    mocks.connectEvents.mockImplementation((handler: (event: AgentEvent) => void, onOpen?: () => void) => {
      emit = handler;
      openStream = onOpen;
      return () => {};
    });
    render(<TerminalTab projectSlug="demo" />);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.rpc).not.toHaveBeenCalledWith("terminal_open", expect.anything());

    await act(async () => {
      openStream?.();
    });
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith("terminal_open", expect.anything()));
  });

  it("opens only one shell when the stream reconnects", async () => {
    let openStream: (() => void) | undefined;
    mocks.connectEvents.mockImplementation((handler: (event: AgentEvent) => void, onOpen?: () => void) => {
      emit = handler;
      openStream = onOpen;
      setTimeout(() => onOpen?.(), 0);
      return () => {};
    });
    render(<TerminalTab projectSlug="demo" />);
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith("terminal_open", expect.anything()));

    await act(async () => {
      openStream?.();
      openStream?.();
    });
    const opens = mocks.rpc.mock.calls.filter(([method]) => method === "terminal_open");
    expect(opens).toHaveLength(1);
  });

  it("writes the PTY stream through verbatim, escape sequences included", async () => {
    await renderTerminal();
    await act(async () => {
      emit?.({ type: "terminal.data", sessionId: "pty-1", data: "[32mok[0m\r\n" });
    });

    // Colour must survive to xterm; stripping it here is what made the old
    // command runner look nothing like a terminal.
    expect(mocks.write).toHaveBeenCalledWith("[32mok[0m\r\n");
  });

  it("ignores output belonging to another session", async () => {
    await renderTerminal();
    await act(async () => {
      emit?.({ type: "terminal.data", sessionId: "pty-other", data: "not mine" });
    });

    expect(mocks.write).not.toHaveBeenCalledWith("not mine");
  });

  it("sends keystrokes to the PTY unmodified", async () => {
    await renderTerminal();
    await act(async () => {
      // Ctrl-C: the control byte has to reach the shell as-is.
      mocks.onData?.("");
    });

    expect(mocks.rpc).toHaveBeenCalledWith("terminal_input", { sessionId: "pty-1", data: "" });
  });

  it("closes the shell when the tab unmounts, so no orphan survives", async () => {
    const { unmount } = await renderTerminal();
    unmount();

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith("terminal_close", { sessionId: "pty-1" }));
    expect(mocks.dispose).toHaveBeenCalled();
  });

  it("reports a shell that exits on its own instead of looking alive", async () => {
    await renderTerminal();
    await act(async () => {
      emit?.({ type: "terminal.closed", sessionId: "pty-1", code: 0 });
    });

    expect(screen.getByText(/session ended/)).toBeTruthy();
  });

  it("explains a refused workspace instead of silently starting somewhere else", async () => {
    // macOS withholds Desktop/Documents from unsigned binaries, and a shell
    // started there blocks in getcwd() forever, so core falls back. The user
    // has to be told, or the terminal silently runs in the wrong directory.
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === "terminal_open") {
        return {
          sessionId: "pty-1",
          cwd: "/Users/dev",
          shell: "/bin/zsh",
          cwdFallbackFrom: "/Users/dev/Desktop/game",
        };
      }
      return {};
    });
    render(<TerminalTab projectSlug="demo" />);

    await waitFor(() => expect(screen.getByText(/CaliCode cannot read/)).toBeTruthy());
    expect(screen.getByText(/\/Users\/dev\/Desktop\/game/)).toBeTruthy();
  });

  it("surfaces a failure to open rather than showing an empty black box", async () => {
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === "terminal_open") throw new Error("no shell available");
      return {};
    });
    render(<TerminalTab projectSlug="demo" />);

    await waitFor(() => expect(screen.getByText(/no shell available/)).toBeTruthy());
  });
});
