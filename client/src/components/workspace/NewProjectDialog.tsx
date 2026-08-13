import { useEffect, useState } from "react";
import { Box, CircleCheck, Folder, GalleryVerticalEnd, SquareDashed } from "lucide-react";
import { Button } from "../ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { FolderPicker } from "./FolderPicker";
import { PROJECT_TEMPLATES, type ProjectTemplate } from "../../lib/projectTemplates";

interface NewProjectDialogProps {
  open: boolean;
  busy: boolean;
  error: string;
  onOpenChange: (open: boolean) => void;
  /** Create a fresh game from a template. */
  onCreate: (title: string, templateId: ProjectTemplate["id"]) => void | Promise<void>;
  /** Open an existing folder as a game; `title` overrides the folder name. */
  onOpenFolder: (path: string, title?: string) => void | Promise<void>;
}

type Step = "details" | "template";

/**
 * Two paths out of one dialog: name a new game and pick a template, or select
 * an existing source folder and open it as a game directly (the template step
 * is skipped — the folder already is the game).
 */
export function NewProjectDialog({ open, busy, error, onOpenChange, onCreate, onOpenFolder }: NewProjectDialogProps) {
  const [step, setStep] = useState<Step>("details");
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState("");
  const [folder, setFolder] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<ProjectTemplate["id"] | null>(null);

  useEffect(() => {
    if (!open) {
      setStep("details");
      setName("");
      setNameError("");
      setFolder(null);
      setSelectedTemplateId(null);
    }
  }, [open]);

  const trimmedName = name.trim();

  const submitDetails = () => {
    if (busy) return;
    if (folder) {
      void onOpenFolder(folder, trimmedName || undefined);
      return;
    }
    if (!trimmedName) {
      setNameError("Enter a project name or add a source folder.");
      return;
    }
    setStep("template");
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !busy && onOpenChange(nextOpen)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-2xl overflow-y-auto p-4 md:p-5">
        {step === "details" ? (
          <>
            <DialogTitle>Create project</DialogTitle>
            <DialogDescription className="mt-1 text-[var(--color-text-subtle)]">
              Name a new game, or add a source folder to open an existing project.
            </DialogDescription>

            <form
              className="mt-5"
              onSubmit={(event) => {
                event.preventDefault();
                submitDetails();
              }}
            >
              <Label htmlFor="new-project-name" className="sr-only">
                Project name
              </Label>
              <div className="relative">
                <Folder
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  id="new-project-name"
                  className="pl-9"
                  autoFocus
                  placeholder="Project name"
                  maxLength={120}
                  value={name}
                  onChange={(event) => {
                    setNameError("");
                    setName(event.target.value);
                  }}
                />
              </div>
              {nameError ? (
                <p role="alert" className="mt-2 text-xs text-destructive">
                  {nameError}
                </p>
              ) : null}

              <div className="calicode-label mb-2 mt-5">Source folder</div>
              <FolderPicker value={folder} onChange={setFolder} disabled={busy} />

              {error ? (
                <p role="alert" className="mt-2 text-xs text-destructive">
                  {error}
                </p>
              ) : null}

              <div className="mt-5 flex justify-end gap-2">
                <DialogClose asChild>
                  <Button type="button" variant="ghost" size="sm" disabled={busy}>
                    Cancel
                  </Button>
                </DialogClose>
                <Button type="submit" size="sm" disabled={busy || (!folder && !trimmedName)}>
                  {folder ? (busy ? "Opening..." : "Create project") : "Continue"}
                </Button>
              </div>
            </form>
          </>
        ) : (
          <>
            <DialogTitle>Choose a template</DialogTitle>
            <DialogDescription className="mt-1 text-[var(--color-text-subtle)]">
              Pick the scene closest to what you want {trimmedName ? `"${trimmedName}"` : "your game"} to be.
            </DialogDescription>

            <fieldset className="mt-5">
              <legend className="calicode-label mb-2.5">Templates</legend>
              <div className="grid gap-2.5 md:grid-cols-3">
                {PROJECT_TEMPLATES.map((template, index) => {
                  const selected = template.id === selectedTemplateId;
                  const Icon = templateIcon(template.id);
                  return (
                    <button
                      key={template.id}
                      type="button"
                      aria-pressed={selected}
                      autoFocus={index === 0}
                      onClick={() => setSelectedTemplateId(template.id)}
                      className={`group relative min-h-0 rounded-lg border p-3 text-left transition-colors md:min-h-44 md:p-4 ${
                        selected
                          ? "border-ring bg-accent"
                          : "border-border bg-card hover:bg-accent/50"
                      }`}
                    >
                      <span className="flex items-start justify-between gap-3">
                        <span className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-muted text-foreground">
                          <Icon aria-hidden="true" className="h-4 w-4" />
                        </span>
                        {selected ? <CircleCheck aria-hidden="true" className="h-4 w-4 text-foreground" /> : null}
                      </span>
                      <span className="mt-4 block text-sm font-medium text-[var(--color-text-strong)]">{template.name}</span>
                      <span className="mt-1.5 block text-xs leading-relaxed text-[var(--color-text-subtle)]">{template.description}</span>
                      <span className="mt-3 block text-xs text-muted-foreground">{template.contents}</span>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            {error ? (
              <p role="alert" className="mt-2 text-xs text-destructive">
                {error}
              </p>
            ) : null}

            <div className="mt-5 flex justify-between gap-2">
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setStep("details")}>
                Back
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={busy || !selectedTemplateId}
                onClick={() => {
                  if (selectedTemplateId && !busy) void onCreate(trimmedName, selectedTemplateId);
                }}
              >
                {busy ? "Creating..." : "Create game"}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function templateIcon(templateId: ProjectTemplate["id"]) {
  if (templateId === "blank") return SquareDashed;
  if (templateId === "showcase") return GalleryVerticalEnd;
  return Box;
}
