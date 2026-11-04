import core from "ultracite/oxlint/core";
import { defineConfig } from "oxlint";

/**
 * rat-stack fence subset for a single-package vanilla-DOM app.
 * Full Ultracite core on `src/`; scripts/tests use tsrs scripts project only.
 */
export default defineConfig({
  extends: [core],
  ignorePatterns: [
    ...(core.ignorePatterns ?? []),
    "**/dist/**",
    "node_modules/**",
    "oxlint.config.ts",
    "scripts/**",
    "test/**",
    "vite.config.ts",
  ],
  options: { typeAware: true },
  overrides: [
    {
      files: ["src/client/**/*.ts"],
      rules: {
        "eslint/curly": "off",
        "eslint/func-style": "off",
        "eslint/no-loop-func": "off",
        "eslint/prefer-destructuring": "off",
        "eslint/prefer-named-capture-group": "off",
        "eslint/sort-keys": "off",
        "import/consistent-type-specifier-style": "off",
        "typescript/no-misused-promises": "off",
        "typescript/no-unnecessary-type-assertion": "off",
        "typescript/no-unsafe-type-assertion": "off",
        "typescript/prefer-regexp-exec": "off",
        "typescript/promise-function-async": "off",
        "typescript/strict-boolean-expressions": "off",
        "typescript/strict-void-return": "off",
        "typescript/use-unknown-in-catch-callback-variable": "off",
        "unicorn/catch-error-name": "off",
        "unicorn/no-await-expression-member": "off",
        "unicorn/prefer-dom-node-append": "off",
        "unicorn/prefer-query-selector": "off",
        "unicorn/prefer-ternary": "off",
      },
    },
    {
      files: ["src/crypto/**/*.ts", "src/security.ts", "src/worker.ts"],
      rules: {
        "eslint/curly": "off",
        "eslint/func-style": "off",
        "eslint/no-plusplus": "off",
        "eslint/prefer-named-capture-group": "off",
        "eslint/require-unicode-regexp": "off",
        "eslint/sort-keys": "off",
        "typescript/consistent-type-definitions": "off",
        "typescript/no-deprecated": "off",
        "typescript/no-unsafe-type-assertion": "off",
        "typescript/prefer-regexp-exec": "off",
        "typescript/return-await": "off",
        "unicorn/numeric-separators-style": "off",
        "unicorn/prefer-code-point": "off",
        "unicorn/prefer-number-coercion": "off",
        "unicorn/prefer-response-static-json": "off",
        "unicorn/prefer-string-replace-all": "off",
      },
    },
  ],
});
