import { cp } from "node:fs/promises";
import { defineConfig, type Plugin } from "vite";

/**
 * The dataset the pipeline commits to git is also the app's only backend.
 * In dev, Vite serves it straight from the repo root at /data/*.json. For a
 * build it has to be copied, because nothing imports it: the app fetches it at
 * runtime so a data-only commit republishes the site without a rebuild.
 */
const copyData = (): Plugin => ({
  name: "rasid-copy-data",
  apply: "build",
  closeBundle: async () => {
    await cp("data", "dist/data", { recursive: true });
  },
});

export default defineConfig({
  plugins: [copyData()],
  // GitHub Pages serves a project site from /<repo>/, so asset urls have to be
  // relative. Set to "/" if this ever moves to its own domain.
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  server: { port: 5173 },
});
