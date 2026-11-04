import { defineConfig } from "oxlint";

export default defineConfig({
  ignorePatterns: ["**/dist/**", "node_modules/**", "scripts/hooks/**"],
  options: { typeAware: true },
});
