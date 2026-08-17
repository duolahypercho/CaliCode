import { rpc } from "./rpc";
import type { WorkspaceInfo } from "./workspace";

/**
 * Starters scaffold a *folder* — a package.json, sources, a dev script — which
 * is what `workspace_open` accepts. Project templates (`project_create`'s
 * `template`) are a different thing entirely: a scene document the three.js
 * editor owns. Anything with its own build lives in a workspace.
 */
export interface Starter {
  id: string;
  name: string;
  description: string;
  tags: string[];
  devScript: string;
  /** Command the user runs to install dependencies. Core never spawns it. */
  install: string | null;
  scope: "builtin" | "user";
}

export interface CreatedWorkspace {
  workspace: WorkspaceInfo;
  starter: Starter;
  install: string | null;
}

export const listStarters = () =>
  rpc<{ starters: Starter[] }>("starter_list", {}).then((result) => result.starters);

/** Writes the tree and attaches the result, so the new folder is never orphaned. */
export const createWorkspaceFromStarter = (templateId: string, path: string, name?: string) =>
  rpc<CreatedWorkspace>("workspace_create_from_template", { templateId, path, name });

/**
 * Where a new game folder goes by default. `~` is expanded by core, which is
 * also the only side that can decide whether the path is allowed.
 */
export function defaultStarterPath(slug: string): string {
  return `~/CaliCode/${slug || "new-game"}`;
}
