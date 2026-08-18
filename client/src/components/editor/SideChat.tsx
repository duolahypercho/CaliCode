import { useEffect, useRef, useState } from "react";
import { ArrowUp, BookOpen, Crosshair, Eye, MessageCirclePlus, Square, X } from "lucide-react";
import { Textarea } from "../ui/textarea";
import { AgentText } from "./AgentText";
import { ModelPicker, buildModelChoices } from "./ModelPicker";
import { SlashMenu } from "./SlashMenu";
import { buildTranscriptWindow } from "../../lib/transcript";
import { completeSlashToken, matchCommandsIn, parseSlashIn, type NamedCommand } from "../../lib/slashCommands";
import { defaultEffort, effortLevelsFor, loadModelDev, type EffortIndex } from "../../lib/modelMeta";
import { connectEvents, rpc } from "../../lib/rpc";
import type { ModelList } from "../../lib/types";

/**
 * The step a question was opened from — "ask about *this*".
 *
 * Kept beside the question rather than pasted into it: the operator's message
 * stays their own words, and core frames the step separately so an answer
 * cannot drift to a different failure further up the run.
 */
export interface SideChatAnchor {
  /** One line naming the step, e.g. `Ran run_tests`. */
  label: string;
  /** The step's output, already trimmed by the caller. */
  detail?: string;
}

export interface SideChatDraft {
  text: string;
  /** Bumped per `/side` so the same question can be re-sent into the composer. */
  nonce: number;
  anchor?: SideChatAnchor;
}

export interface SideChatProps {
  projectSlug: string;
  /**
   * What this thread is called. More than one side chat can be open, so the
   * name disambiguates their controls; the first keeps the bare "Side chat"
   * names the dock and the e2e specs address it by.
   */
  name?: string;
  /** Read-only snapshot of the main transcript, newest last. */
  mainTranscript: Array<{ role: string; content: string; tool?: string }>;
  /** Model catalog, shared with the agent composer's picker. */
  modelList?: ModelList | null;
  /** Text to drop into the composer unsent — how `/side <question>` arrives. */
  draft?: SideChatDraft | null;
  /**
   * The thread, owned by the parent so closing the tab does not throw the
   * conversation away. Still memory-only: nothing about a side chat is
   * written to disk or to the run's session.
   */
  messages?: SideMessage[];
  onMessagesChange?: (messages: SideMessage[]) => void;
  onClose: () => void;
}

export interface SideMessage {
  role: "user" | "assistant";
  content: string;
  /** A local failure line. Never replayed to core: it is not a model reply. */
  failed?: boolean;
}

/** Core applies a larger final ceiling; this keeps the normal request cheap. */
const TRANSCRIPT_CHARS = 8000;

/** The side chat's own model pick, which never moves the run's active model. */
const MODEL_STORAGE_KEY = "calicode-sidechat-model";
/** Shared with the agent composer: effort is a property of a model, not a panel. */
const EFFORT_STORAGE_KEY = "calicode-model-effort-map";

const EXAMPLES = ["What is it doing right now?", "Why did that last edit fail?"];

const readStoredEfforts = (): Record<string, string> => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(EFFORT_STORAGE_KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(([, value]) => typeof value === "string"),
    ) as Record<string, string>;
  } catch {
    return {};
  }
};

const readStoredModel = (): string => {
  try {
    return localStorage.getItem(MODEL_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
};

interface SideContext {
  say: (content: string) => void;
  clear: () => void;
  setModel: (raw: string) => void;
  close: () => void;
}

interface SideCommand extends NamedCommand {
  run: (args: string, ctx: SideContext) => void;
}

/**
 * The side chat's own commands. Deliberately not the agent panel's set: every
 * command there — /loop, /spawn, /restore — acts on the run this panel exists
 * to observe without touching.
 */
const SIDE_COMMANDS: readonly SideCommand[] = [
  {
    name: "help",
    summary: "List side chat commands",
    run: (_args, ctx) =>
      ctx.say(
        [
          "Side chat commands:",
          ...SIDE_COMMANDS.map(
            (command) => `/${command.name}${command.usage ? ` ${command.usage}` : ""} — ${command.summary}`,
          ),
          "",
          "This thread is read-only: it can read the transcript and this game's files, and cannot change anything or reach the agent.",
        ].join("\n"),
      ),
  },
  {
    name: "model",
    summary: "Switch the model answering here (not the run's)",
    usage: "<provider>:<model>",
    run: (args, ctx) => {
      if (!args.trim()) {
        ctx.say("Usage: /model <provider>:<model> — applies to this side chat only.");
        return;
      }
      ctx.setModel(args.trim());
    },
  },
  {
    name: "clear",
    summary: "Clear this side thread",
    run: (_args, ctx) => ctx.clear(),
  },
  {
    name: "close",
    summary: "Close the side chat",
    run: (_args, ctx) => ctx.close(),
  },
];

/**
 * An observer beside the main agent panel. It answers questions *about* a run
 * through `advisor_chat`, which core executes with no tools and never writes to
 * the session store — so this component must never call an RPC that could act
 * on the project or append to the main transcript.
 *
 * The composer is the agent composer's twin — same lockup, same slash menu,
 * same model-and-effort picker, same stop button — because an operator who has
 * learned one should not have to learn the other. The one deliberate
 * difference is the model: picking one here overrides this endpoint's model for
 * this call only, rather than calling `model_switch`, which would move the
 * model the observed run uses next.
 */
export function SideChat({
  projectSlug,
  name = "Side chat",
  mainTranscript,
  modelList,
  draft,
  messages: controlledMessages,
  onMessagesChange,
  onClose,
}: SideChatProps): JSX.Element {
  // Controlled when the parent holds the thread, local otherwise, so the panel
  // still stands alone in tests and anywhere the thread is not worth keeping.
  const [localMessages, setLocalMessages] = useState<SideMessage[]>([]);
  const messages = controlledMessages ?? localMessages;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const setMessages = (next: SideMessage[] | ((current: SideMessage[]) => SideMessage[])) => {
    const resolved = typeof next === "function" ? next(messagesRef.current) : next;
    messagesRef.current = resolved;
    if (onMessagesChange) onMessagesChange(resolved);
    else setLocalMessages(resolved);
  };
  const [input, setInput] = useState("");
  // Caret offset, so the slash menu can key off the token under the caret
  // rather than only a message that starts with one.
  const [caret, setCaret] = useState(0);
  const [busy, setBusy] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [effortByModel, setEffortByModel] = useState<Record<string, string>>(readStoredEfforts);
  const [effortIndex, setEffortIndex] = useState<EffortIndex | null>(null);
  const [registryCatalog, setRegistryCatalog] = useState<Record<string, string[]> | null>(null);
  const [modelChoice, setModelChoice] = useState<string>(readStoredModel);
  // The step this question is about, if it was opened from one.
  const [anchor, setAnchor] = useState<SideChatAnchor | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** Nonce of the draft already in the composer; see the effect below. */
  const appliedDraftRef = useRef<number | null>(null);
  const stickToEndRef = useRef(true);
  // The in-flight advisor call, so Stop can abandon it the way the agent
  // composer abandons a turn.
  const abortRef = useRef<AbortController | null>(null);
  // The answer as it arrives. Held apart from `messages` so the settled reply
  // from the RPC — not the accumulated deltas — is what enters the history
  // core replays, and a dropped delta cannot corrupt the thread.
  const [streaming, setStreaming] = useState("");
  // Files the advisor opened while answering the question in flight. Shown so
  // a pause is legible as work rather than as a stall, and so the operator can
  // see exactly what was read to produce the answer.
  const [reads, setReads] = useState<string[]>([]);
  const streamRef = useRef<string | null>(null);

  useEffect(() => {
    return connectEvents((event) => {
      if (!event.streamId || event.streamId !== streamRef.current) return;
      if (event.type === "advisor.delta") {
        setStreaming((current) => current + (event.delta ?? ""));
        return;
      }
      if (event.type === "advisor.tool" && event.tool) {
        const label = event.detail ? `${event.tool} ${event.detail}` : event.tool;
        setReads((current) => (current.includes(label) ? current : [...current, label]));
      }
    });
  }, []);

  const handleScroll = () => {
    const el = threadRef.current;
    if (!el) return;
    stickToEndRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  useEffect(() => {
    if (stickToEndRef.current) threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [messages, busy, streaming, reads]);

  useEffect(() => {
    void loadModelDev().then((data) => {
      setEffortIndex(data.index);
      setRegistryCatalog(data.catalog);
    });
  }, []);

  // `/side <question>` lands here: the text waits in the composer so it can be
  // edited or discarded. Sending it on arrival would make the command a way to
  // ask a question rather than a way to open the panel.
  useEffect(() => {
    if (!draft) return;
    // Each draft lands exactly once. The text is appended, not assigned, so a
    // second delivery of the same one — a remount, or StrictMode running this
    // effect twice — would leave the question in the composer twice.
    if (appliedDraftRef.current === draft.nonce) return;
    appliedDraftRef.current = draft.nonce;
    // A step arrives pinned rather than typed, so it survives editing the
    // question and is dropped in one click when the subject changes.
    if (draft.anchor) setAnchor(draft.anchor);
    // Unsent text already in the composer is the operator's, not ours: append
    // below it rather than overwrite a half-typed question.
    if (draft.text) {
      setInput((current) => {
        const kept = current.trimEnd();
        return kept ? `${kept}\n${draft.text}` : draft.text;
      });
    }
    // Focus even with no text: opening the panel is what puts the caret here,
    // so the next thing typed is the question.
    window.requestAnimationFrame(() => {
      const field = inputRef.current;
      if (!field) return;
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
      setCaret(field.value.length);
    });
  }, [draft?.nonce, draft?.text]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const modelChoices = buildModelChoices(modelList ?? null, registryCatalog);
  const runModel = modelList ? `${modelList.active.provider}:${modelList.active.model}` : "";
  // A remembered pick whose provider has since left the config would make
  // every question fail with "unknown provider" until it was changed by hand.
  // Fall back to the run's model instead; the picker shows which one is live,
  // so nothing is hidden. Only judged once the catalog has actually loaded.
  const pickIsStale =
    Boolean(modelChoice) && modelChoices.length > 0 && !modelChoices.some((c) => c.value === modelChoice);
  const activeValue = (pickIsStale ? "" : modelChoice) || runModel;
  const [activeProvider, ...modelParts] = activeValue.split(":");
  const activeModelId = modelParts.join(":");
  const effortFor = (modelId: string): string | null => {
    const levels = effortLevelsFor(effortIndex, modelId);
    if (levels.length === 0) return null;
    const chosen = effortByModel[modelId];
    return chosen && levels.includes(chosen) ? chosen : defaultEffort(levels);
  };
  const effort = effortFor(activeModelId) ?? undefined;

  const selectEffort = (modelId: string, value: string) => {
    setEffortByModel((current) => {
      const next = { ...current, [modelId]: value };
      try {
        localStorage.setItem(EFFORT_STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* best effort */
      }
      return next;
    });
  };

  const say = (content: string) => setMessages((current) => [...current, { role: "assistant", content }]);

  const chooseModel = (value: string) => {
    setModelChoice(value);
    try {
      localStorage.setItem(MODEL_STORAGE_KEY, value);
    } catch {
      /* the pick is a preference, not a requirement */
    }
  };

  const sideContext: SideContext = {
    say,
    clear: () => setMessages([]),
    setModel: (raw) => {
      const known = modelChoices.find(
        (choice) => choice.value === raw || (choice.label === raw && !raw.includes(":")),
      );
      if (!known) {
        say(`No model "${raw}" in the catalog. Pick one from the model menu, or use <provider>:<model>.`);
        return;
      }
      chooseModel(known.value);
      say(`This side chat now answers with ${known.label}. The run's model is unchanged.`);
    },
    close: onClose,
  };

  // What the advisor will actually be given. Recomputed per render so the
  // notice below the thread tracks a run that is still growing.
  const transcriptWindow = buildTranscriptWindow(mainTranscript, TRANSCRIPT_CHARS);

  const commandMenu = matchCommandsIn(input, SIDE_COMMANDS, caret);
  const menuActive = commandMenu.length > 0;
  const activeMenuIndex = Math.min(menuIndex, commandMenu.length - 1);
  const completeCommand = (name: string) => {
    const completed = completeSlashToken(input, caret, name);
    setInput(completed.text);
    setCaret(completed.caret);
    setMenuIndex(0);
    window.requestAnimationFrame(() => {
      const field = inputRef.current;
      if (!field) return;
      field.focus();
      field.setSelectionRange(completed.caret, completed.caret);
    });
  };

  const ask = async (question: string) => {
    const asked: SideMessage = { role: "user", content: question };
    const history = [...messages, asked];
    setMessages(history);
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    // One id per question. Core addresses this answer's deltas at it, so a
    // stale stream from a stopped question cannot type into the next one.
    const streamId = crypto.randomUUID();
    streamRef.current = streamId;
    setStreaming("");
    setReads([]);
    try {
      const result = await rpc<{ reply: string }>(
        "advisor_chat",
        {
          messages: history
            .filter((message) => !message.failed)
            .map(({ role, content }) => ({ role, content })),
          transcript: transcriptWindow.text,
          projectSlug,
          streamId,
          ...(anchor ? { anchor: [anchor.label, anchor.detail].filter(Boolean).join("\n") } : {}),
          ...(activeModelId ? { provider: activeProvider, model: activeModelId } : {}),
          ...(effort ? { effort } : {}),
        },
        { signal: controller.signal },
      );
      const reply = result?.reply?.trim();
      setMessages((current) => [...current, { role: "assistant", content: reply || "No answer came back." }]);
    } catch (error) {
      const stopped = controller.signal.aborted;
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: stopped
            ? "Stopped. The question was not answered."
            : `Could not answer: ${error instanceof Error ? error.message : String(error)}`,
          failed: true,
        },
      ]);
    } finally {
      abortRef.current = null;
      // Drop the live text in the same commit as the settled message, or the
      // answer would appear twice for a frame.
      streamRef.current = null;
      setStreaming("");
      setReads([]);
      // A stuck composer would strand the panel with no way out but closing it.
      setBusy(false);
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setCaret(0);
    setMenuIndex(0);
    const parsed = parseSlashIn(text, SIDE_COMMANDS);
    if (parsed) {
      if (!parsed.command) {
        say(`Unknown command /${parsed.name}. Type /help for the list.`);
        return;
      }
      parsed.command.run(parsed.args, sideContext);
      return;
    }
    await ask(text);
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-surface-0">
      <div
        ref={threadRef}
        onScroll={handleScroll}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3 text-[13px]"
      >
        {messages.length === 0 && !busy ? (
          /* Stated plainly because it is the one thing that is not obvious: the
             thread is client-side only, so closing the app ends it. */
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <MessageCirclePlus aria-hidden className="h-7 w-7 text-ink-faint" strokeWidth={1.5} />
            <p className="mt-3 text-[15px] font-semibold text-ink-strong">{name}</p>
            <p className="mt-1.5 text-[12.5px] leading-[1.6] text-ink-faint">
              Ask about the run without touching it. It can open this game's files to answer, but cannot
              change anything. Side chats are never saved with the run.
            </p>
            <ul className="mt-3 flex flex-col gap-1 text-[12px] text-ink-faint">
              {EXAMPLES.map((example) => (
                <li key={example}>“{example}”</li>
              ))}
            </ul>
          </div>
        ) : null}

        {messages.map((message, index) =>
          message.role === "user" ? (
            <div
              key={index}
              data-role="user"
              className="max-w-[88%] self-end rounded-[9px_9px_2px_9px] bg-surface-3 px-3 py-2 leading-[1.55] text-ink-strong"
            >
              {message.content}
            </div>
          ) : (
            <div
              key={index}
              data-role="assistant"
              className={`max-w-[94%] self-start leading-[1.6] ${
                message.failed ? "text-danger-soft" : "text-ink"
              }`}
            >
              {/* Same renderer as the agent panel: an advisor quoting a
                  `symbol` or bolding a file name is answering in the same
                  dialect, and raw asterisks here would read as a defect. */}
              <AgentText content={message.content} />
            </div>
          ),
        )}

        {/* The answer as it streams, in the same bubble shape it will settle
            into, so nothing jumps when the RPC returns. The shimmer stays for
            the gap before the first token. */}
        {busy && reads.length > 0 ? (
          <div data-role="reads" className="flex flex-col gap-1 self-start text-[11px] text-ink-faint">
            {reads.map((read) => (
              <span key={read} className="flex items-center gap-1.5">
                <BookOpen aria-hidden className="h-3 w-3 shrink-0" strokeWidth={1.8} />
                <span className="font-mono">{read}</span>
              </span>
            ))}
          </div>
        ) : null}
        {busy && streaming ? (
          <div data-role="streaming" className="max-w-[94%] self-start leading-[1.6] text-ink">
            <AgentText content={streaming} />
          </div>
        ) : null}
        {busy && !streaming && reads.length === 0 ? (
          <span className="cb-shimmer self-start text-[12.5px] font-medium">Thinking…</span>
        ) : null}
      </div>

      {/* The same lockup as the main composer — one raised card, a borderless
          field inside it, the controls row beneath. Two chats that look
          different read as two products. */}
      <div className="shrink-0 px-3 pb-3 pt-2">
        {/* Say what the advisor cannot see. Without this, an answer about a
            step that fell out of the excerpt reads exactly like an answer
            grounded in one — the failure mode this panel is least able to
            show on its own. */}
        {transcriptWindow.truncated ? (
          <div
            data-transcript-window
            className="mb-2 flex items-center gap-1.5 px-1 text-[10px] text-ink-faint"
            title={`The run is longer than the ${TRANSCRIPT_CHARS.toLocaleString()}-character excerpt this thread is given, so the oldest steps are not in view. Ask about recent work, or ask the agent itself about earlier steps.`}
          >
            <Eye aria-hidden className="h-3 w-3 shrink-0" strokeWidth={1.8} />
            <span>
              Reading the last {transcriptWindow.kept} of {transcriptWindow.total} messages
            </span>
          </div>
        ) : null}
        {anchor ? (
          <div
            data-side-anchor
            className="mb-2 flex items-start gap-2 rounded-[10px] border border-line bg-surface-1 px-2.5 py-2 text-[11px]"
          >
            <Crosshair aria-hidden className="mt-0.5 h-3 w-3 shrink-0 text-ink-faint" strokeWidth={1.8} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-ink">{anchor.label}</div>
              {anchor.detail ? (
                <div className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words font-mono text-[10px] leading-[1.5] text-ink-faint">
                  {anchor.detail}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              aria-label="Stop asking about this step"
              onClick={() => setAnchor(null)}
              className="shrink-0 rounded p-0.5 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <X aria-hidden className="h-3 w-3" strokeWidth={2} />
            </button>
          </div>
        ) : null}
        {menuActive && (
          <SlashMenu commands={commandMenu} activeIndex={activeMenuIndex} onPick={completeCommand} />
        )}
        <div className="@container min-w-0 rounded-[20px] border border-line-strong bg-raised p-1.5 shadow-[0_14px_34px_rgba(0,0,0,0.18)] transition-[border-color,box-shadow] duration-200 focus-within:border-ink-faint focus-within:shadow-[0_16px_38px_rgba(0,0,0,0.24)]">
          <Textarea
            ref={inputRef}
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              setCaret(event.target.selectionStart ?? event.target.value.length);
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
            onKeyDown={(event) => {
              if (menuActive) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setMenuIndex((current) => (current + 1) % commandMenu.length);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setMenuIndex((current) => (current - 1 + commandMenu.length) % commandMenu.length);
                  return;
                }
                if (event.key === "Tab") {
                  event.preventDefault();
                  completeCommand(commandMenu[activeMenuIndex].name);
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  // Completes even when the name is already whole, matching the
                  // agent composer: none of these commands runs on the first
                  // Enter, so a reflex keystroke never fires one. A typed name
                  // wins over the highlighted row (`/cl` lists clear + close).
                  const picked = parseSlashIn(input, SIDE_COMMANDS)?.command ?? commandMenu[activeMenuIndex];
                  completeCommand(picked.name);
                  return;
                }
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            rows={2}
            aria-label={`${name} prompt`}
            placeholder="Ask about this run…  Type / for commands"
            className="min-h-[56px] resize-none border-0 bg-transparent px-3 py-2.5 text-[13px] leading-[1.55] text-ink-strong shadow-none placeholder:text-ink-faint"
          />
          <div className="flex min-h-10 items-center gap-1.5 px-1.5 pb-0.5">
            {/* Where the agent composer names its permission mode, this names
                the one thing that cannot change here. The guarantee is worth
                spelling out on hover: it is the reason to use this panel. */}
            <span
              className="shrink-0 cursor-default truncate text-[11px] text-ink-faint"
              title="This thread has no tools. It reads the run's transcript and cannot edit files, run anything, or add to the run's own conversation."
            >
              Read-only
            </span>
            <ModelPicker
              choices={modelChoices}
              activeValue={activeValue}
              activeLabel={activeModelId}
              effort={effort}
              effortIndex={effortIndex}
              effortOf={effortFor}
              disabled={busy}
              label={`${name} model`}
              title={
                activeModelId
                  ? `${activeProvider} · ${activeModelId}${effort ? ` · ${effort}` : ""} — answers here only`
                  : "No model"
              }
              onSelect={(value, level) => {
                const modelId = value.split(":").slice(1).join(":");
                if (level) selectEffort(modelId, level);
                chooseModel(value);
              }}
            />
            {busy ? (
              <button
                type="button"
                aria-label={`Stop ${name.toLowerCase()} answer`}
                onClick={() => abortRef.current?.abort()}
                className="flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full border border-danger-soft/60 bg-danger-soft/15 px-3 text-[11px] text-danger-soft transition-[background-color,transform] hover:bg-danger-soft/25 active:scale-[0.96]"
              >
                <Square aria-hidden className="h-3.5 w-3.5 shrink-0" />
                <span>Stop</span>
              </button>
            ) : (
              <button
                type="button"
                aria-label={`Send ${name.toLowerCase()} message`}
                onClick={() => void send()}
                disabled={!input.trim()}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-[background-color,transform,opacity] enabled:hover:opacity-90 enabled:active:scale-[0.96] disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-ink-faint disabled:opacity-70"
              >
                <ArrowUp aria-hidden className="h-4 w-4" strokeWidth={2.2} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
