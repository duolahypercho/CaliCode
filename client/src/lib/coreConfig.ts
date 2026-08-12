// Read-only client mirror of core's AppConfig (`config.read` RPC) — only the
// slices the UI renders. Field names match core's serde output (snake_case,
// see core/src/config.rs).

import { rpc } from "./rpc";

/** `tools: {include, exclude}` fnmatch filter on an MCP server entry. */
export interface McpToolFilter {
  include: string[];
  exclude: string[];
}

/** One entry under `mcp_servers:` in ~/.cali/config.yaml. */
export interface McpServerConfigEntry {
  id: string;
  transport?: string;
  command?: string;
  url?: string;
  enabled?: boolean;
  trust?: boolean;
  tools?: McpToolFilter;
}

/** `compaction:` block tuning core's context compaction. */
export interface CompactionConfig {
  auto: boolean;
  /** Fraction of the context window that triggers auto-compaction. */
  threshold: number;
  /** Tokens held back for the reply + summary overhead. */
  reserved: number;
  /** Fallback context window; null/absent = core's built-in default. */
  context_length?: number | null;
}

/** One entry under `permissions:` — first/last-match glob over tool names. */
export interface PermissionRuleEntry {
  pattern: string;
  action: string;
}

export interface CoreConfig {
  mcp_servers?: McpServerConfigEntry[];
  permissions?: PermissionRuleEntry[];
  compaction?: CompactionConfig;
}

/**
 * Core's built-in fallback context window when neither the config override nor
 * provider metadata knows better (core/src/agent.rs DEFAULT_CONTEXT_LENGTH).
 */
export const DEFAULT_CONTEXT_LENGTH = 128_000;

export const readCoreConfig = (): Promise<CoreConfig> => rpc<CoreConfig>("config.read");

/** The context window the meter measures occupancy against. */
export function contextWindowOf(config: CoreConfig | null): number {
  return config?.compaction?.context_length ?? DEFAULT_CONTEXT_LENGTH;
}

/** "934" / "12.4k" / "1.2M" — compact token counts for the meter and /usage. */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "0";
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) {
    const k = count / 1000;
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
  }
  return `${Math.round((count / 1_000_000) * 10) / 10}M`;
}
