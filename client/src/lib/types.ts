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

export interface AgentMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  tool?: string;
}

export interface BrowserTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

