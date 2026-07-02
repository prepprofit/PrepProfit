import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': root,
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: [
      'tests/**/*.test.{ts,tsx}',
      'lib/**/*.test.{ts,tsx}',
      'emails/**/*.test.{ts,tsx}',
    ],
    exclude: ['node_modules', '.next', '.agents', '.claude'],
    // Each DB test spins up a fresh PGlite instance and runs migrations in a
    // setup hook. With the suite running files in parallel, many instances
    // initialize at once and the 10s default hook timeout can flake under load
    // (CPU/IO contention) — not a logic failure. Give setup/teardown and tests
    // more headroom so parallel runs stay green.
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
