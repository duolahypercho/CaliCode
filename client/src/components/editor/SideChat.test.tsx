import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SideChat, type SideChatDraft, type SideMessage } from "./SideChat";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  /** Set by the component's connectEvents subscription; the tests drive it. */
  emit: { current: null as ((event: unknown) => void) | null },
}));

vi.mock("../../lib/rpc", () => ({
  rpc: mocks.rpc,
  connectEvents: (onEvent: (event: unknown) => void) => {
    mocks.emit.current = onEvent;
    return () => {
      mocks.emit.current = null;
    };
  },
}));

const mainTranscript = [
  { role: "user", content: "make the player jump" },
  { role: "assistant", content: "Editing the controller." },
  { role: "tool", content: "error: cannot find Jump.ts", tool: "edit_file" },
];

const modelList = {
  active: { provider: "openai", model: "gpt-5.6", baseUrl: "https://example.test/v1" },
  providers: [{ id: "openai", label: "OpenAI", base_url: "https://example.test/v1", api_key_env: "K", models: ["gpt-5.6", "gpt-5.6-mini"] }],
};

function renderSideChat(onClose = () => {}, draft?: SideChatDraft) {
  return render(
    <SideChat
      projectSlug="demo"
      mainTranscript={mainTranscript}
      modelList={modelList}
      draft={draft}
      onClose={onClose}
    />,
  );
}

function ask(question: string) {
  fireEvent.change(screen.getByLabelText("Side chat prompt"), { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: "Send side chat message" }));
}

type AdvisorParams = {
  messages: Array<{ role: string; content: string }>;
  transcript: string;
  projectSlug: string;
};

function paramsOf(call: number): AdvisorParams {
  return mocks.rpc.mock.calls[call][1] as AdvisorParams;
}

beforeEach(() => {
  HTMLElement.prototype.scrollTo = vi.fn();
  mocks.rpc.mockReset();
  mocks.rpc.mockResolvedValue({ reply: "It is retrying the edit." });
});

afterEach(cleanup);

describe("SideChat", () => {
  it("sends the typed question and renders the reply", async () => {
    renderSideChat();
    ask("what is it doing?");

    await waitFor(() => expect(screen.getByText("It is retrying the edit.")).toBeTruthy());
    expect(screen.getByText("what is it doing?")).toBeTruthy();
    expect(mocks.rpc).toHaveBeenCalledWith(
      "advisor_chat",
      expect.objectContaining({ projectSlug: "demo" }),
      expect.anything(),
    );
  });

  it("passes its own history plus an excerpt of the main transcript", async () => {
    renderSideChat();
    ask("what is it doing?");
    await waitFor(() => expect(screen.getByText("It is retrying the edit.")).toBeTruthy());

    mocks.rpc.mockResolvedValue({ reply: "Because the file is missing." });
    ask("why did it fail?");
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));

    expect(paramsOf(1).messages).toEqual([
      { role: "user", content: "what is it doing?" },
      { role: "assistant", content: "It is retrying the edit." },
      { role: "user", content: "why did it fail?" },
    ]);
    // The excerpt keeps the newest main-transcript entries and labels them by
    // role so the advisor can tell a claim from a tool result.
    const { transcript } = paramsOf(1);
    expect(transcript).toContain("error: cannot find Jump.ts");
    expect(transcript).toContain("tool(edit_file)");
  });

  it("never calls an RPC other than advisor_chat", async () => {
    renderSideChat();
    ask("what is it doing?");
    await waitFor(() => expect(screen.getByText("It is retrying the edit.")).toBeTruthy());
    ask("and now?");
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));

    const methods = mocks.rpc.mock.calls.map(([method]) => method as string);
    expect(methods.every((method) => method === "advisor_chat")).toBe(true);
    expect(methods).not.toContain("agent_chat");
    expect(methods).not.toContain("session_save");
  });

  it("renders a failure in the thread and leaves the composer usable", async () => {
    mocks.rpc.mockRejectedValueOnce(new Error("advisor is offline"));
    renderSideChat();
    ask("what is it doing?");

    const failure = await screen.findByText(/advisor is offline/);
    expect(failure.className).toContain("text-danger-soft");

    const composer = screen.getByLabelText("Side chat prompt") as HTMLTextAreaElement;
    expect(composer.disabled).toBe(false);

    mocks.rpc.mockResolvedValue({ reply: "Recovered." });
    ask("try again");
    await waitFor(() => expect(screen.getByText("Recovered.")).toBeTruthy());
    // The error line is local, so it must not be replayed as advisor history.
    expect(paramsOf(1).messages).toEqual([
      { role: "user", content: "what is it doing?" },
      { role: "user", content: "try again" },
    ]);
  });

  it("waits with a /side draft in the composer instead of asking it", async () => {
    renderSideChat(() => {}, { text: "why did that edit fail?", nonce: 1 });

    const composer = (await screen.findByLabelText("Side chat prompt")) as HTMLTextAreaElement;
    await waitFor(() => expect(composer.value).toBe("why did that edit fail?"));
    expect(mocks.rpc).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Send side chat message" }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));
  });

  it("appends a /side draft below unsent text instead of overwriting it", async () => {
    const { rerender } = render(
      <SideChat projectSlug="demo" mainTranscript={mainTranscript} modelList={modelList} onClose={() => {}} />,
    );
    const composer = screen.getByLabelText("Side chat prompt") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "half a question" } });

    rerender(
      <SideChat
        projectSlug="demo"
        mainTranscript={mainTranscript}
        modelList={modelList}
        draft={{ text: "why did that edit fail?", nonce: 1 }}
        onClose={() => {}}
      />,
    );

    await waitFor(() => expect(composer.value).toBe("half a question\nwhy did that edit fail?"));
  });

  it("shows the answer as it streams, then settles on the returned reply", async () => {
    const pending: { settle?: (value: { reply: string }) => void } = {};
    mocks.rpc.mockImplementationOnce(() => new Promise<{ reply: string }>((resolve) => (pending.settle = resolve)));
    renderSideChat();
    ask("what is it doing?");

    const streamId = (paramsOf(0) as unknown as { streamId: string }).streamId;
    expect(streamId).toBeTruthy();

    mocks.emit.current?.({ type: "advisor.delta", streamId, delta: "It is " });
    mocks.emit.current?.({ type: "advisor.delta", streamId, delta: "retrying." });
    await waitFor(() => expect(document.querySelector("[data-role='streaming']")?.textContent).toBe("It is retrying."));

    pending.settle?.({ reply: "It is retrying the edit." });
    // The settled reply replaces the live text rather than joining it.
    await waitFor(() => expect(screen.getByText("It is retrying the edit.")).toBeTruthy());
    expect(document.querySelector("[data-role='streaming']")).toBeNull();
    expect(screen.queryByText("It is retrying.")).toBeNull();
  });

  it("shows what it read while the answer is in flight", async () => {
    const pending: { settle?: (value: { reply: string }) => void } = {};
    mocks.rpc.mockImplementationOnce(() => new Promise<{ reply: string }>((resolve) => (pending.settle = resolve)));
    renderSideChat();
    ask("what hp does the hero start with?");

    const streamId = (paramsOf(0) as unknown as { streamId: string }).streamId;
    mocks.emit.current?.({ type: "advisor.tool", streamId, tool: "file_read", detail: "hero.js" });
    await waitFor(() =>
      expect(document.querySelector("[data-role='reads']")?.textContent).toContain("file_read hero.js"),
    );

    pending.settle?.({ reply: "hp starts at 3." });
    // The reads belong to the question in flight, not to the thread.
    await waitFor(() => expect(screen.getByText("hp starts at 3.")).toBeTruthy());
    expect(document.querySelector("[data-role='reads']")).toBeNull();
  });

  it("ignores deltas addressed at another question", async () => {
    const pending: { settle?: (value: { reply: string }) => void } = {};
    mocks.rpc.mockImplementationOnce(() => new Promise<{ reply: string }>((resolve) => (pending.settle = resolve)));
    renderSideChat();
    ask("what is it doing?");

    mocks.emit.current?.({ type: "advisor.delta", streamId: "a-stopped-question", delta: "stale text" });
    mocks.emit.current?.({ type: "agent.delta", sessionId: "the-run", delta: "the run's own text" });
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));

    expect(document.querySelector("[data-role='streaming']")).toBeNull();
    expect(screen.queryByText(/stale text|the run's own text/)).toBeNull();
    pending.settle?.({ reply: "done" });
  });

  it("pins the step a question was anchored to and sends it alongside", async () => {
    renderSideChat(() => {}, {
      text: "",
      nonce: 1,
      anchor: { label: "Ran run_tests", detail: "3 failed: Jump.test.ts" },
    });

    const pinned = await waitFor(() => {
      const node = document.querySelector("[data-side-anchor]");
      expect(node).toBeTruthy();
      return node!;
    });
    expect(pinned.textContent).toContain("Ran run_tests");

    ask("why?");
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));
    // The question stays the operator's words; the step rides separately.
    expect(paramsOf(0).messages).toEqual([{ role: "user", content: "why?" }]);
    expect(paramsOf(0)).toMatchObject({ anchor: "Ran run_tests\n3 failed: Jump.test.ts" });
  });

  it("drops the anchor when the subject changes", async () => {
    renderSideChat(() => {}, { text: "", nonce: 1, anchor: { label: "Ran run_tests" } });
    await waitFor(() => expect(document.querySelector("[data-side-anchor]")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Stop asking about this step" }));
    expect(document.querySelector("[data-side-anchor]")).toBeNull();

    ask("and generally?");
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));
    expect(paramsOf(0)).not.toHaveProperty("anchor");
  });

  it("says so when the run is longer than the excerpt it can read", async () => {
    const long = Array.from({ length: 40 }, (_, index) => ({
      role: "assistant",
      content: `step ${index} ${"detail ".repeat(60)}`,
    }));
    render(<SideChat projectSlug="demo" mainTranscript={long} modelList={modelList} onClose={() => {}} />);

    const notice = document.querySelector("[data-transcript-window]");
    expect(notice?.textContent).toMatch(/Reading the last \d+ of 40 messages/);
  });

  it("shows no truncation notice when the whole run fits", () => {
    renderSideChat();
    expect(document.querySelector("[data-transcript-window]")).toBeNull();
  });

  it("falls back to the run's model when a remembered pick has left the catalog", async () => {
    localStorage.setItem("calicode-sidechat-model", "retired:ghost-model");
    try {
      renderSideChat();
      ask("what is it doing?");
      await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));
      expect(paramsOf(0)).toMatchObject({ provider: "openai", model: "gpt-5.6" });
    } finally {
      localStorage.removeItem("calicode-sidechat-model");
    }
  });

  it("renders the advisor's markdown the way the agent panel does", async () => {
    mocks.rpc.mockResolvedValue({ reply: "It failed in **Jump.ts** at `applyImpulse`." });
    renderSideChat();
    ask("why?");

    const bold = await screen.findByText("Jump.ts");
    expect(bold.tagName).toBe("STRONG");
    expect(screen.getByText("applyImpulse").tagName).toBe("CODE");
  });

  it("asks with its own model pick, which never switches the run's model", async () => {
    renderSideChat();
    ask("what is it doing?");
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));

    // Defaults to whatever the run is on, but carries it as a per-call
    // override rather than calling model_switch.
    expect(paramsOf(0)).toMatchObject({ provider: "openai", model: "gpt-5.6" });
    expect(mocks.rpc.mock.calls.map(([method]) => method)).not.toContain("model_switch");
  });

  it("runs its own commands and never the agent panel's", async () => {
    renderSideChat();
    ask("what is it doing?");
    await waitFor(() => expect(screen.getByText("It is retrying the edit.")).toBeTruthy());

    ask("/clear");
    await waitFor(() => expect(screen.queryByText("It is retrying the edit.")).toBeNull());

    // /loop belongs to the panel that can act; here it is simply unknown.
    ask("/loop ship the game");
    expect(await screen.findByText(/Unknown command \/loop/)).toBeTruthy();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("stops an in-flight answer without stranding the composer", async () => {
    let rejectCall: ((reason: Error) => void) | null = null;
    mocks.rpc.mockImplementationOnce(
      (_method: string, _params: unknown, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          rejectCall = reject;
          options.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    renderSideChat();
    ask("what is it doing?");

    const stop = await screen.findByRole("button", { name: "Stop side chat answer" });
    fireEvent.click(stop);

    expect(await screen.findByText(/Stopped\./)).toBeTruthy();
    expect(rejectCall).not.toBeNull();
    expect(screen.getByRole("button", { name: "Send side chat message" })).toBeTruthy();
  });

  it("sends on Enter and inserts a newline on Shift+Enter", async () => {
    renderSideChat();
    const composer = screen.getByLabelText("Side chat prompt");

    fireEvent.change(composer, { target: { value: "first line" } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: true });
    expect(mocks.rpc).not.toHaveBeenCalled();

    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));
    expect(paramsOf(0).messages).toEqual([{ role: "user", content: "first line" }]);
  });
});

describe("SideChat thread ownership", () => {
  it("hands the thread to its parent so closing the tab does not discard it", async () => {
    const thread: SideMessage[] = [];
    const onMessagesChange = vi.fn((next: SideMessage[]) => thread.splice(0, thread.length, ...next));

    const { unmount } = render(
      <SideChat
        projectSlug="demo"
        mainTranscript={mainTranscript}
        modelList={modelList}
        messages={thread}
        onMessagesChange={onMessagesChange}
        onClose={() => {}}
      />,
    );
    ask("what is it doing?");
    await waitFor(() => expect(thread.some((m) => m.content === "It is retrying the edit.")).toBe(true));

    // Closing the tab unmounts the panel; the parent still holds the thread,
    // and remounting shows it again.
    unmount();
    render(
      <SideChat
        projectSlug="demo"
        mainTranscript={mainTranscript}
        modelList={modelList}
        messages={thread}
        onMessagesChange={onMessagesChange}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("It is retrying the edit.")).toBeTruthy();
    expect(screen.getByText("what is it doing?")).toBeTruthy();
  });
});
