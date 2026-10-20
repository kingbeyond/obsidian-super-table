import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  { ignores: ["main.js", "tests/**", "scripts/**", "internal-tools/**", "internal-docs/**", "eslint.config.mjs"] },
  ...obsidianmd.configs.recommended,
  {
    rules: {
      // The directory also skips this noisy rule; preserve existing import conversions.
      "@typescript-eslint/no-base-to-string": "off",
    },
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["manifest.json"] },
        extraFileExtensions: [".json"],
      },
    },
  },
]);
