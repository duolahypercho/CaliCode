import { defineConfig } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// Keep every core-owned E2E resource under one disposable root. Core derives
// sessions/ and worktrees/ beside the projects directory, so putting projects
// directly under client/ leaked those resources into watched source paths.
const E2E_STATE_DIR = resolve(HERE, ".e2e-state");
const PROJECTS_DIR = resolve(E2E_STATE_DIR, "projects");
// Core reads ~/.cali/config.yaml by default, which now carries the developer's
// attached workspaces — and a restored workspace changes the editor's default
// view, so the suite silently started testing a different app. Isolating the
// projects directory alone was not enough.
const CONFIG_PATH = resolve(E2E_STATE_DIR, "config.yaml");

/**
 * The suite writes real projects through core, so it gets its own projects
 * root. Pointed at the default `~/.cali/projects` it permanently mutated the
 * shared `starter` project on every run.
 *
 * The directory is wiped by the `pretest:e2e` npm script, not from here.
 * Playwright evaluates this config once per process — the runner plus every
 * worker — and starts `webServer` before globalSetup, so a wipe in either
 * place deleted the project directory out from under the already-running
 * core. Core seeds `starter` only at startup, so `project_open` then failed
 * with "project starter not found" and the client silently fell back to its
 * local starter project.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:5199",
  },
  webServer: [
    {
      command: "cd ../core && cargo run",
      // /health, not /. The root serves the built client, which does not
      // exist until `pnpm build` has run — CI waited the full 180s on it.
      url: "http://127.0.0.1:8765/health",
      // Deliberately not reused: an already-running dev core would be using
      // the real projects directory, which is exactly what this isolates
      // against. Stop your dev core before running the suite.
      reuseExistingServer: false,
      timeout: 180_000,
      env: { CALI_PROJECTS_DIR: PROJECTS_DIR, CALI_CONFIG: CONFIG_PATH },
    },
    {
      command: "pnpm dev",
      url: "http://127.0.0.1:5199",
      reuseExistingServer: true,
    },
  ],
});
