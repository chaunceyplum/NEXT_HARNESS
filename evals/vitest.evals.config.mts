import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * A SEPARATE config from the repo's own vitest.config.mts, on purpose: that
 * one's `include: ['**\/*.test.ts']` is what `npm test` runs, and evals must
 * never be swept into it — they call the real, configured LLM / embedding
 * provider and MCP endpoint (cost, latency, non-determinism) rather than
 * stubs, so they're a manual `npm run eval:*` step, not a test. Same `@`
 * alias as the main config so eval files import harness code exactly the
 * way the app and its unit tests do.
 */
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  root: repoRoot,
  resolve: {
    alias: {
      '@': repoRoot,
    },
  },
  test: {
    environment: 'node',
    include: ['evals/**/*.eval.ts'],
    setupFiles: ['evals/setup-env.ts'],
    // A full agent loop is several model round trips per fixture; give it
    // room past vitest's 5s default before a slow provider looks like a hang.
    testTimeout: 180_000,
    hookTimeout: 120_000,
    // Fixtures run one at a time so a provider rate limit shows up as one
    // slow fixture, not a burst of spurious failures.
    fileParallelism: false,
  },
});
