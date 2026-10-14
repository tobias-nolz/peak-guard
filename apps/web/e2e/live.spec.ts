import { expect, test } from '@playwright/test';

test('live view shows the current quarter-hour and power flow', async ({ page }) => {
  await page.goto('/');
  const card = page.getByTestId('interval-card');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('projected-kw')).toContainText('kW');
  await expect(page.getByTestId('interval-state')).toHaveText(/Safe|Approaching limit|Over limit/);
  await expect(page.getByTestId('connection')).toHaveText(/Inverter online/);
  await expect(page.getByText('Power flow')).toBeVisible();
});

test('live data keeps updating via SSE', async ({ page }) => {
  await page.goto('/');
  const projected = page.getByTestId('projected-kw');
  await expect(projected).toBeVisible({ timeout: 20_000 });
  const first = await page.locator('text=/Elapsed \\d+:\\d{2}/').textContent();
  await expect
    .poll(() => page.locator('text=/Elapsed \\d+:\\d{2}/').textContent(), { timeout: 15_000 })
    .not.toBe(first);
});
