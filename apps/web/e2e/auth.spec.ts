import { test, expect } from '@playwright/test';

/**
 * Auth @fullstack — precisa do stack completo rodando (api + postgres + redis)
 * e NODE_ENV != production (aí autoSignIn=true e não exige verificar email).
 * Pulado por padrão; rode com E2E_FULLSTACK=1 contra um stack de teste.
 */
test.describe('@fullstack auth', () => {
  test.skip(
    !process.env.E2E_FULLSTACK,
    'precisa do stack completo — defina E2E_FULLSTACK=1 (api+db+redis rodando, NODE_ENV≠production)',
  );

  test('signup cria conta e entra (autoSignIn → /onboarding)', async ({ page }) => {
    const email = `e2e+${Date.now()}@neura-e2e.test`;
    await page.goto('/signup');
    await page.locator('#name').fill('E2E Tester');
    await page.locator('#email').fill(email);
    await page.locator('#password').fill('e2e-password-123');
    await page.locator('button[type="submit"]').click();

    // autoSignIn (dev/test) → onboarding pra criar o primeiro workspace.
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 15_000 });
  });

  test('login com credenciais inválidas mostra erro (não navega pro app)', async ({ page }) => {
    await page.goto('/login');
    await page.locator('#email').fill(`naoexiste+${Date.now()}@neura-e2e.test`);
    await page.locator('#password').fill('senha-errada-123');
    await page.locator('button[type="submit"]').click();

    // Continua em /login; um toast/erro aparece (não redireciona pro dashboard).
    await page.waitForTimeout(1500);
    await expect(page).toHaveURL(/\/login/);
  });
});
