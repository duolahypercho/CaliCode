import { useEffect, useMemo, useState } from "react";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { rpc } from "../../lib/rpc";
import { McpSection } from "../editor/McpSection";
import { SkillsSection } from "../editor/SkillsSection";
import type { ModelList } from "../../lib/types";

const NEW_PROVIDER = "__new__";

type SettingsTab = "providers" | "skills" | "mcp";

const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: "providers", label: "Providers" },
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP" },
];

interface UpsertResult extends ModelList {
  apiKeyEnv: string;
  keyApplied: boolean;
}

export interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Current providers + active model, from the `model_list` RPC. */
  modelList: ModelList | null;
  /** Called after a successful save so the app can refresh model_list. */
  onChanged: () => void | Promise<void>;
  /** Active project slug, for project-scoped skills. */
  projectSlug?: string;
}

export function SettingsDialog({ open, onOpenChange, modelList, onChanged, projectSlug }: SettingsDialogProps) {
  const [tab, setTab] = useState<SettingsTab>("providers");
  const [providerId, setProviderId] = useState<string>(NEW_PROVIDER);
  const [newId, setNewId] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const providers = useMemo(() => modelList?.providers ?? [], [modelList]);
  const active = modelList?.active ?? null;
  const isNewProvider = providerId === NEW_PROVIDER;

  useEffect(() => {
    if (!open) {
      setTab("providers");
      setProviderId(NEW_PROVIDER);
      setNewId("");
      setNewLabel("");
      setBaseUrl("");
      setModelId("");
      setApiKey("");
      setBusy(false);
      setError("");
      setNotice("");
    }
  }, [open]);

  const submit = async () => {
    const id = (isNewProvider ? newId : providerId).trim();
    if (!id) {
      setError("Enter a provider id.");
      return;
    }
    if (isNewProvider && !baseUrl.trim()) {
      setError("A base URL is required for a new provider.");
      return;
    }
    if (!isNewProvider && !modelId.trim()) {
      setError("Enter a model id to add to this provider.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await rpc<UpsertResult>("model_provider_upsert", {
        id,
        ...(isNewProvider && newLabel.trim() ? { label: newLabel.trim() } : {}),
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        models: modelId.trim() ? [modelId.trim()] : [],
      });
      setNotice(
        result.keyApplied
          ? `Saved. The API key is active for this session — export ${result.apiKeyEnv} to keep it across core restarts.`
          : `Saved. Set the ${result.apiKeyEnv} environment variable to authenticate this provider.`,
      );
      setNewId("");
      setNewLabel("");
      setBaseUrl("");
      setModelId("");
      setApiKey("");
      if (!isNewProvider) setProviderId(id);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to save provider.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !busy && onOpenChange(nextOpen)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto p-4 md:p-5">
        <DialogTitle>Settings</DialogTitle>
        <DialogDescription className="mt-1 text-ink-subtle">
          {tab === "providers"
            ? "Model providers CaliCode can route requests to."
            : tab === "skills"
              ? "Reusable instruction packs the agent can load on demand."
              : "External MCP tool servers configured for the agent."}
        </DialogDescription>

        <div role="tablist" aria-label="Settings sections" className="mt-4 flex rounded-md border border-line">
          {SETTINGS_TABS.map((entry) => (
            <button
              key={entry.id}
              id={`settings-tab-${entry.id}`}
              role="tab"
              type="button"
              aria-selected={tab === entry.id}
              aria-controls={`settings-panel-${entry.id}`}
              onClick={() => setTab(entry.id)}
              className={`flex-1 px-3 py-1.5 text-[11px] font-medium tracking-[0.08em] transition-colors ${
                tab === entry.id ? "bg-surface-3 text-ink-strong" : "text-ink-subtle hover:text-ink"
              }`}
            >
              {entry.label.toUpperCase()}
            </button>
          ))}
        </div>

        {tab === "skills" ? (
          <div role="tabpanel" id="settings-panel-skills" aria-labelledby="settings-tab-skills" className="mt-4">
            <SkillsSection projectSlug={projectSlug} />
          </div>
        ) : null}

        {tab === "mcp" ? (
          <div role="tabpanel" id="settings-panel-mcp" aria-labelledby="settings-tab-mcp" className="mt-4">
            <McpSection />
          </div>
        ) : null}

        {tab !== "providers" ? null : (
        <div role="tabpanel" id="settings-panel-providers" aria-labelledby="settings-tab-providers">
        <section aria-label="Configured providers" className="mt-5">
          <h3 className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-subtle">Models</h3>
          <ul className="mt-2.5 space-y-2">
            {providers.length === 0 ? (
              <li className="rounded-lg border border-line bg-surface-1 px-3 py-2.5 text-sm text-ink-subtle">
                No providers configured yet.
              </li>
            ) : (
              providers.map((provider) => (
                <li key={provider.id} className="rounded-lg border border-line bg-surface-1 px-3 py-2.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm font-medium text-ink-strong">{provider.label}</span>
                    <span className="truncate text-xs text-ink-faint">{provider.base_url}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-ink-subtle">
                    id <span className="text-ink">{provider.id}</span> · key env{" "}
                    <span className="text-ink">{provider.api_key_env}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {(provider.models ?? []).map((model) => {
                      const isActive = active?.provider === provider.id && active.model === model;
                      return (
                        <span
                          key={model}
                          className={`rounded border px-2 py-[3px] text-[11px] ${
                            isActive
                              ? "border-line-strong bg-surface-3 text-ink-strong"
                              : "border-line bg-surface-0 text-ink-subtle"
                          }`}
                        >
                          {model}
                          {isActive ? <span className="ml-1.5 text-[10px] tracking-[0.08em] text-ink-faint">ACTIVE</span> : null}
                        </span>
                      );
                    })}
                  </div>
                </li>
              ))
            )}
          </ul>
        </section>

        <form
          className="mt-5 border-t border-line pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy) void submit();
          }}
        >
          <h3 className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-subtle">
            Add model / provider
          </h3>

          <div className="mt-3 space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="settings-provider">Provider</Label>
              <Select value={providerId} onValueChange={setProviderId} disabled={busy}>
                <SelectTrigger id="settings-provider">
                  <SelectValue placeholder="Choose a provider" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NEW_PROVIDER}>New provider…</SelectItem>
                  {providers.map((provider) => (
                    <SelectItem key={provider.id} value={provider.id}>
                      {provider.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {isNewProvider ? (
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="settings-provider-id">Provider id</Label>
                  <Input
                    id="settings-provider-id"
                    placeholder="my-router"
                    value={newId}
                    disabled={busy}
                    onChange={(event) => setNewId(event.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="settings-provider-label">Label (optional)</Label>
                  <Input
                    id="settings-provider-label"
                    placeholder="My Router"
                    value={newLabel}
                    disabled={busy}
                    onChange={(event) => setNewLabel(event.target.value)}
                  />
                </div>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor="settings-model-id">Model id{isNewProvider ? " (optional)" : ""}</Label>
              <Input
                id="settings-model-id"
                placeholder="gpt-4.1-mini"
                value={modelId}
                disabled={busy}
                onChange={(event) => setModelId(event.target.value)}
              />
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="settings-base-url">Base URL{isNewProvider ? "" : " (optional)"}</Label>
                <Input
                  id="settings-base-url"
                  placeholder="https://api.example.com/v1"
                  value={baseUrl}
                  disabled={busy}
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="settings-api-key">API key (optional)</Label>
                <Input
                  id="settings-api-key"
                  type="password"
                  autoComplete="off"
                  placeholder="sk-…"
                  value={apiKey}
                  disabled={busy}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </div>
            </div>
          </div>

          {error ? (
            <p role="alert" className="mt-3 text-xs text-destructive">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="mt-3 rounded-md border border-line bg-surface-2 px-2.5 py-2 text-xs text-ink">
              {notice}
            </p>
          ) : null}

          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
        </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
