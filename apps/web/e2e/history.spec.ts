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
