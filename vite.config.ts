import { foldkit } from "@foldkit/vite-plugin";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [foldkit(), {
    name: "static-security-headers",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "_headers", source: readFileSync(resolve(import.meta.dirname, "public/_headers"), "utf8") });
    },
  }],
  build: {
    emptyOutDir: true,
    outDir: "dist/client",
    rollupOptions: {
      input: {
        app: resolve(import.meta.dirname, "index.html"),
        authorize: resolve(import.meta.dirname, "authorize.html"),
      },
    },
  },
  publicDir: false,
});
