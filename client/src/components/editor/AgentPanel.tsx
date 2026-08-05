import { useEffect, useRef, useState } from "react";
import { Bot, Send, ShieldCheck, ShieldOff } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { connectEvents, rpc, type AgentEvent } from "../../lib/rpc";
import type { AgentMessage, BrowserTool, ModelList } from "../../lib/types";

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
  const [permissionMode, setPermissionMode] = useState("full-access");
  const transcriptRef = useRef<HTMLDivElement>(null);
  const toolsRef = useRef(browserTools);
  toolsRef.current = browserTools;

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
        const tool = toolsRef.current.find((candidate) => candidate.name === event.tool);
        void (async () => {
          try {
            const result = tool ? await tool.handler((event.arguments as Record<string, unknown>) ?? {}) : { error: `unknown tool ${event.tool}` };
            await rpc("agent.tool_result", { sessionId: event.sessionId, requestId: event.requestId, result });
          } catch (error) {
            await rpc("agent.tool_result", {
              sessionId: event.sessionId,
              requestId: event.requestId,
              result: { error: error instanceof Error ? error.message : String(error) },
            });
          }
        })();
      }
      if (event.type === "agent.approval_request" && event.requestId && event.tool) {
        setApproval({ requestId: event.requestId, tool: event.tool, arguments: event.arguments });
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
      const result = (await rpc("agent.chat", {
        sessionId,
        projectSlug,
        permissionMode,
        maxTurns: 10,
        messages: [...history, userMessage],
      })) as { sessionId: string; reply: string; toolCalls: unknown[] };
      setSessionId(result.sessionId);
      setMessages((current) => [...current, { role: "assistant", content: result.reply || "Done." }]);
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
      await rpc("model.switch", { provider, model });
      onModelChange();
      setMessages((current) => [...current, { role: "assistant", content: `Switched to ${provider} / ${model}.` }]);
    } catch (error) {
      setMessages((current) => [...current, { role: "assistant", content: `Error: ${error instanceof Error ? error.message : String(error)}` }]);
    }
  };

  const respondToApproval = async (approved: boolean) => {
    if (!approval || !sessionId) return;
    try {
      await rpc("agent.approval_response", { sessionId, requestId: approval.requestId, approved });
      setMessages((current) => [
        ...current,
        { role: "tool", content: approved ? `Approved ${approval.tool}` : `Denied ${approval.tool}`, tool: approval.tool },
      ]);
    } finally {
      setApproval(null);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Bot className="h-4 w-4" />
        <span className="text-sm font-medium">Cali Agent</span>
        <span className="text-xs text-muted-foreground">{busy ? "working" : "ready"}</span>
      </div>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Select value={modelList?.active.provider ?? ""} onValueChange={() => undefined}>
          <SelectTrigger className="h-7 w-28" aria-label="Model provider">
            <SelectValue placeholder="Provider" />
          </SelectTrigger>
          <SelectContent>
            {modelList?.providers.map((provider) => (
              <SelectItem key={provider.id} value={provider.id}>
                {provider.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={modelList?.active.model ?? ""} onValueChange={(model) => void switchModel(modelList?.active.provider ?? "openai", model)}>
          <SelectTrigger className="h-7 min-w-0 flex-1" aria-label="Model">
            <SelectValue placeholder="Model" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={modelList?.active.model ?? ""}>{modelList?.active.model ?? "No model"}</SelectItem>
          </SelectContent>
        </Select>
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
      await rpc("model.switch", { provider, model });
      onModelChange();
    } catch (error) {
      onLog(`model switch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

