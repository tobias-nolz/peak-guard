import { expect, test as setup } from '@playwright/test';

const user = process.env.E2E_AUTH_USER;
const password = process.env.E2E_AUTH_PASSWORD;

setup('authenticate', async ({ page }) => {
  if (user && password) {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
    await page.getByLabel('Username').fill(user);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByTestId('connection')).toBeVisible();
  }
  await page.context().storageState({ path: 'e2e/.auth/state.json' });
});
