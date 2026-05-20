import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Integration tests share a single Postgres instance (the migrations and
    // TRUNCATE statements would race otherwise). Force serial execution
    // across files; the unit-only suites still finish in well under a second.
    fileParallelism: false,
  },
});
