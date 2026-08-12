// Client surface for SKILLS + MCP extensibility (docs/plans/skills-mcp.md §4.1):
// typed mirrors of core/src/skills.rs SkillInfo and core/src/mcp.rs
// McpServerReport, plus thin rpc wrappers over the skill_* / mcp_* methods.

import { rpc } from "./rpc";

export type SkillScope = "global" | "project";

export interface SkillInfo {
  name: string;
  description: string;
  scope: SkillScope;
  /** Absolute path of the skill file, for display. */
  path: string;
  /** Derived from the config's skills.disabled list. */
  enabled: boolean;
  /** Parse problem, if any — rows with an error cannot be toggled or loaded. */
  error?: string | null;
}

export interface McpToolInfo {
  /** Tool name as the server declared it. */
  remoteName: string;
  /** Namespaced name the agent calls: mcp__<serverId>__<name>. */
  namespaced: string;
  description: string;
}

export type McpServerStatus = "running" | "failed" | "disabled";

export interface McpServerReport {
  id: string;
  /** "stdio" or "http". */
  transport: string;
  command: string;
  /** Endpoint for transport: http; empty for stdio. */
  url: string;
  trust: boolean;
  status: McpServerStatus;
  /** Present when status === "failed". */
  error?: string | null;
  /** Empty unless status === "running"; already narrowed by the server's tool filter. */
  tools: McpToolInfo[];
  /** Declared by the open project's .cali/config.yaml rather than by the user. */
  projectScoped?: boolean;
  /** A project-scoped server awaiting approval: reported, but never spawned. */
  pendingConsent?: boolean;
}

export async function listSkills(projectSlug?: string): Promise<SkillInfo[]> {
  const result = await rpc<{ skills?: SkillInfo[] }>("skill_list", projectSlug ? { projectSlug } : {});
  return result?.skills ?? [];
}

export async function setSkillEnabled(scope: SkillScope, name: string, enabled: boolean): Promise<void> {
  await rpc("skill_set_enabled", { scope, name, enabled });
}

/** Full body preview for the UI — ignores the disabled list on the core side. */
export async function readSkill(
  name: string,
  projectSlug?: string,
): Promise<{ name: string; scope: SkillScope; path: string; instructions: string }> {
  return rpc("skill_read", { name, ...(projectSlug ? { projectSlug } : {}) });
}

export async function listMcpServers(): Promise<McpServerReport[]> {
  const result = await rpc<{ servers?: McpServerReport[] }>("mcp_list");
  return result?.servers ?? [];
}

export async function setMcpEnabled(id: string, enabled: boolean): Promise<McpServerReport[]> {
  const result = await rpc<{ servers?: McpServerReport[] }>("mcp_set_enabled", { id, enabled });
  return result?.servers ?? [];
}

/**
 * Approve (or revoke) the MCP servers the project at `base` declares in its
 * own `.cali/config.yaml`. Core recomputes the fingerprint itself, so this
 * always approves the config as it is on disk right now; editing that file
 * blocks its servers again.
 */
export async function approveProjectMcp(base: string, approve = true): Promise<McpServerReport[]> {
  const result = await rpc<{ servers?: McpServerReport[] }>("mcp_approve_project", { base, approve });
  return result?.servers ?? [];
}

/** Shut down all MCP servers, re-read config, and start again. */
export async function reloadMcp(): Promise<McpServerReport[]> {
  const result = await rpc<{ servers?: McpServerReport[] }>("mcp_reload");
  return result?.servers ?? [];
}
