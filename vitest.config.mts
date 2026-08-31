import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Mirror tsconfig.json's "@/*": ["./*"] path alias — source files use it
  // (e.g. tool-catalog.ts imports '@/lib/mcp-client'), but Vite/Vitest don't
  // read tsconfig paths automatically.
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['node_modules', '.next'],
  },
});
