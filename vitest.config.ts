import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'lambda/**/*.test.ts'],
    // Synthesising a stage bundles the Lambda handlers with esbuild; give it room.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
