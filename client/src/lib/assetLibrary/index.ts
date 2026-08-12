import type { Project } from "../types";
import type { AssetRepo, RepoAttachment, RepoSettingValue } from "./types";

export type { AssetRepo, RepoAttachment, RepoCategory, RepoSetting, RepoSettingValue } from "./types";

/**
 * Adding a repo to the library is one new file in `repos/` exporting `repo:
 * AssetRepo` — this glob picks it up, no index edit needed.
 */
const modules = import.meta.glob<{ repo: AssetRepo }>("./repos/*.ts", { eager: true });

export const assetRepos: AssetRepo[] = Object.values(modules)
  .map((module) => module.repo)
  .sort((a, b) => a.name.localeCompare(b.name));

/**
 * The registry as plain JSON for core's `asset_catalog_publish` RPC — the
 * agent-side `asset_search` "library" source reads this snapshot. Pushed by
 * App.tsx at startup, exactly like `tool_register` pushes browser tools
 * (the glob is build-time, so startup is the only time the set can change).
 */
export function catalogSnapshot(): Record<string, unknown>[] {
  return assetRepos.map((repo) => ({
    id: repo.id,
    name: repo.name,
    url: repo.url,
    category: repo.category,
    description: repo.description,
    tags: repo.tags,
    ...(repo.license ? { license: repo.license } : {}),
    settings: repo.settings.map((setting) => ({ ...setting })),
  }));
}

export function getRepo(id: string): AssetRepo | undefined {
  return assetRepos.find((repo) => repo.id === id);
}

/** The attachments a game has, keyed by repo id. Tolerates older projects. */
export function attachedRepos(project: Project): Record<string, RepoAttachment> {
  const raw = project.settings.assetRepos;
  return raw && typeof raw === "object" ? (raw as Record<string, RepoAttachment>) : {};
}

function withAttachments(project: Project, attachments: Record<string, RepoAttachment>): Project {
  return { ...project, settings: { ...project.settings, assetRepos: attachments } };
}

/** Attach a library repo to the game with its default setting values. */
export function attachRepo(project: Project, repoId: string): Project {
  const repo = getRepo(repoId);
  if (!repo || attachedRepos(project)[repoId]) return project;
  const settings = Object.fromEntries(repo.settings.map((setting) => [setting.key, setting.default]));
  return withAttachments(project, { ...attachedRepos(project), [repoId]: { settings } });
}

export function detachRepo(project: Project, repoId: string): Project {
  const current = attachedRepos(project);
  if (!(repoId in current)) return project;
  const { [repoId]: _removed, ...rest } = current;
  return withAttachments(project, rest);
}

export function setRepoSetting(project: Project, repoId: string, key: string, value: RepoSettingValue): Project {
  const current = attachedRepos(project);
  const attachment = current[repoId];
  if (!attachment) return project;
  return withAttachments(project, {
    ...current,
    [repoId]: { ...attachment, settings: { ...attachment.settings, [key]: value } },
  });
}
