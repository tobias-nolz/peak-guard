import { expect, test } from '@playwright/test';

test('an active grid-fee window is shown on the live page', async ({ page, request }) => {
  const original = (await (await request.get('/api/settings')).json()) as Record<string, unknown>;
  const window = {
    id: 'e2e',
    label: 'E2E all day',
    months: [],
    weekdays: [],
    from: '00:00',
    to: '23:59',
  };
  try {
    expect(
      (
        await request.put('/api/settings', { data: { ...original, gridFeeWindows: [window] } })
      ).status(),
    ).toBe(200);
    await page.goto('/');
    await expect(page.getByTestId('fee-window-active')).toHaveText('Grid fee window: E2E all day', {
      timeout: 20_000,
    });
    await page.goto('/settings');
    await expect(page.getByTestId('fee-window')).toHaveCount(1);
  } finally {
    await request.put('/api/settings', { data: original });
  }
});
