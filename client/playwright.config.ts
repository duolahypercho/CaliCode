import { defineConfig } from "@playwright/test";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The suite writes real projects through core, so it gets its own projects
 * root. Pointed at the default `~/.cali/projects` it permanently mutated the
 * shared `starter` project on every run — accumulated drift had already
 * flipped a passing assertion to failing, which makes results depend on how
 * many times the suite had previously run on that machine.
 */
// ESM: no __dirname.
const PROJECTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), ".e2e-projects");
rmSync(PROJECTS_DIR, { recursive: true, force: true });

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
