import { expect, test } from '@playwright/test';

// Requires history in the database (CI and local e2e runs seed it with seed-demo).

test('time series shows the selected range and offers exports', async ({ page }) => {
  await page.goto('/history?tab=timeline&range=week');
  await expect(page.getByRole('tab', { name: '7 days' })).toHaveAttribute('data-state', 'active');
  await expect(page.locator('canvas').first()).toBeVisible();
  const csv = page.getByRole('link', { name: 'Quarter-hours (CSV)' });
  await expect(csv).toHaveAttribute('href', /\/api\/export\/intervals\?from=\d+&to=\d+&format=csv/);
  const res = await page.request.get((await csv.getAttribute('href'))!);
  expect(res.status()).toBe(200);
  expect((await res.text()).split('\r\n')[0]).toContain('start_utc,start_local,avg_import_kw');
});

/** Hover the time-series chart at a fraction of its plot width; returns the tooltip. */
async function hoverTimeline(page: import('@playwright/test').Page, fraction: number) {
  const chart = page.locator('canvas').first();
  await expect(chart).toBeVisible();
  await chart.scrollIntoViewIfNeeded();
  const tip = page.getByText(/15-min average \(\d{2}:\d{2} – \d{2}:\d{2}\)/).locator('..');
  // retried: the chart may still be waiting for its data on the first move
  await expect(async () => {
    const box = (await chart.boundingBox())!;
    // grid: 44 px left/right, 36 px top, 64 px bottom
    const y = box.y + 36 + (box.height - 100) / 2;
    await page.mouse.move(box.x + 44 + (box.width - 88) * fraction - 5, y);
    await page.mouse.move(box.x + 44 + (box.width - 88) * fraction, y);
    await expect(tip).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  return tip;
}

test('time series steps through days, weeks and months', async ({ page }) => {
  await page.goto('/history?tab=timeline&range=today');
  const label = page.getByTestId('range-label');
  const today = await label.textContent();
  const next = page.getByRole('button', { name: 'Next' });
  await expect(next).toBeDisabled();

  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(page).toHaveURL(/date=\d{4}-\d{2}-\d{2}/);
  await expect(label).not.toHaveText(today!);
  await expect(next).toBeEnabled();
  await next.click();
  await expect(label).toHaveText(today!);
  await expect(page).not.toHaveURL(/date=/);

  await page.getByRole('tab', { name: '7 days' }).click();
  const week = await label.textContent();
  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(label).not.toHaveText(week!);

  await page.getByRole('tab', { name: 'Calendar month' }).click();
  const month = await label.textContent();
  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(label).not.toHaveText(month!);
  await expect(label).toHaveText(/\w+ \d{4}/);
});

test('time-series tooltip includes the 15-min average and all series by default', async ({
  page,
}) => {
  await page.goto('/history?tab=timeline&range=today');
  await page.evaluate(() => localStorage.removeItem('peak-guard.history.series'));
  await page.reload();
  const tip = await hoverTimeline(page, 0.1);
  await expect(tip).toContainText(/15-min average \(\d{2}:\d{2} – \d{2}:\d{2}\): \d+[.,]\d{2} kW/);
  for (const s of ['Grid import', 'House', 'PV', 'Battery', 'SoC'])
    await expect(tip).toContainText(s);
  await expect(tip).toContainText('%');
});

test('time-series series choice is restored from the browser', async ({ page }) => {
  await page.goto('/history?tab=timeline&range=today');
  await page.evaluate(() =>
    localStorage.setItem('peak-guard.history.series', JSON.stringify({ pv: false, soc: false })),
  );
  await page.reload();
  const tip = await hoverTimeline(page, 0.1);
  await expect(tip).toContainText('Grid import');
  await expect(tip).not.toContainText('PV');
  await expect(tip).not.toContainText('SoC');
  await page.evaluate(() => localStorage.removeItem('peak-guard.history.series'));
});

test('month view lists the top peaks with likely causes', async ({ page }) => {
  await page.goto('/history?tab=month');
  await expect(page.getByTestId('month-peak')).toContainText('kW');
  const table = page.getByTestId('top-peaks');
  await expect(table.locator('tbody tr')).toHaveCount(10);
  await expect(table).toContainText(/Battery|Sustained|spike/);

  // navigate to the previous month and back via the URL state
  const label = await page.getByTestId('month-label').textContent();
  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(page.getByTestId('month-label')).not.toHaveText(label!);
  await expect(page).toHaveURL(/month=\d{4}-\d{2}/);
});

test('analysis and year views render', async ({ page }) => {
  await page.goto('/history?tab=analysis');
  await expect(page.getByText('Peaks by weekday and hour')).toBeVisible();
  await expect(page.getByText('Duration curve')).toBeVisible();
  await page.getByRole('tab', { name: 'Year' }).click();
  await expect(page.getByTestId('year-cost')).toContainText('€');
  const firstMonth = page
    .getByRole('button', { pressed: false })
    .filter({ hasText: /\d{4}/ })
    .first();
  await firstMonth.click();
  await expect(page.getByRole('button', { pressed: true })).toHaveCount(1);
});
