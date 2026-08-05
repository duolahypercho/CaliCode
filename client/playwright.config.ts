import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:5199",
  },
  webServer: {
    command: "pnpm dev",
    url: "http://127.0.0.1:5199",
    reuseExistingServer: true,
  },
});
