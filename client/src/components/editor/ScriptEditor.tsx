import { useState } from "react";
import { FileCode2, Plus, Save } from "lucide-react";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { cn } from "../ui/utils";
import type { Script } from "../../lib/types";

interface ScriptEditorProps {
  scripts: Script[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChange: (script: Script) => void;
  onAdd: () => void;
}

export function ScriptEditor({ scripts, selectedId, onSelect, onChange, onAdd }: ScriptEditorProps) {
  const selected = scripts.find((script) => script.id === selectedId) ?? scripts[0];
  const [draft, setDraft] = useState("");
  const current = selected ? (draft || selected.code) : "";
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-sm font-medium">Scripts</span>
        <Button variant="ghost" size="icon" aria-label="Add script" onClick={onAdd}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="w-36 shrink-0 border-r border-border overflow-y-auto p-1">
          {scripts.map((script) => (
            <button
              key={script.id}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                script.id === selected?.id && "bg-accent",
              )}
              onClick={() => {
                setDraft("");
                onSelect(script.id);
              }}
            >
              <FileCode2 className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="truncate">{script.name}</span>
            </button>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          {selected ? (
            <>
              <Textarea
                className="min-h-0 flex-1 resize-none rounded-none border-0 font-mono text-xs focus-visible:ring-0"
                value={current}
                onChange={(event) => setDraft(event.target.value)}
                aria-label={`${selected.name} source`}
              />
              <div className="flex items-center justify-between border-t border-border px-2 py-1">
                <span className="text-xs text-muted-foreground">{selected.name}</span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    onChange({ ...selected, code: current });
                    setDraft("");
                  }}
                >
                  <Save className="h-3.5 w-3.5" />
                  Save script
                </Button>
              </div>
            </>
          ) : (
            <p className="p-3 text-xs text-muted-foreground">No scripts yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}

