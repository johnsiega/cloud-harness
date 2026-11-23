import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

// Dev: the UI runs on 5173 and proxies the control plane (127.0.0.1:3000), so there is no CORS and SSE streams through.
// Build: emits to dist/web, which api/main.ts serves from the same loopback origin.
export default defineConfig({
  root,
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5173, proxy: { "/runs": { target: "http://127.0.0.1:3000", changeOrigin: false } } },
  build: { outDir: fileURLToPath(new URL("../dist/web", import.meta.url)), emptyOutDir: true },
});
