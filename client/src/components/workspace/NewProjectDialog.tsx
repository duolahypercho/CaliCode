import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Box, CircleCheck, GalleryVerticalEnd, SquareDashed } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "../ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "../ui/form";
import { Input } from "../ui/input";
import { PROJECT_TEMPLATES, type ProjectTemplate } from "../../lib/projectTemplates";

interface NewProjectDialogProps {
  open: boolean;
  busy: boolean;
  error: string;
  onOpenChange: (open: boolean) => void;
  onCreate: (title: string, templateId: ProjectTemplate["id"]) => void | Promise<void>;
}

type Step = "template" | "details";

const projectDetailsSchema = z.object({
  name: z.string().trim().min(1, "Enter a project name.").max(120, "Keep the name under 120 characters."),
});

type ProjectDetails = z.infer<typeof projectDetailsSchema>;

export function NewProjectDialog({ open, busy, error, onOpenChange, onCreate }: NewProjectDialogProps) {
  const [step, setStep] = useState<Step>("template");
  const [selectedTemplateId, setSelectedTemplateId] = useState<ProjectTemplate["id"] | null>(null);
  const form = useForm<ProjectDetails>({
    resolver: zodResolver(projectDetailsSchema),
    defaultValues: { name: "" },
  });

  useEffect(() => {
    if (!open) {
      setStep("template");
      setSelectedTemplateId(null);
      form.reset();
    }
  }, [form, open]);

  useEffect(() => {
    if (error) form.setError("root", { message: error });
  }, [error, form]);

  const selectedTemplate = PROJECT_TEMPLATES.find((template) => template.id === selectedTemplateId) ?? null;

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !busy && onOpenChange(nextOpen)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-2xl overflow-y-auto p-4 md:p-5">
        {step === "template" ? (
          <>
            <DialogTitle>Choose a template</DialogTitle>
            <DialogDescription className="mt-1 text-[var(--color-text-subtle)]">
              Pick the scene closest to what you want to build.
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
                      className={`group relative min-h-0 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 md:min-h-44 md:p-4 ${
                        selected
                          ? "border-ring bg-accent"
                          : "border-border bg-card hover:border-ring/50 hover:bg-accent/50"
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

            <div className="mt-5 flex justify-end gap-2">
              <DialogClose asChild>
                <Button type="button" variant="ghost" size="sm">
                  Cancel
                </Button>
              </DialogClose>
              <Button
                type="button"
                size="sm"
                disabled={!selectedTemplateId}
                onClick={() => selectedTemplateId && setStep("details")}
              >
                Continue
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogTitle>Name your game</DialogTitle>
            <DialogDescription className="mt-1 text-[var(--color-text-subtle)]">
              Cali creates the project and opens it in the editor.
            </DialogDescription>

            {selectedTemplate ? (
              <div className="mt-5 flex items-center gap-3 rounded-lg border border-border bg-muted/50 px-3 py-2.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border text-foreground">
                  {(() => {
                    const Icon = templateIcon(selectedTemplate.id);
                    return <Icon aria-hidden="true" className="h-4 w-4" />;
                  })()}
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-medium text-[var(--color-text-strong)]">{selectedTemplate.name}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{selectedTemplate.contents}</span>
                </span>
              </div>
            ) : null}

            <Form {...form}>
              <form
                className="mt-4"
                onSubmit={form.handleSubmit(({ name }) => {
                  if (selectedTemplateId && !busy) void onCreate(name, selectedTemplateId);
                })}
              >
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Name</FormLabel>
                      <FormControl>
                        <Input
                          autoFocus
                          placeholder="Skyline Runner"
                          maxLength={120}
                          {...field}
                          onChange={(event) => {
                            form.clearErrors("root");
                            field.onChange(event);
                          }}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {form.formState.errors.root ? (
                  <p role="alert" className="mt-2 text-xs text-destructive">
                    {form.formState.errors.root.message}
                  </p>
                ) : null}
                <div className="mt-5 flex justify-between gap-2">
                  <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setStep("template")}>
                    Back
                  </Button>
                  <Button type="submit" size="sm" disabled={busy}>
                    {busy ? "Creating..." : "Create project"}
                  </Button>
                </div>
              </form>
            </Form>
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
