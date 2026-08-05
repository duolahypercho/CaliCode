import { CheckCircle2, XCircle } from "lucide-react";
import type { TestResult } from "../../lib/types";

export function TestResults({ results }: { results: TestResult[] }) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-3 py-2">
        <span className="text-sm font-medium">Test Results</span>
        <span className="ml-2 text-xs text-muted-foreground">
          {results.filter((result) => result.pass).length} / {results.length} passed
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {results.length === 0 ? (
          <p className="text-xs text-muted-foreground">Run the test suite to verify scene behavior.</p>
        ) : (
          results.map((result) => (
            <div key={result.id} className="mb-2 rounded-md border border-border p-2">
              <div className="flex items-center gap-2">
                {result.pass ? (
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                ) : (
                  <XCircle className="h-4 w-4 text-destructive" />
                )}
                <span className="text-sm font-medium">{result.name}</span>
                <span className="text-xs text-muted-foreground">{result.pass ? "passed" : "failed"}</span>
              </div>
              {result.error && <p className="mt-1 text-xs text-destructive">{result.error}</p>}
              {result.logs.length > 0 && (
                <pre className="mt-1 max-h-24 overflow-auto text-xs text-muted-foreground">{result.logs.join("\n")}</pre>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

