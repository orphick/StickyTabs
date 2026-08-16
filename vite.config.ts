import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Tauri serves the dev build over a fixed port and expects the bundle in ../dist.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    // Pinned to IPv4. Left as "localhost", Vite binds ::1 on Windows while Tauri probes
    // 127.0.0.1, and `tauri dev` waits forever for a server that is already running.
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "chrome105",
    minify: "esbuild",
    sourcemap: false,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
