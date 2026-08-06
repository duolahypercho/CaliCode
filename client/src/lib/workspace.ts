import { rpc } from "./rpc";

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

export const openWorkspace = (path: string, name?: string) =>
  rpc<WorkspaceInfo>("workspace_open", { path, name });

export const listWorkspaces = () => rpc<WorkspaceInfo[]>("workspace_list", {});

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
