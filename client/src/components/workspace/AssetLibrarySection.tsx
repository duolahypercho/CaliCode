import { useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, Minus, Package, Plus } from "lucide-react";
import { assetRepos, type AssetRepo, type RepoAttachment, type RepoSetting, type RepoSettingValue } from "../../lib/assetLibrary";

interface AssetLibrarySectionProps {
  /** Repos attached to the active game, keyed by repo id. */
  attached: Record<string, RepoAttachment>;
  onToggleRepo: (repoId: string, attach: boolean) => void;
  onRepoSetting: (repoId: string, key: string, value: RepoSettingValue) => void;
}

/**
 * Sidebar "Assets" section: the curated repo library. Each row links to the
 * upstream repo and can be attached to the active game; attached repos expose
 * their settings inline, saved into the game's project document.
 */
export function AssetLibrarySection({ attached, onToggleRepo, onRepoSetting }: AssetLibrarySectionProps) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <section aria-label="Asset library" className="mt-3 border-t border-line pt-2">
      <div className="flex items-center justify-between px-2">
        <div className="calicode-label">Assets</div>
        <span className="text-[9.5px] tabular-nums text-ink-faint">{Object.keys(attached).length}/{assetRepos.length}</span>
      </div>

      <div className="mt-1 max-h-[30dvh] overflow-y-auto pb-1 [scrollbar-width:thin]">
        {assetRepos.map((repo) => {
          const open = expanded === repo.id;
          const attachment = attached[repo.id];
          return (
            <div key={repo.id} className="mb-0.5">
              <div className="group relative">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setExpanded(open ? null : repo.id)}
                  className={`flex min-h-8 w-full items-center gap-1.5 rounded-md px-2 py-1.5 pr-8 text-left text-[12px] transition-colors focus-visible:outline-none ${
                    attachment ? "text-ink-strong" : "text-ink-subtle"
                  } hover:bg-surface-2 hover:text-ink-strong active:bg-surface-3`}
                >
                  {open ? (
                    <ChevronDown aria-hidden size={13} strokeWidth={1.8} className="shrink-0 text-ink-faint" />
                  ) : (
                    <ChevronRight aria-hidden size={13} strokeWidth={1.8} className="shrink-0 text-ink-faint" />
                  )}
                  <Package aria-hidden size={14} strokeWidth={1.7} className="shrink-0 text-ink-subtle" />
                  <span className="min-w-0 flex-1 truncate" title={repo.name}>
                    {repo.name}
                  </span>
                  <span className="shrink-0 rounded bg-surface-3 px-1 py-px text-[9px] font-bold uppercase tracking-[0.08em] text-ink-subtle">
                    {repo.category}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={attachment ? `Remove ${repo.name} from game` : `Add ${repo.name} to game`}
                  onClick={() => onToggleRepo(repo.id, !attachment)}
                  className={`absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded transition-[color,background-color,opacity] duration-150 hover:bg-surface-3 hover:text-ink-strong focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none ${
                    attachment
                      ? "text-ink"
                      : "pointer-events-none text-ink-subtle opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
                  }`}
                >
                  {attachment ? (
                    <Minus aria-hidden size={13} strokeWidth={1.8} />
                  ) : (
                    <Plus aria-hidden size={13} strokeWidth={1.8} />
                  )}
                </button>
              </div>

              {open ? (
                <div className="mb-1.5 ml-[13px] mt-1 flex flex-col gap-1.5 border-l border-line pl-2.5 pr-2">
                  <p className="text-[11px] leading-snug text-ink-subtle">{repo.description}</p>
                  <div className="flex flex-wrap items-center gap-1.5 text-[9.5px] text-ink-faint">
                    {repo.license ? <span className="rounded bg-surface-2 px-1 py-px">{repo.license}</span> : null}
                    {repo.tags.map((tag) => (
                      <span key={tag} className="rounded bg-surface-2 px-1 py-px">
                        {tag}
                      </span>
                    ))}
                  </div>
                  <a
                    href={repo.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] text-ink-subtle transition-colors hover:text-ink-strong"
                  >
                    <ExternalLink aria-hidden size={11} strokeWidth={1.8} />
                    <span className="truncate">View on GitHub</span>
                  </a>
                  {attachment ? (
                    <div className="flex flex-col gap-1">
                      {repo.settings.map((setting) => (
                        <SettingRow
                          key={setting.key}
                          repo={repo}
                          setting={setting}
                          value={attachment.settings[setting.key] ?? setting.default}
                          onChange={(value) => onRepoSetting(repo.id, setting.key, value)}
                        />
                      ))}
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onToggleRepo(repo.id, true)}
                      className="self-start rounded-md border border-line px-2 py-1 text-[10.5px] font-bold tracking-[0.08em] text-ink transition-colors hover:bg-surface-2 hover:text-ink-strong focus-visible:outline-none"
                    >
                      ADD TO GAME
                    </button>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * One setting input, compact enough for the rail. Text and number inputs
 * commit on blur or Enter so each keystroke does not write the project.
 */
function SettingRow({
  repo,
  setting,
  value,
  onChange,
}: {
  repo: AssetRepo;
  setting: RepoSetting;
  value: RepoSettingValue;
  onChange: (value: RepoSettingValue) => void;
}) {
  const inputId = `asset-repo-${repo.id}-${setting.key}`;

  if (setting.type === "boolean") {
    return (
      <label htmlFor={inputId} className="flex min-h-6 items-center justify-between gap-2 text-[11px] text-ink-subtle">
        <span className="truncate" title={setting.description ?? setting.label}>
          {setting.label}
        </span>
        <input
          id={inputId}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
          className="h-3.5 w-3.5 shrink-0 accent-[var(--line-strong)]"
        />
      </label>
    );
  }

  if (setting.type === "select") {
    return (
      <label htmlFor={inputId} className="flex min-h-6 items-center justify-between gap-2 text-[11px] text-ink-subtle">
        <span className="truncate" title={setting.description ?? setting.label}>
          {setting.label}
        </span>
        <select
          id={inputId}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
          className="w-[104px] shrink-0 rounded border border-line bg-surface-1 px-1 py-0.5 text-[11px] text-ink outline-none"
        >
          {(setting.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }

  const commit = (raw: string) => {
    if (setting.type === "number") {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return;
      const min = setting.min ?? -Infinity;
      const max = setting.max ?? Infinity;
      onChange(Math.min(max, Math.max(min, parsed)));
      return;
    }
    onChange(raw);
  };

  return (
    <label htmlFor={inputId} className="flex min-h-6 items-center justify-between gap-2 text-[11px] text-ink-subtle">
      <span className="truncate" title={setting.description ?? setting.label}>
        {setting.label}
      </span>
      <input
        id={inputId}
        type={setting.type === "number" ? "number" : "text"}
        defaultValue={String(value)}
        min={setting.min}
        max={setting.max}
        step={setting.step}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit(event.currentTarget.value);
        }}
        className="w-[104px] shrink-0 rounded border border-line bg-surface-1 px-1.5 py-0.5 text-[11px] text-ink outline-none"
      />
    </label>
  );
}
