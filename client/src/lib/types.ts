export type Vec3 = [number, number, number];

export interface Entity {
  id: string;
  name: string;
  kind: string;
  transform: { position: Vec3; rotation: Vec3; scale: Vec3 };
  material: Record<string, unknown>;
  light: Record<string, unknown>;
  scriptIds: string[];
  assetId: string | null;
}

export interface Script {
  id: string;
  name: string;
  code: string;
}

export interface Asset {
  id: string;
  name: string;
  type: "procedural" | "image" | "gltf" | "obj" | "cali";
  source: string;
  tags: string[];
  usage: string[];
  thumbnail: string | null;
  metadata?: Record<string, unknown>;
}

export interface GameTest {
  id: string;
  name: string;
  script: string;
}

export interface Project {
  schemaVersion: 1;
  slug: string;
  title: string;
  entities: Entity[];
  scripts: Script[];
  assets: Asset[];
  tests: GameTest[];
  settings: Record<string, unknown>;
  /**
   * The folder on disk this game owns. Each game is its own workspace, so
   * selecting a game switches the attached folder. Null means no folder is
   * attached yet.
   */
  workspaceRoot?: string | null;
}

export interface ModelInfo {
  provider: string;
  model: string;
  baseUrl: string;
}

export interface ProviderPreset {
  id: string;
  label: string;
  base_url: string;
  api_key_env: string;
  models?: string[];
}

export interface ModelList {
  active: ModelInfo;
  providers: ProviderPreset[];
}

export interface CapturedFrame {
  frame: number;
  timeMs: number;
  dataUrl: string;
}

export interface TestResult {
  id: string;
  name: string;
  pass: boolean;
  logs: string[];
  error?: string;
  baselineDistance?: number;
}

/**
 * Structured payload for the commands whose answer is a small readout rather
 * than prose. `content` stays populated beside it as the plain-text fallback —
 * saved transcripts, `/help` in a narrow panel, and anything that reads a
 * session back without this renderer still show something useful.
 */
export type CommandPanel =
  | {
      kind: "help";
      commands: { name: string; usage?: string; summary: string; skill?: boolean }[];
    }
  | {
      kind: "usage";
      promptTokens: number;
      completionTokens: number;
      cacheReadTokens: number;
      totalTokens: number;
      /** Context occupancy is the latest prompt, not the session total. */
      lastPromptTokens: number;
      lastCacheReadTokens: number;
      contextWindow: number;
      /** Fraction of the window that triggers auto-compaction; null = off. */
      autoCompactAt: number | null;
    };

export interface AgentMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  /** Renders in place of `content` when the client understands the kind. */
  panel?: CommandPanel;
  tool?: string;
  /** Tool rows only: lifecycle of the execution. Absent = informational line. */
  status?: "running" | "done" | "error";
  /** Tool rows only: full output, shown when the row is expanded. */
  detail?: string;
  /** Provider tool-call identity; pairing must not rely on tool names. */
  toolCallId?: string;
  /** Client-owned Enter-level activity grouping identity. */
  turnId?: string;
  /** Activity marker/tool start timestamp (epoch milliseconds). */
  startedAtMs?: number;
  /** Activity marker/tool completion timestamp (epoch milliseconds). */
  completedAtMs?: number;
  /**
   * Turn markers only: the turn ended because the user stopped it. Distinct
   * from `status`, which reaches "done" either way — without this a cancelled
   * turn rendered as "✔ Completed" directly above its own "Turn cancelled"
   * line.
   */
  stopped?: boolean;
  /** Bounded file change metadata; raw before/after snapshots are omitted. */
  activity?: import("./activity").ActivityFileChange;
}

export type { ActivityFileChange } from "./activity";

export interface BrowserTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface SubagentResult {
  role: string;
  sessionId: string;
  reply: string;
  toolCalls: unknown[];
  turns: number;
}

/**
 * One row of the per-model token ledger (`usage_stats`).
 *
 * The three prompt classes are disjoint — core subtracts cache reads and
 * writes out of the provider's prompt total — so they sum to `promptTotal`.
 */
export interface ModelUsageRow {
  /** `provider/model`, and the row's stable identity. */
  key: string;
  provider: string;
  model: string;
  requests: number;
  /** Prompt tokens billed at full price. */
  promptTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** `promptTokens + cacheReadTokens + cacheWriteTokens`. */
  promptTotal: number;
  /** Cache reads over `promptTotal`; null before the model is ever called. */
  cacheHitRate: number | null;
}

/** One day's activity bucket. `date` is `YYYY-MM-DD` in core's local time. */
export interface UsageDay extends Omit<ModelUsageRow, "key" | "provider" | "model"> {
  date: string;
}

export interface UsageActivity {
  /** Days that reported at least one token. */
  activeDays: number;
  /** Consecutive active days ending today, or yesterday if today is idle. */
  currentStreak: number;
  longestStreak: number;
  busiestDay: { date: string; totalTokens: number } | null;
}

export interface UsageStats {
  /** Unix seconds the ledger started counting; survives core restarts. */
  since: number;
  /** Core's local `YYYY-MM-DD`, so the heatmap ends on core's today. */
  today: string;
  models: ModelUsageRow[];
  /** Date-ordered and sparse — idle days are absent, not zero-filled. */
  days: UsageDay[];
  activity: UsageActivity;
  totals: Omit<ModelUsageRow, "key" | "provider" | "model">;
}
