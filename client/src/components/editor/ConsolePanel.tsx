import { AlertCircle, Terminal } from "lucide-react";

export interface LogEntry {
  id: string;
  level: "info" | "error";
  message: string;
  time: string;
}

export function ConsolePanel({ logs }: { logs: LogEntry[] }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-white/5 px-3 py-2">
        <Terminal className="h-4 w-4 text-muted-foreground" />
        <span className="text-[11px] font-bold tracking-[0.16em] text-[#dcdcdc]">Console</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2 font-mono text-xs">
        {logs.length === 0 ? (
          <p className="text-muted-foreground">No output yet. Run PIE or tests to see logs.</p>
        ) : (
          logs.map((log) => (
            <div key={log.id} className={log.level === "error" ? "text-destructive" : "text-foreground"}>
              {log.level === "error" && <AlertCircle className="mr-1 inline h-3 w-3" />}
              <span className="text-muted-foreground">{log.time}</span> {log.message}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
