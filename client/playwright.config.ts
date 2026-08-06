import { defineConfig } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), ".e2e-projects");

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
      url: "http://127.0.0.1:8765/",
      // Deliberately not reused: an already-running dev core would be using
      // the real projects directory, which is exactly what this isolates
      // against. Stop your dev core before running the suite.
      reuseExistingServer: false,
      timeout: 180_000,
      env: { CALI_PROJECTS_DIR: PROJECTS_DIR },
    },
    {
      command: "pnpm dev",
      url: "http://127.0.0.1:5199",
      reuseExistingServer: true,
    },
  ],
});
