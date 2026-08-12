import { rpc } from "./rpc";
import type { Project } from "./types";
import { isDesktopShell } from "./desktop";

export interface WorkspaceInfo {
  id: string;
  name: string;
  root: string;
  hasPackageJson: boolean;
  hasGit: boolean;
  scripts: Record<string, string>;
  entries: string[];
}

export interface FileNode {
  name: string;
  path: string;
  kind: "dir" | "file";
  size: number;
  children?: FileNode[];
}

export interface FileContent {
  path: string;
  content: string;
  encoding: "utf8" | "binary";
  bytes: number;
  sha256: string;
  truncated: boolean;
}

export type DevServerState = "stopped" | "starting" | "ready" | "crashed";

export interface DevServerStatus {
  workspaceId: string;
  status: DevServerState;
  url?: string;
  port?: number;
}

export interface FolderEntry {
  name: string;
  path: string;
  /** True when the folder has a package.json or .git, so `workspace_open` accepts it. */
  isProject: boolean;
}

export interface FolderListing {
  path: string;
  parent: string | null;
  dirs: FolderEntry[];
}

/** The bundled core is a separate process and may not inherit macOS TCC scope. */
export const NATIVE_WORKSPACE_OPEN_TIMEOUT_MS = 1_200;

function nativeWorkspaceAccessError(path: string): Error {
  return new Error(
    `CaliCode's bundled core could not access "${path}" within ${NATIVE_WORKSPACE_OPEN_TIMEOUT_MS}ms. ` +
      "Grant CaliCode access in System Settings > Privacy & Security > Files and Folders, " +
      "then try again, or choose a folder the app can already read.",
  );
}

/** Directory names only — backs the in-app folder picker. */
export const browseFolders = (path?: string) =>
  rpc<FolderListing>("workspace_browse", path ? { path } : {});

export async function openWorkspace(path: string, name?: string): Promise<WorkspaceInfo> {
  const request = rpc<WorkspaceInfo>("workspace_open", { path, name });
  if (!isDesktopShell()) return request;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<WorkspaceInfo>((_, reject) => {
        timer = setTimeout(() => reject(nativeWorkspaceAccessError(path)), NATIVE_WORKSPACE_OPEN_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Ask the native shell for a directory selection. Browsers keep using the
 * core folder browser; a packaged macOS app must go through NSOpenPanel for
 * Desktop, Documents, external volumes, and other TCC-protected roots. The
 * bundled core is a separate process, so `openWorkspace` still verifies that
 * it can use the selected path and fails fast when the scope did not carry.
 */
export async function chooseNativeWorkspace(defaultPath?: string): Promise<string | null> {
  if (!isDesktopShell()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    directory: true,
    multiple: false,
    recursive: true,
    fileAccessMode: "scoped",
    canCreateDirectories: false,
    defaultPath,
    title: "Choose a game folder",
  });
  return typeof selected === "string" ? selected : null;
}

export const listWorkspaces = () => rpc<WorkspaceInfo[]>("workspace_list", {});

/**
 * Bind a game to its own folder (or detach with `null`). Each game is a unique
 * workspace, so this travels with the project document rather than being a
 * single global attachment.
 */
export const setProjectWorkspace = (slug: string, workspaceRoot: string | null) =>
  rpc<Project>("project_set_workspace", { slug, workspaceRoot });

export const closeWorkspace = (id: string) => rpc<{ closed: boolean }>("workspace_close", { id });

/** Lazily expanded one level at a time — the SF repo's public/data alone is ~410MB. */
export const readTree = (id: string, path = "", depth = 1) =>
  rpc<{ path: string; entries: FileNode[] }>("workspace_tree", { id, path, depth });

export const readWorkspaceFile = (id: string, path: string) =>
  rpc<FileContent>("workspace_file_read", { id, path });

/** `expectedSha256` guards against clobbering a file HMR or git changed underneath the buffer. */
export const writeWorkspaceFile = (id: string, path: string, content: string, expectedSha256?: string) =>
  rpc<{ path: string; written: boolean; sha256: string }>("workspace_file_write", {
    id,
    path,
    content,
    expectedSha256,
  });

export const startDevServer = (id: string, script = "dev") =>
  rpc<DevServerStatus>("devserver_start", { id, script });

export const stopDevServer = (id: string) => rpc<{ stopped: boolean }>("devserver_stop", { id });

export const devServerStatus = (id: string) => rpc<DevServerStatus>("devserver_status", { id });
