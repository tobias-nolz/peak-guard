import { expect, test } from '@playwright/test';

test('simulation replays history and recommends threshold and reserve', async ({ page }) => {
  await page.goto('/simulation');
  await expect(page.getByLabel('Capacity (kWh)')).not.toHaveValue('');
  await page.getByRole('tab', { name: '3 months' }).click();
  await page.getByTestId('run-simulation').click();
  const results = page.getByTestId('simulation-results');
  await expect(results).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('sim-peak')).toContainText('kW');
  await expect(page.getByTestId('sim-best')).toContainText(
    /Recommendation: threshold [\d.]+ kW, reserve \d+ %/,
  );
  // two charts (ECharts may add a hover canvas per chart)
  expect(await results.locator('canvas').count()).toBeGreaterThanOrEqual(2);
});
