import {
  Binary,
  Box,
  Braces,
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileCog,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  Globe,
  Hash,
  Lock,
  Terminal,
  type LucideIcon,
} from "lucide-react";

/**
 * Tint tokens from `index.css`. Kept as a closed union so a typo lands on
 * `tsc` rather than on a row that silently renders with no colour.
 */
export type FileTone =
  "blue" | "cyan" | "green" | "yellow" | "orange" | "red" | "purple" | "pink" | "muted";

export interface FileGlyph {
  Icon: LucideIcon;
  tone: FileTone;
}

const TONE_CLASS: Record<FileTone, string> = {
  blue: "text-file-blue",
  cyan: "text-file-cyan",
  green: "text-file-green",
  yellow: "text-file-yellow",
  orange: "text-file-orange",
  red: "text-file-red",
  purple: "text-file-purple",
  pink: "text-file-pink",
  muted: "text-ink-faint",
};

export function toneClass(tone: FileTone): string {
  return TONE_CLASS[tone];
}

/** Whole-name matches win over the extension: `package.json` is not just JSON. */
const BY_NAME: Record<string, FileGlyph> = {
  "package.json": { Icon: Box, tone: "red" },
  "package-lock.json": { Icon: Lock, tone: "muted" },
  "pnpm-lock.yaml": { Icon: Lock, tone: "muted" },
  "cargo.toml": { Icon: Box, tone: "orange" },
  "cargo.lock": { Icon: Lock, tone: "muted" },
  dockerfile: { Icon: Box, tone: "blue" },
  makefile: { Icon: FileCog, tone: "muted" },
  "readme.md": { Icon: FileText, tone: "blue" },
  license: { Icon: FileText, tone: "yellow" },
  ".gitignore": { Icon: FileCog, tone: "orange" },
  ".env": { Icon: FileCog, tone: "yellow" },
};

const BY_EXTENSION: Record<string, FileGlyph> = {
  ts: { Icon: FileCode2, tone: "blue" },
  tsx: { Icon: FileCode2, tone: "blue" },
  mts: { Icon: FileCode2, tone: "blue" },
  cts: { Icon: FileCode2, tone: "blue" },
  js: { Icon: FileCode2, tone: "yellow" },
  jsx: { Icon: FileCode2, tone: "yellow" },
  mjs: { Icon: FileCode2, tone: "yellow" },
  cjs: { Icon: FileCode2, tone: "yellow" },
  rs: { Icon: FileCode2, tone: "orange" },
  py: { Icon: FileCode2, tone: "cyan" },
  go: { Icon: FileCode2, tone: "cyan" },
  rb: { Icon: FileCode2, tone: "red" },
  swift: { Icon: FileCode2, tone: "orange" },
  java: { Icon: FileCode2, tone: "red" },
  kt: { Icon: FileCode2, tone: "purple" },
  c: { Icon: FileCode2, tone: "blue" },
  h: { Icon: FileCode2, tone: "purple" },
  cpp: { Icon: FileCode2, tone: "blue" },
  hpp: { Icon: FileCode2, tone: "purple" },
  glsl: { Icon: FileCode2, tone: "pink" },
  wgsl: { Icon: FileCode2, tone: "pink" },
  json: { Icon: Braces, tone: "yellow" },
  jsonc: { Icon: Braces, tone: "yellow" },
  yaml: { Icon: FileCog, tone: "purple" },
  yml: { Icon: FileCog, tone: "purple" },
  toml: { Icon: FileCog, tone: "purple" },
  ini: { Icon: FileCog, tone: "muted" },
  env: { Icon: FileCog, tone: "yellow" },
  lock: { Icon: Lock, tone: "muted" },
  html: { Icon: Globe, tone: "orange" },
  htm: { Icon: Globe, tone: "orange" },
  css: { Icon: Hash, tone: "cyan" },
  scss: { Icon: Hash, tone: "pink" },
  md: { Icon: FileText, tone: "blue" },
  mdx: { Icon: FileText, tone: "blue" },
  txt: { Icon: FileText, tone: "muted" },
  csv: { Icon: FileText, tone: "green" },
  sh: { Icon: Terminal, tone: "green" },
  bash: { Icon: Terminal, tone: "green" },
  zsh: { Icon: Terminal, tone: "green" },
  png: { Icon: FileImage, tone: "purple" },
  jpg: { Icon: FileImage, tone: "purple" },
  jpeg: { Icon: FileImage, tone: "purple" },
  gif: { Icon: FileImage, tone: "purple" },
  webp: { Icon: FileImage, tone: "purple" },
  svg: { Icon: FileImage, tone: "orange" },
  ico: { Icon: FileImage, tone: "purple" },
  mp3: { Icon: FileAudio, tone: "pink" },
  wav: { Icon: FileAudio, tone: "pink" },
  ogg: { Icon: FileAudio, tone: "pink" },
  mp4: { Icon: FileVideo, tone: "pink" },
  mov: { Icon: FileVideo, tone: "pink" },
  webm: { Icon: FileVideo, tone: "pink" },
  zip: { Icon: FileArchive, tone: "muted" },
  gz: { Icon: FileArchive, tone: "muted" },
  tar: { Icon: FileArchive, tone: "muted" },
  glb: { Icon: Box, tone: "green" },
  gltf: { Icon: Box, tone: "green" },
  obj: { Icon: Box, tone: "green" },
  fbx: { Icon: Box, tone: "green" },
  wasm: { Icon: Binary, tone: "purple" },
};

const FALLBACK: FileGlyph = { Icon: File, tone: "muted" };

/** The icon and tint a file row wears, chosen from its name alone. */
export function fileGlyph(name: string): FileGlyph {
  const lower = name.toLowerCase();
  const named = BY_NAME[lower];
  if (named) return named;
  const dot = lower.lastIndexOf(".");
  // A leading dot is the whole name of a dotfile, not an extension marker.
  if (dot <= 0) return FALLBACK;
  return BY_EXTENSION[lower.slice(dot + 1)] ?? FALLBACK;
}

export function folderGlyph(open: boolean): FileGlyph {
  return { Icon: open ? FolderOpen : Folder, tone: "blue" };
}
