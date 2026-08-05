import { useEffect, useRef, useState } from "react";
import { ArrowRightLeft, Bot, Send, ShieldCheck, ShieldOff, Workflow } from "lucide-react";
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
      const history = messages.map((message) => ({ role: message.role, content: message.content }));
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

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-white/5 px-3 py-2">
        <Bot className="h-4 w-4" />
        <span className="text-[11px] font-bold tracking-[0.16em] text-[#dcdcdc]">Caliber Agent</span>
        <span className="text-[10px] tracking-[0.12em] text-[#616161]">{busy ? "working" : "ready"}</span>
      </div>
      <div className="flex items-center gap-2 border-b border-white/5 px-3 py-2">
        <Select value={providerTarget} onValueChange={setProviderTarget}>
          <SelectTrigger className="h-7 w-28" aria-label="Model provider">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {modelList?.providers.map((provider) => (
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
          list="caliber-models"
          aria-label="Target model"
        />
        <datalist id="caliber-models">
          {modelList?.providers.flatMap((provider) => provider.models ?? []).map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="secondary"
              className="h-7 w-7 shrink-0 px-0"
              aria-label="Switch model"
              disabled={busy || !modelInput.trim()}
              onClick={() => void switchModel(providerTarget, modelInput.trim())}
            >
              <ArrowRightLeft className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Switch model</TooltipContent>
        </Tooltip>
      </div>
      <div className="flex items-center gap-2 border-b border-white/5 px-3 py-2">
        <Select value={permissionMode} onValueChange={setPermissionMode}>
          <SelectTrigger className="h-7 w-32" aria-label="Permission mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="full-access">Full access</SelectItem>
            <SelectItem value="auto">Auto</SelectItem>
            <SelectItem value="auto-accept-edits">Auto edits</SelectItem>
            <SelectItem value="supervised">Supervised</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex-1" />
        <Select value={subagentRole} onValueChange={setSubagentRole}>
          <SelectTrigger className="h-7 w-24" aria-label="Subagent role">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="planner">Planner</SelectItem>
            <SelectItem value="coder">Coder</SelectItem>
            <SelectItem value="tester">Tester</SelectItem>
            <SelectItem value="visual-critic">Critic</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2 border-b border-white/5 px-3 py-2">
        <Input
          className="h-7 min-w-0 flex-1"
          value={subagentTask}
          onChange={(event) => setSubagentTask(event.target.value)}
          placeholder="Subagent task"
          aria-label="Subagent task"
        />
        <Tooltip>
          <TooltipTrigger asChild>
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
          </TooltipTrigger>
          <TooltipContent>Spawn subagent</TooltipContent>
        </Tooltip>
      </div>
      <div ref={transcriptRef} className="min-h-0 flex-1 overflow-y-auto p-2">
        {messages.length === 0 && (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            Ask the agent to build or change the game, then verify the result in PIE.
          </p>
        )}
        {messages.map((message, index) => (
          <div key={index} className="mb-2 rounded-md border border-border bg-card p-2">
            <span className="text-xs font-medium text-muted-foreground">{message.role}</span>
            {message.tool && <span className="ml-2 text-xs text-muted-foreground">tool: {message.tool}</span>}
            <p className="mt-1 whitespace-pre-wrap text-sm">{message.content}</p>
          </div>
        ))}
        {approval && (
          <div className="mb-2 rounded-md border border-border bg-card p-2">
            <p className="text-sm">Approve {approval.tool}?</p>
            <pre className="mt-1 max-h-24 overflow-auto text-xs text-muted-foreground">{JSON.stringify(approval.arguments, null, 2)}</pre>
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => void respondToApproval(true)}>
                <ShieldCheck className="h-3.5 w-3.5" />
                Approve
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void respondToApproval(false)}>
                <ShieldOff className="h-3.5 w-3.5" />
                Deny
              </Button>
            </div>
          </div>
        )}
      </div>
      <div className="border-t border-border p-2">
        <Textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder="Describe a scene, asset, or test..."
          aria-label="Agent prompt"
          className="min-h-14"
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Enter to send, Shift+Enter for a new line</span>
          <Button size="sm" disabled={busy || !input.trim()} onClick={() => void send()}>
            <Send className="h-3.5 w-3.5" />
            Send
          </Button>
        </div>
      </div>
    </div>
  );

  async function switchModel(provider: string, model: string) {
    try {
      await rpc("model_switch", { provider, model });
      onModelChange();
    } catch (error) {
      onLog(`model switch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
