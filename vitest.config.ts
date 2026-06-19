import { defineConfig } from "vitest/config";

/**
 * Vitest only owns the `*.test.ts` files (the runnable examples). The byte-lock
 * + purity suite lives in `*.checks.ts` — those are standalone tsx scripts that
 * call `process.exit`, so they are deliberately EXCLUDED from the vitest glob
 * (run them via `npm run test:checks`). `npm test` runs both.
 */
export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.checks.ts"],
  },
});
