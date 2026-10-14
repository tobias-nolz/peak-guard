import { expect, test } from '@playwright/test';

// The e2e stack points NOTIFY_WEBHOOK_URL at the mock inverter's webhook catcher.
const mock = process.env.E2E_MOCK_URL ?? 'http://localhost:8090';

test('sends a test notification to the configured webhook', async ({ page, request }) => {
  const before = ((await (await request.get(`${mock}/mock/webhooks`)).json()) as unknown[]).length;
  await page.goto('/settings');
  await expect(page.getByText(/Configured channels: webhook/)).toBeVisible();
  await page.getByRole('button', { name: 'Send test' }).click();
  await expect(page.getByText('Test sent')).toBeVisible();
  await expect
    .poll(
      async () =>
        (await (await request.get(`${mock}/mock/webhooks`)).json()) as {
          body: { kind: string; title: string };
        }[],
      {
        timeout: 15_000,
      },
    )
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          body: expect.objectContaining({ kind: 'test', title: 'Test notification' }),
        }),
      ]),
    );
  expect(
    ((await (await request.get(`${mock}/mock/webhooks`)).json()) as unknown[]).length,
  ).toBeGreaterThan(before);
});
