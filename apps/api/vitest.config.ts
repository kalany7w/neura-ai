import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 15_000,
    // Tests integram com Postgres real (welcome-flow, auto-routing, multi-tenant)
    // e fazem deleteMany globais — paralelizar arquivos derruba FK constraints.
    // Serial é necessário pra isolamento sem reescrever fixtures.
    fileParallelism: false,
  },
});
