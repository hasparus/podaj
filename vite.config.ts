import { foldkit } from "@foldkit/vite-plugin";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [foldkit()],
  build: {
    emptyOutDir: true,
    outDir: "dist/client",
    rollupOptions: {
      input: resolve(import.meta.dirname, "index.html"),
    },
  },
  publicDir: "public",
});
