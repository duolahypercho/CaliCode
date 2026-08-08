import { useEffect, useRef, useState } from "react";
import { ArrowRightLeft, Repeat, Send, ShieldCheck, ShieldOff, Square, Workflow } from "lucide-react";
import { AgentText } from "./AgentText";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { connectEvents, rpc, type AgentEvent } from "../../lib/rpc";
import {
  MAX_LOOP_ITERATIONS,
  matchCommands,
  parseSlash,
  type SlashContext,
} from "../../lib/slashCommands";
import {
  deleteSession,
  forkSession,
  listSessions,
  loadSession,
  relativeTime,
  saveSession,
  type SessionSummary,
} from "../../lib/sessions";
import type { AgentMessage, BrowserTool, ModelList, SubagentResult } from "../../lib/types";

interface ApprovalRequest {
  requestId: string;
  tool: string;
  arguments: unknown;
}

interface AgentPanelProps {
  projectSlug: string;
  modelList: ModelList | null;
  browserTools: BrowserTool[];
  onModelChange: () => void;
  onLog: (message: string) => void;
}

export function AgentPanel({ projectSlug, modelList, browserTools, onModelChange, onLog }: AgentPanelProps) {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [eventSessionId, setEventSessionId] = useState<string | null>(null);
  const [permissionMode, setPermissionMode] = useState("full-access");
  const [providerTarget, setProviderTarget] = useState("openai");
  const [modelInput, setModelInput] = useState("");
  const [subagentRole, setSubagentRole] = useState("planner");
  const [subagentTask, setSubagentTask] = useState("");
  const [looping, setLooping] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const cancelLoopRef = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const toolsRef = useRef(browserTools);
  toolsRef.current = browserTools;

  useEffect(() => {
    setProviderTarget(modelList?.active.provider ?? "openai");
    setModelInput(modelList?.active.model ?? "");
  }, [modelList]);

  useEffect(() => {
    const disconnect = connectEvents((event: AgentEvent) => {
      if (event.type === "agent.delta") {
        setMessages((current) => {
          const copy = [...current];
          const last = copy[copy.length - 1];
          if (last && last.role === "assistant") {
            copy[copy.length - 1] = { ...last, content: last.content + (event.delta ?? "") };
          } else {
            copy.push({ role: "assistant", content: event.delta ?? "" });
          }
          return copy;
        });
      }
      if (event.type === "agent.tool_request" && event.requestId && event.sessionId && event.tool) {
        setEventSessionId(event.sessionId);
        const tool = toolsRef.current.find((candidate) => candidate.name === event.tool);
        void (async () => {
          try {
            const result = tool ? await tool.handler((event.arguments as Record<string, unknown>) ?? {}) : { error: `unknown tool ${event.tool}` };
            await rpc("agent_tool_result", { sessionId: event.sessionId, requestId: event.requestId, result });
          } catch (error) {
            await rpc("agent_tool_result", {
              sessionId: event.sessionId,
              requestId: event.requestId,
              result: { error: error instanceof Error ? error.message : String(error) },
            });
          }
        })();
      }
      if (event.type === "agent.approval_request" && event.requestId && event.tool) {
        setEventSessionId(event.sessionId ?? null);
        setApproval({ requestId: event.requestId, tool: event.tool, arguments: event.arguments });
      }
      if (event.type === "agent.tool_started" && event.tool) {
        setMessages((current) => [...current, { role: "tool", content: `${event.tool} started`, tool: event.tool }]);
      }
      if (event.type === "agent.tool_finished" && event.tool) {
        const summary =
          typeof event.result === "string"
            ? event.result.slice(0, 140)
            : event.result && typeof event.result === "object"
              ? JSON.stringify(event.result).slice(0, 140)
              : "finished";
        setMessages((current) => [...current, { role: "tool", content: `${event.tool}: ${summary}`, tool: event.tool }]);
      }
    });
    return disconnect;
  }, []);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [messages, approval]);

  const refreshSessions = () => {
    void listSessions().then(setSessions).catch(() => {});
  };

  useEffect(() => {
    refreshSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the transcript shortly after it settles, keyed by the session id
  // core assigned. Debounced so a burst of streamed deltas saves once.
  useEffect(() => {
    if (!sessionId) return;
    const hasConversation = messages.some((message) => message.role === "user" || message.role === "assistant");
    if (!hasConversation) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void saveSession({
        id: sessionId,
        projectSlug,
        provider: modelList?.active.provider ?? null,
        model: modelList?.active.model ?? null,
        messages,
      })
        .then(() => refreshSessions())
        .catch(() => {});
    }, 800);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, sessionId]);

  const say = (content: string, role: "assistant" | "tool" = "assistant") => {
    setMessages((current) => [...current, { role, content }]);
  };

  // A single conversation turn. Only real user/assistant messages are replayed —
  // the synthetic role:"tool" ticker entries would be sent as provider tool
  // messages with no preceding tool_calls, a protocol violation that hard-failed
  // every turn after the first with a 502/422.
  const runTurn = async (text: string): Promise<string> => {
    const userMessage: AgentMessage = { role: "user", content: text };
    setMessages((current) => [...current, userMessage]);
    setBusy(true);
    try {
      const history = messages
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message) => ({ role: message.role, content: message.content }));
      const result = (await rpc("agent_chat", {
        sessionId,
        projectSlug,
        permissionMode,
        maxTurns: 10,
        messages: [...history, userMessage],
      })) as { sessionId: string; reply: string; toolCalls: unknown[] };
      setSessionId(result.sessionId);
      const reply = result.reply || "Done.";
      setMessages((current) => {
        const last = current[current.length - 1];
        if (last?.role === "assistant" && last.content === reply) return current;
        return [...current, { role: "assistant", content: reply }];
      });
      if (result.toolCalls.length > 0) {
        onLog(`agent completed ${result.toolCalls.length} tool calls`);
      }
      return reply;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMessages((current) => [...current, { role: "assistant", content: `Error: ${message}` }]);
      onLog(`agent error: ${message}`);
      return "";
    } finally {
      setBusy(false);
    }
  };

  const switchModel = async (raw: string) => {
    const [provider, model] = raw.includes(":")
      ? (raw.split(":") as [string, string])
      : [modelList?.active.provider ?? "openai", raw];
    try {
      await rpc("model_switch", { provider, model });
      onModelChange();
      say(`Switched to ${provider} / ${model}.`);
    } catch (error) {
      say(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const compact = async () => {
    if (busy || looping) return;
    const history = messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({ role: message.role, content: message.content }));
    if (history.length === 0) {
      say("Nothing to compact yet.");
      return;
    }
    setBusy(true);
    try {
      const result = (await rpc("agent_chat", {
        sessionId,
        projectSlug,
        permissionMode: "supervised",
        maxTurns: 1,
        messages: [
          ...history,
          {
            role: "user",
            content:
              "Summarize our conversation so far as 5-8 concise bullet points capturing decisions made, the current state, and next steps. Reply with only the summary.",
          },
        ],
      })) as { sessionId: string; reply: string };
      setSessionId(result.sessionId);
      setMessages([{ role: "assistant", content: `Context compacted:\n${result.reply || "(empty)"}` }]);
    } catch (error) {
      say(`Compact failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const diff = async () => {
    if (busy || looping) return;
    await runTurn(
      "List every file you have changed in this session and summarize what changed in each. If nothing changed, say so.",
    );
  };

  // Autonomous loop: drive the agent toward a goal, feeding a "continue" each
  // turn, until it replies DONE, the cap is reached, or the user hits Stop.
  // History is threaded locally because setState lands after the closure reads it.
  const runLoop = async (goal: string) => {
    if (busy || looping) return;
    setLooping(true);
    setBusy(true);
    cancelLoopRef.current = false;
    let localSession = sessionId;
    let history = messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({ role: message.role, content: message.content }));
    say(`▶ loop started — goal: ${goal}`, "tool");
    let completed = false;
    for (let iteration = 1; iteration <= MAX_LOOP_ITERATIONS; iteration += 1) {
      if (cancelLoopRef.current) {
        say(`■ loop stopped after ${iteration - 1} iterations`, "tool");
        break;
      }
      const userMessage: AgentMessage = {
        role: "user",
        content:
          iteration === 1
            ? goal
            : "Continue toward the goal. When it is fully complete, reply with exactly DONE on its own line and nothing else.",
      };
      say(`loop ${iteration}/${MAX_LOOP_ITERATIONS}`, "tool");
      try {
        const result = (await rpc("agent_chat", {
          sessionId: localSession,
          projectSlug,
          permissionMode,
          maxTurns: 10,
          messages: [...history, userMessage],
        })) as { sessionId: string; reply: string; toolCalls: unknown[] };
        localSession = result.sessionId;
        setSessionId(result.sessionId);
        const reply = result.reply || "Done.";
        history = [...history, userMessage, { role: "assistant", content: reply }];
        setMessages((current) => [...current, { role: "assistant", content: reply }]);
        if (/(^|\n)\s*DONE\s*($|\n|$)/i.test(reply)) {
          say(`✔ loop complete in ${iteration} iterations`, "tool");
          completed = true;
          break;
        }
      } catch (error) {
        say(`Loop error: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }
    if (!completed && !cancelLoopRef.current) {
      say(`loop hit the ${MAX_LOOP_ITERATIONS}-iteration cap`, "tool");
    }
    setLooping(false);
    setBusy(false);
  };

  const stopLoop = () => {
    cancelLoopRef.current = true;
  };

  const resumeSession = async (id: string) => {
    if (looping) return;
    try {
      const record = await loadSession(id);
      setSessionId(record.id);
      setMessages(record.messages ?? []);
      say(`Resumed “${record.title}”.`, "tool");
    } catch (error) {
      say(`Resume failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const resumeLast = async () => {
    const candidate = sessions.find((session) => session.id !== sessionId) ?? sessions[0];
    if (!candidate) {
      say("No saved sessions yet.");
      return;
    }
    await resumeSession(candidate.id);
  };

  const forkCurrent = async () => {
    if (!sessionId) {
      say("No session to fork yet — send a message first.");
      return;
    }
    try {
      const record = await forkSession(sessionId);
      setSessionId(record.id);
      say(`Forked to a new session “${record.title}”.`, "tool");
      refreshSessions();
    } catch (error) {
      say(`Fork failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const listSessionsCommand = async () => {
    const current = await listSessions().catch(() => [] as SessionSummary[]);
    setSessions(current);
    if (current.length === 0) {
      say("No saved sessions yet.");
      return;
    }
    const lines = current
      .slice(0, 12)
      .map((session) => `• ${session.title} — ${session.messageCount} msgs, ${relativeTime(session.updatedAt)}`);
    say(["Saved sessions (open the ··· menu to pick one):", ...lines].join("\n"));
  };

  const removeSession = async (id: string) => {
    try {
      await deleteSession(id);
      if (id === sessionId) {
        setSessionId(null);
      }
      refreshSessions();
    } catch {
      /* best effort */
    }
  };

  const slashContext: SlashContext = {
    say,
    clear: () => setMessages([]),
    newSession: () => {
      setSessionId(null);
      setMessages([{ role: "tool", content: "Started a new session.", tool: "session" }]);
    },
    switchModel,
    runLoop,
    compact,
    diff,
    resumeLast,
    fork: forkCurrent,
    listSessions: listSessionsCommand,
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy || looping) return;
    setInput("");
    setMenuIndex(0);
    const parsed = parseSlash(text);
    if (parsed) {
      if (!parsed.command) {
        say(`Unknown command /${parsed.name}. Type /help for the list.`);
        return;
      }
      await parsed.command.run(parsed.args, slashContext);
      return;
    }
    await runTurn(text);
  };

  const respondToApproval = async (approved: boolean) => {
    if (!approval) return;
    const targetSession = eventSessionId ?? sessionId;
    if (!targetSession) return;
    try {
      await rpc("agent_approval_response", { sessionId: targetSession, requestId: approval.requestId, approved });
      setMessages((current) => [
        ...current,
        { role: "tool", content: approved ? `Approved ${approval.tool}` : `Denied ${approval.tool}`, tool: approval.tool },
      ]);
    } finally {
      setApproval(null);
    }
  };

  const spawnSubagent = async () => {
    const task = subagentTask.trim();
    if (!task || busy) return;
    setBusy(true);
    try {
      const result = await rpc<SubagentResult>("subagent_spawn", {
        role: subagentRole,
        instructions: task,
        projectSlug,
        maxTurns: 8,
      });
      setMessages((current) => [
        ...current,
        { role: "tool", content: `${result.role} subagent: ${result.reply}`, tool: result.role },
      ]);
      onLog(`${result.role} subagent finished in ${result.turns} turns`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMessages((current) => [...current, { role: "tool", content: `subagent error: ${message}`, tool: subagentRole }]);
      onLog(`subagent error: ${message}`);
    } finally {
      setBusy(false);
    }
  };

  const suggestions: Array<[string, string]> = [
    ["Add a double jump", "Add a double jump to the player and rebuild the preview."],
    ["Generate sprites", "Generate four enemy sprites and add them to the asset library."],
    ["Playtest it", "Run the test suite and summarise any failures."],
    ["Make it harder", "Increase the difficulty: faster scroll and tighter obstacle spacing."],
    ["Show the diff", "List every file you changed and what changed in each."],
  ];

  const commandMenu = matchCommands(input);
  const menuActive = commandMenu.length > 0;
  const activeMenuIndex = Math.min(menuIndex, commandMenu.length - 1);

  const completeCommand = (name: string) => {
    setInput(`/${name} `);
    setMenuIndex(0);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/5 px-[18px] py-[15px]">
        <span className="font-display text-[15px] font-bold text-[#dadada]">{projectSlug}</span>
        {looping ? (
          <span className="flex items-center gap-1 text-[10px] tracking-[0.12em] text-[#d0b060]">
            <Repeat className="h-3 w-3 [animation:spin_1.6s_linear_infinite]" /> looping
          </span>
        ) : (
          <span className="text-[10px] tracking-[0.12em] text-[#949494]">{busy ? "working" : "ready"}</span>
        )}
        <details className="relative ml-auto">
          <summary
            aria-label="Session settings"
            className="inline-flex min-h-[28px] cursor-pointer list-none items-center rounded px-1 text-[11px] tracking-[0.1em] text-[#8a8a8a] transition-colors hover:text-[#a0a0a0] active:text-[#c0c0c0] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
          >
            · · ·
          </summary>
          <div className="absolute right-0 z-20 mt-2 w-[264px] rounded-lg border border-white/[0.14] bg-[#0e0e0e] p-3 shadow-xl">
            <div className="mb-2 flex items-center justify-between">
              <span className="calicode-label">Sessions</span>
              <button
                type="button"
                className="inline-flex min-h-[28px] items-center rounded px-1 text-[10px] tracking-[0.08em] text-[#8a8a8a] transition-colors hover:text-[#c0c0c0] active:text-[#e0e0e0] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
                onClick={() => {
                  setSessionId(null);
                  setMessages([{ role: "tool", content: "Started a new session.", tool: "session" }]);
                }}
              >
                + NEW
              </button>
            </div>
            <div className="mb-3 max-h-40 space-y-1 overflow-y-auto">
              {sessions.length === 0 ? (
                <p className="text-[11px] text-[#7a7a7a]">No saved sessions yet.</p>
              ) : (
                sessions.slice(0, 20).map((session) => (
                  <div
                    key={session.id}
                    className={`group flex min-h-[28px] items-center gap-2 rounded-md px-2 py-1 transition-colors ${
                      session.id === sessionId
                        ? "bg-white/[0.08] ring-1 ring-inset ring-white/10"
                        : "hover:bg-white/[0.04]"
                    }`}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 rounded-sm text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/30"
                      onClick={() => void resumeSession(session.id)}
                    >
                      <div className="truncate text-[11.5px] text-[#cfcfcf]">{session.title}</div>
                      <div className="text-[9.5px] text-[#7a7a7a]">
                        {session.messageCount} msgs · {relativeTime(session.updatedAt)}
                        {session.id === sessionId ? " · current" : ""}
                      </div>
                    </button>
                    <button
                      type="button"
                      aria-label="Delete session"
                      className="inline-flex min-h-[28px] shrink-0 items-center rounded px-1 text-[13px] leading-none text-[#6a6a6a] opacity-0 transition duration-150 hover:text-[#c06060] active:text-[#e08080] group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#c06060]/50"
                      onClick={() => void removeSession(session.id)}
                    >
                      ×
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="calicode-label mb-2">Model</div>
            <div className="mb-3 flex items-center gap-1.5">
              <Select value={providerTarget} onValueChange={setProviderTarget}>
                <SelectTrigger className="h-7 min-w-0 flex-1" aria-label="Model provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(modelList?.providers ?? []).map((provider) => (
                    <SelectItem key={provider.id} value={provider.id}>
                      {provider.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                className="h-7 min-w-0 flex-1"
                value={modelInput}
                onChange={(event) => setModelInput(event.target.value)}
                list="calicode-models"
                aria-label="Target model"
              />
              <datalist id="calicode-models">
                {[...new Set(modelList?.providers.flatMap((provider) => provider.models ?? []) ?? [])].map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
              <Button
                size="sm"
                variant="secondary"
                className="h-7 w-7 shrink-0 px-0"
                aria-label="Switch model"
                onClick={() => void switchModel(`${providerTarget}:${modelInput}`)}
              >
                <ArrowRightLeft className="h-3.5 w-3.5" />
              </Button>
            </div>

            <div className="calicode-label mb-2">Subagent</div>
            <div className="flex items-center gap-1.5">
              <Select value={subagentRole} onValueChange={setSubagentRole}>
                <SelectTrigger className="h-7 w-24 shrink-0" aria-label="Subagent role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["planner", "coder", "tester", "critic"].map((role) => (
                    <SelectItem key={role} value={role}>
                      {role}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                className="h-7 min-w-0 flex-1"
                value={subagentTask}
                onChange={(event) => setSubagentTask(event.target.value)}
                placeholder="Subagent task"
                aria-label="Subagent task"
              />
              <Button
                size="sm"
                variant="secondary"
                className="h-7 w-7 shrink-0 px-0"
                aria-label="Spawn subagent"
                disabled={busy || !subagentTask.trim()}
                onClick={() => void spawnSubagent()}
              >
                <Workflow className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </details>
      </div>

      <div
        ref={transcriptRef}
        className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-[18px] pb-2 pt-[18px]"
      >
        {messages.length === 0 && (
          <p className="text-xs leading-relaxed text-[#8f8f8f]">
            Ask CaliCode to build or change the game, then verify the result in PIE.
          </p>
        )}

        {messages.map((message, index) =>
          message.role === "user" ? (
            <div
              key={index}
              data-role="user"
              className="max-w-[88%] self-end rounded-[9px_9px_2px_9px] bg-[#262626] px-3.5 py-2.5 text-[13px] leading-[1.55] text-[#e0e0e0]"
            >
              {message.content}
            </div>
          ) : message.role === "tool" ? (
            <div key={index} data-role="tool" className="self-start">
              <div className="flex items-center gap-2.5 rounded-lg border border-white/[0.09] px-3 py-2.5 text-xs text-[#9a9a9a]">
                <span aria-hidden className="h-3 w-3 shrink-0 border border-[#a0a0a0] bg-[#a0a0a0]" />
                <span className="min-w-0">{message.content}</span>
              </div>
            </div>
          ) : (
            <div key={index} data-role="assistant" className="max-w-[94%] self-start">
              <div className="mb-1.5 text-[9.5px] tracking-[0.24em] text-[#8a8a8a]">CALICODE</div>
              <div className="text-[13px] leading-[1.6] text-[#c8c8c8]">
                <AgentText content={message.content} />
              </div>
            </div>
          ),
        )}

        {busy && (
          <div className="self-start" aria-label="Agent is thinking">
            <div className="mb-1.5 text-[9.5px] tracking-[0.24em] text-[#8a8a8a]">CALICODE</div>
            <div className="inline-flex gap-1">
              {[0, 1, 2].map((dot) => (
                <span
                  key={dot}
                  className="h-1.5 w-1.5 bg-[#c6c6c6] [animation:cb-dot_1.2s_infinite]"
                  style={{ animationDelay: `${dot * 0.15}s` }}
                />
              ))}
            </div>
          </div>
        )}

        {approval && (
          <div className="w-full self-start rounded-lg border border-white/[0.16] bg-[#0e0e0e] p-3">
            <p className="text-[13px] text-[#dadada]">Approve {approval.tool}?</p>
            <pre className="mt-1.5 max-h-24 overflow-auto text-[11px] text-[#9c9c9c]">
              {JSON.stringify(approval.arguments, null, 2)}
            </pre>
            <div className="mt-2.5 flex gap-2">
              <Button size="sm" onClick={() => void respondToApproval(true)}>
                <ShieldCheck className="mr-1 h-3.5 w-3.5" /> Approve
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void respondToApproval(false)}>
                <ShieldOff className="mr-1 h-3.5 w-3.5" /> Deny
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-white/5 px-3.5 pb-3.5 pt-2.5">
        <div className="mb-2.5 flex flex-wrap gap-[7px]">
          {suggestions.map(([label, prompt]) => (
            <button
              key={label}
              type="button"
              disabled={busy}
              onClick={() => setInput(prompt)}
              className="inline-flex min-h-[28px] items-center rounded-[14px] border border-white/10 px-2.5 py-[5px] text-[11px] text-[#9a9a9a] transition-colors enabled:hover:border-white/[0.28] enabled:hover:text-[#d0d0d0] active:border-white/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {label}
            </button>
          ))}
        </div>

        {menuActive && (
          <div className="mb-2 overflow-hidden rounded-[10px] border border-white/[0.12] bg-[#0e0e0e]">
            {commandMenu.map((command, index) => (
              <button
                key={command.name}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  completeCommand(command.name);
                }}
                className={`flex min-h-[28px] w-full items-baseline gap-2 px-3 py-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/30 active:bg-white/[0.09] ${
                  index === activeMenuIndex ? "bg-white/[0.07]" : "hover:bg-white/[0.04]"
                }`}
              >
                <span className="font-mono text-[#d0d0d0]">/{command.name}</span>
                {command.usage && <span className="font-mono text-[10px] text-[#7a7a7a]">{command.usage}</span>}
                <span className="ml-auto truncate text-[#8a8a8a]">{command.summary}</span>
              </button>
            ))}
          </div>
        )}

        <div className="rounded-[10px] border border-white/[0.11] bg-[#0d0d0d] px-3.5 pb-2.5 pt-3 transition-colors focus-within:border-white/[0.2]">
          <Textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
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
                if (event.key === "Enter" && !event.shiftKey && !parseSlash(input)?.command) {
                  event.preventDefault();
                  completeCommand(commandMenu[activeMenuIndex].name);
                  return;
                }
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            rows={2}
            aria-label="Agent prompt"
            placeholder="What do you want to build?  ·  type / for commands"
            className="min-h-0 resize-none border-0 bg-transparent p-0 text-[13px] text-[#d0d0d0] focus-visible:ring-0"
          />
          <div className="mt-2.5 flex items-center gap-3">
            <span className="truncate text-[10.5px] tracking-[0.1em] text-[#828282]">
              {(modelList?.active.model ?? "no model").toUpperCase()}
            </span>
            <Select value={permissionMode} onValueChange={setPermissionMode}>
              <SelectTrigger
                className="h-7 w-[116px] border-0 bg-transparent px-0 text-[10.5px] tracking-[0.1em] text-[#828282]"
                aria-label="Permission mode"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="full-access">Full access</SelectItem>
                <SelectItem value="auto">Auto</SelectItem>
                <SelectItem value="auto-accept-edits">Auto edits</SelectItem>
                <SelectItem value="supervised">Supervised</SelectItem>
              </SelectContent>
            </Select>
            {looping ? (
              <button
                type="button"
                onClick={stopLoop}
                disabled={cancelLoopRef.current}
                className="ml-auto flex shrink-0 items-center gap-1.5 rounded-[5px] border border-[#7a2a2a] bg-[#3a1f1f] px-4 py-[7px] text-[11px] font-bold tracking-[0.16em] text-[#f0c0c0] transition-colors enabled:hover:bg-[#492525] active:bg-[#2f1818] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#c06060]/50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Square className="h-3 w-3" /> STOP
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void send()}
                disabled={busy || !input.trim()}
                className="ml-auto flex shrink-0 items-center gap-1.5 rounded-[5px] border border-white/[0.12] bg-[#2a2a2a] px-4 py-[7px] text-[11px] font-bold tracking-[0.16em] text-[#dcdcdc] transition-colors enabled:hover:bg-[#333] active:bg-[#242424] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Send className="h-3 w-3" /> SEND
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
