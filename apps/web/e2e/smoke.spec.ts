import { test, expect } from '@playwright/test';

/**
 * Smoke @smoke — só precisa do web rodando (sem api/db).
 * Cobre o gate de auth do middleware e a renderização das páginas públicas.
 */
test.describe('@smoke público', () => {
  test('rota protegida sem sessão redireciona pra /login', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login(\?|$)/);
    // O middleware preserva o destino em ?next=
    expect(page.url()).toContain('next=%2Fdashboard');
  });

  test('página de login renderiza com email, senha e submit', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByText('Entrar no Neura AI')).toBeVisible();
    await expect(page.locator('#email')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
    // Links de recuperação e cadastro presentes
    await expect(page.getByRole('link', { name: /cadastrar/i })).toBeVisible();
  });

  test('página de signup renderiza os campos', async ({ page }) => {
    await page.goto('/signup');
    await expect(page.locator('#email')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });
});
