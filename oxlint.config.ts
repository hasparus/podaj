import foldkitRecommended from "@foldkit/oxlint-plugin/recommended.json" with {
  type: "json",
};
import core from "ultracite/oxlint/core";
import { defineConfig } from "oxlint";

const foldkitScope = (pattern: string) => `src/client/${pattern}`;

const foldkitSeverity = ([rule, severity]: readonly [string, string]) => {
  if (severity === "error" || severity === "off") {
    return [rule, severity] as const;
  }
  throw new Error(
    `@foldkit/oxlint-plugin/recommended.json sets ${rule} to ${severity}. Map that severity in oxlint.config.ts before bumping the plugin.`,
  );
};

const foldkitRules = (rules: Readonly<Record<string, string>>) =>
  Object.fromEntries(Object.entries(rules).map(foldkitSeverity));

const clientUltraciteRelaxed = {
  "eslint/func-names": "off",
  "eslint/no-nested-ternary": "off",
  "eslint/no-redeclare": "off",
  "eslint/prefer-destructuring": "off",
  "eslint/sort-keys": "off",
  "import/consistent-type-specifier-style": "off",
  "promise/prefer-await-to-callbacks": "off",
  "typescript/array-type": "off",
  "typescript/consistent-type-imports": "off",
  "typescript/no-unsafe-type-assertion": "off",
  "typescript/promise-function-async": "off",
  "unicorn/prefer-type-error": "off",
};

const foldkitOverrides = [
  {
    files: [foldkitScope("**/*.ts")],
    rules: {
      ...foldkitRules(foldkitRecommended.rules),
      ...clientUltraciteRelaxed,
    },
  },
  ...foldkitRecommended.overrides.map(({ excludeFiles, files, rules }) => ({
    excludeFiles: excludeFiles?.map(foldkitScope),
    files: files.map(foldkitScope),
    rules: foldkitRules(rules),
  })),
];

/** rat-stack fence subset: Ultracite core + Foldkit lint on the client program. */
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
  jsPlugins: foldkitRecommended.jsPlugins,
  options: { typeAware: true },
  overrides: [
    ...foldkitOverrides,
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
