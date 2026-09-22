declare const process: { env: Record<string, string | undefined> };
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

/* Served by the static site at /app/ (the classic console moved to
   /app-classic). Everything is relative to that base; the router is
   hash-based, so the host needs no rewrite rules. */
export default defineConfig({
  base: process.env.WARDA_BASE ?? "/app/",
  plugins: [react(), tailwind()],
  build: { outDir: "dist", assetsDir: "assets", sourcemap: false },
});
