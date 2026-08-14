import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Activity,
  Archive,
  ArrowLeft,
  ArrowUpRight,
  Check,
  CircleHelp,
  KeyRound,
  Moon,
  Plug,
  Settings as SettingsIcon,
  SlidersHorizontal,
  Sun,
  WandSparkles,
  X,
} from "lucide-react";
import packageJson from "../../../package.json";
import { McpSection } from "../editor/McpSection";
import { SkillsSection } from "../editor/SkillsSection";
import { ArchiveSection } from "./ArchiveSection";
import { StatusSection } from "./StatusSection";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { rpc } from "../../lib/rpc";
import { hasOverlayWindowControls } from "../../lib/desktop";
import type { ModelList, ProviderPreset } from "../../lib/types";

const NEW_PROVIDER = "__new__";
const ROUTER_PROVIDER = "codex-router";

export type SettingsSection = "general" | "status" | "providers" | "skills" | "mcp" | "archive" | "theme";
export type SettingsTheme = "dark" | "light";

const SETTINGS_SECTIONS: {
  id: SettingsSection;
  label: string;
  description: string;
  icon: typeof SettingsIcon;
}[] = [
  { id: "general", label: "General", description: "CaliCode and core status.", icon: SettingsIcon },
  { id: "status", label: "Status", description: "Token usage and cache hit rate.", icon: Activity },
  { id: "providers", label: "Providers", description: "Models and authentication.", icon: KeyRound },
  { id: "skills", label: "Skills", description: "Agent instruction packs.", icon: WandSparkles },
  { id: "mcp", label: "MCP", description: "External agent tools.", icon: Plug },
  { id: "archive", label: "Archive", description: "Archived chats: restore or delete.", icon: Archive },
  { id: "theme", label: "Theme", description: "Appearance preferences.", icon: SlidersHorizontal },
];

type PingResult = { pong?: boolean; version?: string };

interface UpsertResult extends ModelList {
  apiKeyEnv: string;
  keyApplied: boolean;
}

export interface SettingsPageProps {
  open: boolean;
  onClose: () => void;
  modelList: ModelList | null;
  onChanged: () => void | Promise<void>;
  /** Called after a restore, so the shell's sidebar list picks the chat up. */
  onSessionsChanged?: () => void | Promise<void>;
  projectSlug?: string;
  theme: SettingsTheme;
  onThemeChange: (theme: SettingsTheme) => void;
}

function SectionNav({
  active,
  onSelect,
}: {
  active: SettingsSection;
  onSelect: (section: SettingsSection) => void;
}) {
  return (
    <nav aria-label="Settings sections" role="tablist" className="space-y-0.5 px-2">
      {SETTINGS_SECTIONS.map((section) => {
        const Icon = section.icon;
        const selected = section.id === active;
        return (
          <button
            key={section.id}
            id={`settings-tab-${section.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`settings-panel-${section.id}`}
            onClick={() => onSelect(section.id)}
            className={`flex min-h-9 w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[12px] transition-colors ${
              selected
                ? "bg-surface-3 text-ink-strong"
                : "text-ink-subtle hover:bg-surface-2 hover:text-ink-strong active:bg-surface-3"
            }`}
          >
            <Icon aria-hidden size={15} strokeWidth={1.7} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{section.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function PageHeader({
  section,
  onClose,
}: {
  section: SettingsSection;
  onClose: () => void;
}) {
  const active = SETTINGS_SECTIONS.find((entry) => entry.id === section) ?? SETTINGS_SECTIONS[0];
  return (
    <header
      data-tauri-drag-region="deep"
      className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-5 py-5 md:px-8 md:py-7"
    >
      <div className="min-w-0">
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">Settings / {active.label}</p>
        <h1 id="settings-title" className="mt-2 font-display text-[22px] font-bold text-ink-strong">
          {active.label}
        </h1>
        <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-ink-subtle">{active.description}</p>
      </div>
      <button
        type="button"
        aria-label="Close settings"
        onClick={onClose}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink-strong"
      >
        <X aria-hidden size={17} strokeWidth={1.7} />
      </button>
    </header>
  );
}

function GeneralSection({ projectSlug }: { projectSlug?: string }) {
  const [coreVersion, setCoreVersion] = useState<string | null>(null);
  const [coreState, setCoreState] = useState<"loading" | "ready" | "offline">("loading");

  useEffect(() => {
    let cancelled = false;
    setCoreState("loading");
    void rpc<PingResult>("ping")
      .then((result) => {
        if (cancelled) return;
        setCoreVersion(result.version ?? "unknown");
        setCoreState("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setCoreVersion(null);
        setCoreState("offline");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-5">
      <section aria-labelledby="settings-about-heading">
        <h2 id="settings-about-heading" className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-subtle">
          About CaliCode
        </h2>
        <div className="mt-2 overflow-hidden rounded-lg border border-line bg-surface-1">
          <dl className="divide-y divide-line">
            <div className="flex items-center justify-between gap-4 px-3.5 py-3">
              <dt className="text-[13px] text-ink-subtle">App version</dt>
              <dd className="font-mono text-[12px] text-ink">{packageJson.version}</dd>
            </div>
            <div className="flex items-center justify-between gap-4 px-3.5 py-3">
              <dt className="text-[13px] text-ink-subtle">Core version</dt>
              <dd className="font-mono text-[12px] text-ink">
                {coreState === "loading" ? "Checking…" : coreState === "ready" ? coreVersion : "Unavailable"}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4 px-3.5 py-3">
              <dt className="text-[13px] text-ink-subtle">Current game</dt>
              <dd className="max-w-[55%] truncate font-mono text-[12px] text-ink" title={projectSlug ?? undefined}>
                {projectSlug ?? "None open"}
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <section aria-labelledby="settings-updates-heading">
        <h2 id="settings-updates-heading" className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-subtle">
          Updates
        </h2>
        <div className="mt-2 flex items-start gap-3 rounded-lg border border-line bg-surface-1 px-3.5 py-3.5">
          <CircleHelp aria-hidden size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-ink-faint" />
          <div>
            <p className="text-[13px] text-ink-strong">No in-app updater is available</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-subtle">
              CaliCode updates are delivered with the desktop release. This page does not claim to check or install
              updates.
            </p>
            <a
              href="https://github.com/duolahypercho/CaliCode/releases"
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-surface-2 hover:text-ink-strong"
            >
              Releases and downloads
              <ArrowUpRight aria-hidden size={13} strokeWidth={1.7} />
            </a>
          </div>
        </div>
      </section>

      <section aria-labelledby="settings-persistence-heading">
        <h2 id="settings-persistence-heading" className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-subtle">
          Workspace behavior
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-subtle">
          CaliCode saves game document edits automatically. Provider metadata is written to core&apos;s config, while
          API keys are only applied to the running core process.
        </p>
      </section>
    </div>
  );
}

function ProviderRow({ provider, active }: { provider: ProviderPreset; active: boolean }) {
  const localEndpoint = /^https?:\/\/(127\.0\.0\.1|localhost)(?::|\/|$)/i.test(provider.base_url);
  const authSource =
    provider.id === ROUTER_PROVIDER
      ? "managed by Codex Router"
      : localEndpoint
        ? "local endpoint; no key required"
        : `key env ${provider.api_key_env}`;
  return (
    <li className="rounded-lg border border-line bg-surface-1 px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <span className="text-[13px] font-medium text-ink-strong">{provider.label}</span>
          {active ? (
            <span className="ml-2 inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.1em] text-ink-subtle">
              <Check aria-hidden size={11} strokeWidth={2} />
              Active
            </span>
          ) : null}
        </div>
        <span className="max-w-[48%] truncate font-mono text-[10.5px] text-ink-faint" title={provider.base_url}>
          {provider.base_url}
        </span>
      </div>
      <div className="mt-1 text-[11px] text-ink-subtle">
        id <span className="font-mono text-ink">{provider.id}</span> ·{" "}
        <span className="text-ink">{authSource}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {(provider.models ?? []).map((model) => (
          <span key={model} className="rounded border border-line bg-surface-0 px-2 py-1 font-mono text-[10.5px] text-ink-subtle">
            {model}
          </span>
        ))}
      </div>
    </li>
  );
}

function ProvidersSection({
  modelList,
  onChanged,
}: {
  modelList: ModelList | null;
  onChanged: () => void | Promise<void>;
}) {
  const [providerId, setProviderId] = useState(NEW_PROVIDER);
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
  const routerConfigured = providers.some((provider) => provider.id === ROUTER_PROVIDER);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
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
          ? `Saved for this session. ${result.apiKeyEnv} was not written to disk; export it to keep authentication across core restarts.`
          : `Saved. Set ${result.apiKeyEnv} in the environment before restarting core to authenticate this provider.`,
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
    <div className="space-y-5">
      <section aria-labelledby="settings-configured-providers-heading">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2
              id="settings-configured-providers-heading"
              className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-subtle"
            >
              Configured providers
            </h2>
            <p className="mt-1 text-xs text-ink-faint">
              The active model is selected from the composer; this page manages provider metadata and credentials.
            </p>
          </div>
          {active ? (
            <span className="shrink-0 rounded border border-line bg-surface-2 px-2 py-1 font-mono text-[10px] text-ink-subtle">
              {active.provider} / {active.model}
            </span>
          ) : null}
        </div>
        <ul className="mt-3 space-y-2">
          {providers.length === 0 ? (
            <li className="rounded-lg border border-line bg-surface-1 px-3.5 py-3 text-[13px] text-ink-subtle">
              No providers configured yet.
            </li>
          ) : (
            providers.map((provider) => (
              <ProviderRow
                key={provider.id}
                provider={provider}
                active={active?.provider === provider.id}
              />
            ))
          )}
        </ul>
      </section>

      <section aria-labelledby="settings-auth-heading" className="rounded-lg border border-line bg-surface-1 px-3.5 py-3.5">
        <div className="flex items-start gap-3">
          <KeyRound aria-hidden size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-ink-faint" />
          <div>
            <h2 id="settings-auth-heading" className="text-[13px] font-medium text-ink-strong">
              API keys and account login
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-ink-subtle">
              {routerConfigured
                ? "Codex Router is configured as a local provider bridge. Its account or OAuth state is managed by Codex Router outside CaliCode."
                : "OAuth and account-login flows are not wired into this build. Use a provider API key or a local provider instead."}
            </p>
          </div>
        </div>
      </section>

      <form
        aria-labelledby="settings-add-provider-heading"
        onSubmit={(event) => void submit(event)}
        className="border-t border-line pt-5"
      >
        <h2 id="settings-add-provider-heading" className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-subtle">
          Add or extend a provider
        </h2>
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
                  className="placeholder:text-ink-subtle"
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
                  className="placeholder:text-ink-subtle"
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
              className="placeholder:text-ink-subtle"
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
                className="placeholder:text-ink-subtle"
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
                className="placeholder:text-ink-subtle"
                type="password"
                autoComplete="off"
                placeholder="sk-…"
                value={apiKey}
                disabled={busy}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </div>
          </div>
          <p className="text-[11px] leading-relaxed text-ink-subtle">
            API keys are sent to core for the running session and are never stored by the client. Use the environment
            variable shown above for durable authentication.
          </p>
        </div>

        {error ? (
          <p role="alert" className="mt-3 text-xs text-danger-soft">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="mt-3 rounded-md border border-line bg-surface-2 px-3 py-2.5 text-xs leading-relaxed text-ink">
            {notice}
          </p>
        ) : null}

        <div className="mt-4 flex justify-end">
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? "Saving…" : "Save provider"}
          </Button>
        </div>
      </form>
    </div>
  );
}

function ThemeSection({
  theme,
  onThemeChange,
}: {
  theme: SettingsTheme;
  onThemeChange: (theme: SettingsTheme) => void;
}) {
  return (
    <div className="space-y-5">
      <section aria-labelledby="settings-appearance-heading">
        <h2 id="settings-appearance-heading" className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-subtle">
          Appearance
        </h2>
        <p className="mt-1 text-xs text-ink-faint">Choose the surface and chrome contrast used throughout CaliCode.</p>
        <div role="group" aria-label="Theme" className="mt-3 grid max-w-md grid-cols-2 gap-2">
          {([
            { id: "light", label: "Light", icon: Sun, hint: "Bright surfaces" },
            { id: "dark", label: "Dark", icon: Moon, hint: "Low-light surfaces" },
          ] as const).map((option) => {
            const Icon = option.icon;
            const selected = theme === option.id;
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={selected}
                onClick={() => onThemeChange(option.id)}
                className={`flex items-center gap-3 rounded-lg border px-3.5 py-3 text-left transition-colors ${
                  selected
                    ? "border-line-strong bg-surface-3 text-ink-strong"
                    : "border-line bg-surface-1 text-ink-subtle hover:bg-surface-2 hover:text-ink-strong"
                }`}
              >
                <Icon aria-hidden size={17} strokeWidth={1.7} className="shrink-0" />
                <span>
                  <span className="block text-[13px] font-medium">{option.label}</span>
                  <span className="mt-0.5 block text-[11px] text-ink-subtle">{option.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="rounded-lg border border-line bg-surface-1 px-3.5 py-3.5">
        <p className="text-[13px] text-ink-strong">Theme preference is stored on this device.</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-subtle">
          It applies immediately to the editor and is kept in local storage; no game document is changed.
        </p>
      </section>
    </div>
  );
}

export function SettingsPage({
  open,
  onClose,
  modelList,
  onChanged,
  onSessionsChanged,
  projectSlug,
  theme,
  onThemeChange,
}: SettingsPageProps) {
  const [section, setSection] = useState<SettingsSection>("general");
  const overlayControls = hasOverlayWindowControls();
  useEffect(() => {
    if (!open) {
      setSection("general");
      return;
    }
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const previousBodyOverflow = document.body.style.overflow;
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.body.style.overflow = previousBodyOverflow;
    };
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex min-h-0 overflow-hidden bg-surface-0 text-ink" data-settings-page>
      <aside className="flex w-[220px] shrink-0 flex-col border-r border-line bg-surface-1 pb-3 max-md:w-[168px]">
        <div
          data-tauri-drag-region="deep"
          className={`flex h-10 shrink-0 select-none items-center ${overlayControls ? "pl-[80px] pr-2" : "px-3"}`}
        >
          <button
            type="button"
            autoFocus
            aria-label="Back to workspace"
            onClick={onClose}
            className="inline-flex h-7 translate-y-px items-center gap-1.5 rounded-md px-1.5 text-[13px] font-semibold text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink-strong"
          >
            <ArrowLeft aria-hidden size={15} strokeWidth={1.7} className="shrink-0" />
            <span>Workspace</span>
          </button>
        </div>
        <div className="border-t border-line px-4 py-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">CaliCode</p>
          <p className="mt-1 text-[15px] font-semibold text-ink-strong">Settings</p>
        </div>
        <SectionNav active={section} onSelect={setSection} />
        <div className="mt-auto border-t border-line px-4 pt-3">
          <p className="text-[10px] leading-relaxed text-ink-faint">Changes apply to this CaliCode installation.</p>
        </div>
      </aside>

      <main
        className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        aria-labelledby="settings-title"
      >
        <PageHeader section={section} onClose={onClose} />
        <div className="mx-auto max-w-3xl px-5 py-6 md:px-8 md:py-8">
          <div
            role="tabpanel"
            id="settings-panel-general"
            aria-labelledby="settings-tab-general"
            hidden={section !== "general"}
          >
            <GeneralSection projectSlug={projectSlug} />
          </div>
          <div
            role="tabpanel"
            id="settings-panel-status"
            aria-labelledby="settings-tab-status"
            hidden={section !== "status"}
          >
            {/* Mounted only while selected: the ledger is read on mount, so a
                hidden panel would show numbers from whenever settings opened. */}
            {section === "status" && <StatusSection />}
          </div>
          <div
            role="tabpanel"
            id="settings-panel-providers"
            aria-labelledby="settings-tab-providers"
            hidden={section !== "providers"}
          >
            <ProvidersSection modelList={modelList} onChanged={onChanged} />
          </div>
          <div
            role="tabpanel"
            id="settings-panel-skills"
            aria-labelledby="settings-tab-skills"
            hidden={section !== "skills"}
          >
            <SkillsSection projectSlug={projectSlug} />
          </div>
          <div
            role="tabpanel"
            id="settings-panel-mcp"
            aria-labelledby="settings-tab-mcp"
            hidden={section !== "mcp"}
          >
            <McpSection headingLevel={2} />
          </div>
          <div
            role="tabpanel"
            id="settings-panel-archive"
            aria-labelledby="settings-tab-archive"
            hidden={section !== "archive"}
          >
            {/* Mounted only while selected: the archive is read on mount, so a
                hidden panel would show whatever was archived when settings
                opened rather than now. */}
            {section === "archive" && <ArchiveSection onSessionsChanged={onSessionsChanged} />}
          </div>
          <div
            role="tabpanel"
            id="settings-panel-theme"
            aria-labelledby="settings-tab-theme"
            hidden={section !== "theme"}
          >
            <ThemeSection theme={theme} onThemeChange={onThemeChange} />
          </div>
        </div>
      </main>
    </div>
  );
}
