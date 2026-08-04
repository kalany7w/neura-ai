import { defineConfig, devices } from '@playwright/test';

/**
 * E2E do app web (Next.js).
 *
 * baseURL:
 *  - default http://localhost:7302 (o `next dev`/`next start` do web).
 *  - E2E_BASE_URL sobrescreve (ex.: apontar pra um stack já rodando em CI/staging).
 *
 * webServer: se E2E_BASE_URL NÃO estiver setado, o Playwright sobe o web sozinho.
 *  - Testes @smoke (páginas públicas + redirect do middleware) passam SÓ com o web.
 *  - Testes @fullstack (signup→app) precisam de api+postgres+redis rodando também;
 *    são pulados a menos que E2E_FULLSTACK=1 (ver e2e/auth.spec.ts).
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:7302';
const externalServer = !!process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: externalServer
    ? undefined
    : {
        // Default: 'pnpm start' (requer build). E2E_WEB_CMD='pnpm dev' evita o build
        // (útil localmente pra smoke). CI usa E2E_BASE_URL contra o stack já de pé.
        command: process.env.E2E_WEB_CMD ?? 'pnpm start',
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
});
