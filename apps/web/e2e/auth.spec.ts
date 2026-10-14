import { expect, test } from '@playwright/test';

const password = process.env.E2E_AUTH_PASSWORD;

test.describe('authentication', () => {
  test.skip(!password, 'stack runs without AUTH_MODE=password');

  test('unauthenticated access redirects to login and back', async ({ browser }) => {
    const ctx = await browser.newContext({
      storageState: { cookies: [], origins: [] },
      locale: 'en-GB',
    });
    const page = await ctx.newPage();
    await page.goto('/history?tab=year');
    await expect(page).toHaveURL(/\/login\?next=%2Fhistory%3Ftab%3Dyear/);
    await page.getByLabel('Username').fill(process.env.E2E_AUTH_USER!);
    await page.getByLabel('Password').fill('wrong password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText('Invalid username or password');
    await page.getByLabel('Password').fill(password!);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/history\?tab=year/);
    await expect(page.getByTestId('year-cost')).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    expect((await ctx.request.get('/api/settings')).status()).toBe(401);
    await ctx.close();
  });
});
