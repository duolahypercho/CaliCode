import { useMemo, useState } from "react";
import { Check, ExternalLink, Search } from "lucide-react";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { assetRepos, type AssetRepo, type RepoCategory, type RepoSettingValue } from "../../lib/assetLibrary";

export interface AssetsLibraryPageProps {
  /** Repo ids already installed (attached) to the current project. */
  installedRepoIds: string[];
  /** Attach the repo to the current project so the editor/agent can use it. */
  onInstall: (repoId: string) => void;
  /** Detach it again. */
  onUninstall: (repoId: string) => void;
  /** Title of the game the install applies to, e.g. "Starter". */
  projectTitle: string;
}

/** Display order for category filter chips; only categories present render. */
const CATEGORY_ORDER: RepoCategory[] = ["vfx", "shader", "model", "audio", "tooling", "reference"];

/**
 * Extension point: the registry does not carry imagery today, but a future
 * `AssetRepo` may gain a `media` field. Accessed defensively — when absent we
 * show only the generated placeholder visual, never fabricated screenshots.
 */
interface RepoMedia {
  images?: string[];
  video?: string;
}

function repoMedia(repo: AssetRepo): RepoMedia | undefined {
  const media = (repo as AssetRepo & { media?: RepoMedia }).media;
  return media && typeof media === "object" ? media : undefined;
}

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

/** Deterministic decorative gradient derived from the repo id. */
function repoGradient(id: string): string {
  const hash = hashString(id);
  const h1 = hash % 360;
  const h2 = (h1 + 40 + (hash % 70)) % 360;
  return `linear-gradient(135deg, hsl(${h1} 38% 56%), hsl(${h2} 42% 32%))`;
}

/** "github.com/user/repo" from a full URL; falls back to the raw string. */
function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname.replace(/\/$/, "")}`;
  } catch {
    return url;
  }
}

function formatDefault(value: RepoSettingValue): string {
  if (typeof value === "boolean") return value ? "On" : "Off";
  return String(value);
}

function matchesQuery(repo: AssetRepo, query: string): boolean {
  const haystack = [repo.name, repo.description, ...repo.tags].join(" ").toLowerCase();
  return haystack.includes(query);
}

function RepoVisual({ repo, tall }: { repo: AssetRepo; tall?: boolean }) {
  return (
    <div
      aria-hidden
      className={`relative w-full ${tall ? "h-40 rounded-lg" : "h-24"}`}
      style={{ background: repoGradient(repo.id) }}
    >
      <span className="absolute bottom-2 left-2.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-white/85">
        {repo.category}
      </span>
    </div>
  );
}

function TagPills({ tags }: { tags: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <span key={tag} className="rounded bg-surface-2 px-1.5 py-px text-[10px] text-ink-subtle">
          {tag}
        </span>
      ))}
    </div>
  );
}

/**
 * Full-window Assets Library: a searchable, filterable card grid over the
 * curated repo registry, with a per-repo detail dialog that installs the pack
 * into the current game.
 */
export function AssetsLibraryPage({ installedRepoIds, onInstall, onUninstall, projectTitle }: AssetsLibraryPageProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<RepoCategory | "all">("all");
  const [openRepoId, setOpenRepoId] = useState<string | null>(null);

  const categories = useMemo(
    () => CATEGORY_ORDER.filter((entry) => assetRepos.some((repo) => repo.category === entry)),
    [],
  );

  const normalizedQuery = query.trim().toLowerCase();
  const visibleRepos = assetRepos.filter(
    (repo) =>
      (category === "all" || repo.category === category) &&
      (normalizedQuery === "" || matchesQuery(repo, normalizedQuery)),
  );

  const openRepo = openRepoId ? assetRepos.find((repo) => repo.id === openRepoId) ?? null : null;
  const installed = new Set(installedRepoIds);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-surface-0">
      <div className="mx-auto w-full max-w-5xl px-6 py-6">
        <h1 className="text-[15px] font-semibold text-ink-strong">Assets Library</h1>
        <p className="mt-1 text-[12px] text-ink-subtle">
          Curated packs, shaders and tools you can install into {projectTitle}
        </p>

        <div className="mt-4 flex flex-col gap-2.5 sm:flex-row sm:items-center">
          <div className="relative w-full sm:max-w-xs">
            <Search aria-hidden size={14} strokeWidth={1.8} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
            <input
              type="search"
              aria-label="Search assets"
              placeholder="Search assets"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-8 w-full rounded-md border border-line bg-transparent pl-8 pr-3 text-[13px] text-ink placeholder:text-ink-faint focus-visible:outline-none"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {(["all", ...categories] as const).map((entry) => {
              const selected = category === entry;
              return (
                <button
                  key={entry}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setCategory(entry)}
                  className={`rounded-full border border-line px-2.5 py-1 text-[11px] transition-colors focus-visible:outline-none ${
                    selected ? "bg-surface-3 text-ink-strong" : "text-ink-subtle hover:bg-surface-2"
                  }`}
                >
                  {entry === "all" ? "All" : entry}
                </button>
              );
            })}
          </div>
        </div>

        {visibleRepos.length === 0 ? (
          <div className="flex min-h-48 items-center justify-center">
            <p className="text-[13px] text-ink-subtle">No assets match</p>
          </div>
        ) : (
          <div className="mt-5 grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
            {visibleRepos.map((repo) => {
              const isInstalled = installed.has(repo.id);
              return (
                <button
                  key={repo.id}
                  type="button"
                  aria-label={repo.name}
                  data-asset-card={repo.id}
                  onClick={() => setOpenRepoId(repo.id)}
                  className="group overflow-hidden rounded-lg border border-line bg-surface-0 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none"
                >
                  <RepoVisual repo={repo} />
                  <div className="flex flex-col gap-1.5 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-[13px] font-semibold text-ink-strong">{repo.name}</span>
                      {isInstalled ? (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded bg-surface-3 px-1.5 py-px text-[10px] font-medium text-ink">
                          <Check aria-hidden size={11} strokeWidth={2.2} />
                          Installed
                        </span>
                      ) : null}
                    </div>
                    <span className="line-clamp-1 text-[12px] text-ink-subtle">{repo.description}</span>
                    <TagPills tags={repo.tags} />
                    {repo.license ? <span className="text-[10px] text-ink-faint">{repo.license}</span> : null}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <Dialog open={openRepo !== null} onOpenChange={(open) => !open && setOpenRepoId(null)}>
        {openRepo ? (
          <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-[560px] overflow-y-auto border-line-strong bg-popover p-4 shadow-xl md:p-5">
            {(() => {
              const media = repoMedia(openRepo);
              const isInstalled = installed.has(openRepo.id);
              return (
                <>
                  {media?.images?.length ? (
                    <img
                      src={media.images[0]}
                      alt={`${openRepo.name} preview`}
                      className="h-40 w-full rounded-lg object-cover"
                    />
                  ) : (
                    <RepoVisual repo={openRepo} tall />
                  )}

                  <DialogTitle className="mt-4 text-[15px] font-semibold text-ink-strong">{openRepo.name}</DialogTitle>
                  <DialogDescription className="mt-1.5 text-[13px] leading-relaxed text-ink">
                    {openRepo.description}
                  </DialogDescription>

                  <div className="mt-3">
                    <TagPills tags={openRepo.tags} />
                  </div>

                  <div className="mt-4 border-t border-line pt-3">
                    <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-ink-faint">Credit</div>
                    <a
                      href={openRepo.url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1.5 inline-flex items-center gap-1.5 rounded text-[12px] text-ink hover:text-ink-strong focus-visible:outline-none"
                    >
                      <span className="break-all">{displayUrl(openRepo.url)}</span>
                      <ExternalLink aria-hidden size={12} strokeWidth={1.8} className="shrink-0" />
                    </a>
                    {openRepo.license ? (
                      <div className="mt-1 text-[11px] text-ink-subtle">License: {openRepo.license}</div>
                    ) : null}
                  </div>

                  {openRepo.settings.length > 0 ? (
                    <div className="mt-4 border-t border-line pt-3">
                      <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-ink-faint">
                        Options you can tune after install
                      </div>
                      <dl className="mt-1.5">
                        {openRepo.settings.map((setting) => (
                          <div
                            key={setting.key}
                            className="flex items-baseline justify-between gap-3 border-b border-line py-1.5 last:border-b-0"
                          >
                            <dt className="text-[12px] text-ink">{setting.label}</dt>
                            <dd className="font-mono text-[11px] text-ink-subtle">{formatDefault(setting.default)}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  ) : null}

                  <div className="mt-5 flex items-center justify-end gap-2">
                    {isInstalled ? (
                      <>
                        <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-subtle">
                          <Check aria-hidden size={13} strokeWidth={2.2} />
                          Installed
                        </span>
                        <Button type="button" variant="outline" size="sm" onClick={() => onUninstall(openRepo.id)}>
                          Remove
                        </Button>
                      </>
                    ) : (
                      <Button type="button" size="sm" onClick={() => onInstall(openRepo.id)}>
                        Install to {projectTitle}
                      </Button>
                    )}
                  </div>
                </>
              );
            })()}
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
