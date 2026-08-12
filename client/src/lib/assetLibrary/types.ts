/**
 * The asset library: a curated registry of external repos (VFX, shaders,
 * models, tooling) the studio knows about. The library stores metadata only —
 * a link, tags, and a settings schema — never third-party source, so entries
 * carry no licensing weight of their own.
 *
 * Attaching a repo to a game records its id and chosen setting values in
 * `project.settings.assetRepos`, where the agent (and any tool reading the
 * project document) can pick them up.
 */

export type RepoSettingValue = boolean | number | string;

export interface RepoSetting {
  key: string;
  label: string;
  type: "boolean" | "number" | "string" | "select";
  default: RepoSettingValue;
  /** Choices when type is "select". */
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  description?: string;
}

export type RepoCategory = "vfx" | "shader" | "model" | "audio" | "tooling" | "reference";

export interface AssetRepo {
  /** Stable slug — the key attachments are stored under. Never change it. */
  id: string;
  name: string;
  /** Home of the source, usually a GitHub URL. */
  url: string;
  category: RepoCategory;
  description: string;
  tags: string[];
  /** SPDX-style license name of the upstream repo, when known. */
  license?: string;
  settings: RepoSetting[];
}

/** What a game stores per attached repo: the chosen setting values. */
export interface RepoAttachment {
  settings: Record<string, RepoSettingValue>;
}
