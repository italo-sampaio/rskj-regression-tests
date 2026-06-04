// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["node_modules/", "dist/", "coverage/", ".nyc_output/", "*.tgz"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        node: true,
        es2022: true,
      },
    },
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // The bin/ stub is a Node.js entry script. ESLint doesn't pick up
    // Node globals via the project's flat-config "globals: node: true" entry
    // (which only works with the env-style config), so add them explicitly.
    files: ["bin/**/*.js"],
    languageOptions: {
      globals: {
        process: "readonly",
      },
    },
  },
  prettierConfig,
);
