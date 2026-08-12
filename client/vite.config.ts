import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** Core's origin. CALI_PORT must match what core was launched with. */
const CORE_ORIGIN = `http://127.0.0.1:${process.env.CALI_PORT ?? 8765}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    // Configurable so two instances can coexist. CALI_CLIENT_PORT must match
    // whatever core is told via CALI_CLIENT_PORT, so its CORS allowlist
    // accepts this origin.
    port: Number(process.env.CALI_CLIENT_PORT ?? 5199),
    strictPort: true,
    // Desktop packaging copies its bundle into src-tauri/resources and
    // Rust/Tauri writes large, frequently changing trees under src-tauri and
    // client/worktrees. Watching those generated files makes Vite restart the
    // browser editor while a build or agent session is still in progress.
    // Keep real client/src changes watched; only generated roots are ignored.
    watch: {
      ignored: [
        "**/src-tauri/target/**",
        "**/src-tauri/resources/**",
        "**/src-tauri/binaries/**",
        "**/worktrees/**",
        "**/sessions/**",
        "**/.e2e-projects/**",
        "**/.e2e-state/**",
      ],
    },
    proxy: {
      "/rpc": CORE_ORIGIN,
      // Imported and Blender-exported glTF files are served by core. Without
      // this route, Vite's SPA fallback returns index.html to GLTFLoader.
      "/projects": CORE_ORIGIN,
      "/events": {
        target: CORE_ORIGIN,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
