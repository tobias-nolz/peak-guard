import { expect, test } from '@playwright/test';

test.describe('settings', () => {
  let original: unknown;

  test.beforeAll(async ({ request }) => {
    original = await (await request.get('/api/settings')).json();
  });
  test.afterAll(async ({ request }) => {
    await request.put('/api/settings', { data: original });
  });

  test('saves the threshold and the live view uses it', async ({ page }) => {
    await page.goto('/settings');
    const threshold = page.getByLabel('Peak threshold (kW)');
    await threshold.fill('12.5');
    await page.getByTestId('save-settings').click();
    await expect(page.getByRole('status')).toHaveText('Settings saved');

    await page.reload();
    await expect(page.getByLabel('Peak threshold (kW)')).toHaveValue('12.5');

    await page.goto('/');
    await expect(page.getByText(/Limit 12\.5 kW/)).toBeVisible({ timeout: 20_000 });
  });

  test('rejects invalid input', async ({ page }) => {
    await page.goto('/settings');
    await page.getByLabel('Calibration factor').fill('5');
    await page.getByTestId('save-settings').click();
    await expect(page.getByRole('alert')).toHaveText('Please check the highlighted fields.');
  });

  test('switches language and theme', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('tab', { name: 'Deutsch' }).click();
    await expect(page.getByRole('heading', { name: 'Einstellungen' })).toBeVisible();
    await page.getByRole('tab', { name: 'Dunkel' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    // restore
    await page.getByRole('tab', { name: 'English' }).click();
    await page.getByRole('tab', { name: 'System' }).click();
  });
});
