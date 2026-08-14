import { AlertCircle } from "lucide-react";

export interface LogEntry {
  id: string;
  level: "info" | "error";
  message: string;
  time: string;
}

/**
 * The app's own log. It carries no title of its own: the only thing that
 * renders it is the bottom dock's Console tab, which already names it.
 */
export function ConsolePanel({ logs }: { logs: LogEntry[] }) {
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-xs">
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
