import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // CaliCode's dev server manager passes --host/--port/--strictPort
    // explicitly; nothing here should contradict that.
    host: "127.0.0.1",
  },
});
