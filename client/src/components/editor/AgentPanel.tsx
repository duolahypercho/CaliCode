import { useEffect, useRef, useState } from "react";
import { ArrowRightLeft, Send, ShieldCheck, ShieldOff, Workflow } from "lucide-react";
import { AgentText } from "./AgentText";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { connectEvents, rpc, type AgentEvent } from "../../lib/rpc";
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

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    if (text.startsWith("/model")) {
      await handleModelCommand(text);
      return;
    }
    const userMessage: AgentMessage = { role: "user", content: text };
    setMessages((current) => [...current, userMessage]);
    setBusy(true);
    try {
      // Only real conversation turns. `messages` also holds synthetic
      // role:"tool" entries pushed for the tool-call ticker; replaying those
      // sends the provider a tool message with no preceding tool_calls, which
      // is a protocol violation — every turn after the first hard-failed with
      // a 502/422 and the panel was single-turn only in practice.
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
      setMessages((current) => {
        const last = current[current.length - 1];
        if (last?.role === "assistant" && last.content === (result.reply || "Done.")) {
          return current;
        }
        return [...current, { role: "assistant", content: result.reply || "Done." }];
      });
      if (result.toolCalls.length > 0) {
        onLog(`agent completed ${result.toolCalls.length} tool calls`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMessages((current) => [...current, { role: "assistant", content: `Error: ${message}` }]);
      onLog(`agent error: ${message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleModelCommand = async (text: string) => {
    const parts = text.split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      setMessages((current) => [...current, { role: "assistant", content: "Usage: /model <provider>:<model> or /model <model>" }]);
      return;
    }
    const raw = parts[1];
    const [provider, model] = raw.includes(":") ? raw.split(":") : [modelList?.active.provider ?? "openai", raw];
    try {
      await rpc("model_switch", { provider, model });
      onModelChange();
      setMessages((current) => [...current, { role: "assistant", content: `Switched to ${provider} / ${model}.` }]);
    } catch (error) {
      setMessages((current) => [...current, { role: "assistant", content: `Error: ${error instanceof Error ? error.message : String(error)}` }]);
    }
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/5 px-[18px] py-[15px]">
        <span className="font-display text-[15px] font-bold text-[#dadada]">{projectSlug}</span>
        <span className="text-[10px] tracking-[0.12em] text-[#616161]">{busy ? "working" : "ready"}</span>
        <details className="relative ml-auto">
          <summary
            aria-label="Session settings"
            className="cursor-pointer list-none px-1 text-[11px] tracking-[0.1em] text-[#4f4f4f] hover:text-[#a0a0a0]"
          >
            · · ·
          </summary>
          <div className="absolute right-0 z-20 mt-2 w-[264px] rounded-lg border border-white/[0.14] bg-[#0e0e0e] p-3 shadow-xl">
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
                onClick={() => void handleModelCommand(`/model ${providerTarget}:${modelInput}`)}
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
          <p className="text-xs leading-relaxed text-[#565656]">
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
              <div className="mb-1.5 text-[9.5px] tracking-[0.24em] text-[#4f4f4f]">CALICODE</div>
              <div className="text-[13px] leading-[1.6] text-[#c8c8c8]">
                <AgentText content={message.content} />
              </div>
            </div>
          ),
        )}

        {busy && (
          <div className="self-start" aria-label="Agent is thinking">
            <div className="mb-1.5 text-[9.5px] tracking-[0.24em] text-[#4f4f4f]">CALICODE</div>
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
            <pre className="mt-1.5 max-h-24 overflow-auto text-[11px] text-[#767676]">
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
              className="rounded-[14px] border border-white/10 px-2.5 py-[5px] text-[11px] text-[#9a9a9a] hover:border-white/[0.28] hover:text-[#d0d0d0] disabled:opacity-40"
            >
              {label}
            </button>
          ))}
        </div>

        <div className="rounded-[10px] border border-white/[0.11] bg-[#0d0d0d] px-3.5 pb-2.5 pt-3">
          <Textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            rows={2}
            aria-label="Agent prompt"
            placeholder="What do you want to build?"
            className="min-h-0 resize-none border-0 bg-transparent p-0 text-[13px] text-[#d0d0d0] focus-visible:ring-0"
          />
          <div className="mt-2.5 flex items-center gap-3">
            <span className="truncate text-[10.5px] tracking-[0.1em] text-[#828282]">
              {(modelList?.active.model ?? "no model").toUpperCase()}
            </span>
            <Select value={permissionMode} onValueChange={setPermissionMode}>
              <SelectTrigger
                className="h-6 w-[116px] border-0 bg-transparent px-0 text-[10.5px] tracking-[0.1em] text-[#828282]"
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
            <button
              type="button"
              onClick={() => void send()}
              disabled={busy || !input.trim()}
              className="ml-auto flex shrink-0 items-center gap-1.5 rounded-[5px] border border-white/[0.12] bg-[#2a2a2a] px-4 py-[7px] text-[11px] font-bold tracking-[0.16em] text-[#dcdcdc] hover:bg-[#333] disabled:opacity-40"
            >
              <Send className="h-3 w-3" /> SEND
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
