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

test("today's quarter-hours tooltip shows the time slot", async ({ page }) => {
  await page.goto('/');
  const chart = page.getByTestId('today-card').locator('canvas').first();
  await expect(chart).toBeVisible({ timeout: 20_000 });
  await chart.scrollIntoViewIfNeeded();
  const box = (await chart.boundingBox())!;
  // early today (the seeded/collected data starts at midnight), not a future empty slot
  await page.mouse.move(box.x + 40 + (box.width - 56) * 0.03, box.y + box.height / 2);
  const tooltip = page.getByTestId('today-card').getByText(/\d{2}:\d{2} – \d{2}:\d{2}/);
  await expect(tooltip).toBeVisible();
  await expect(tooltip).not.toContainText(/\d{10}/); // no epoch milliseconds
  await expect(tooltip).toContainText('kW');
});
