import { expect, test } from '@playwright/test';

const mock = process.env.E2E_MOCK_URL ?? 'http://localhost:8090';

test('a load-shedding hook fires when the projection nears the target', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const original = (await (await request.get('/api/settings')).json()) as Record<string, unknown>;
  const hook = {
    id: 'e2e-wallbox',
    name: 'E2E wallbox',
    enabled: true,
    triggerRatio: 0.5,
    releaseRatio: 0.3,
    minOnMinutes: 1,
    maxOnMinutes: 30,
    minOffMinutes: 1,
    shed: {
      type: 'webhook',
      url: 'http://mock-inverter:8080/mock/webhook',
      method: 'POST',
      body: '{"wallbox":"shed"}',
    },
    restore: {
      type: 'webhook',
      url: 'http://mock-inverter:8080/mock/webhook',
      method: 'POST',
      body: '{"wallbox":"restore"}',
    },
  };
  try {
    expect(
      (
        await request.put('/api/settings', { data: { ...original, loadShedding: [hook] } })
      ).status(),
    ).toBe(200);
    // a big load appears in the simulated house
    await request.post(`${mock}/mock/disturbance`, {
      data: { kw: 20, minutes: 10, name: 'e2e load' },
    });
    await expect
      .poll(
        async () =>
          (await (await request.get(`${mock}/mock/webhooks`)).json()) as {
            body: { wallbox?: string };
          }[],
        {
          timeout: 60_000,
        },
      )
      .toEqual(expect.arrayContaining([expect.objectContaining({ body: { wallbox: 'shed' } })]));
    await page.goto('/');
    await expect(page.getByTestId('shed-active')).toHaveText('Load shedding active: E2E wallbox', {
      timeout: 20_000,
    });
  } finally {
    await request.put('/api/settings', { data: original });
  }
});
