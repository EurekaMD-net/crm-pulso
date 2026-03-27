import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["engine/src/**/*.test.ts", "crm/**/*.test.ts"],
    exclude: [
      "node_modules",
      "dist",
      "engine/.nanoclaw/**",
      "engine/.claude/skills/**",
      "engine/skills-engine/**",
    ],
  },
});
