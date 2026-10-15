import { expect, test } from '@playwright/test';

/** Build a Netz NÖ-style CSV (end-stamped, decimal comma, +3 %) from the stack's own data. */
async function portalCsv(request: import('@playwright/test').APIRequestContext) {
  const to = Date.now() - 3_600_000;
  const from = to - 3 * 86_400_000;
  const own = (await (
    await request.get(`/api/export/intervals?from=${from}&to=${to}&format=json`)
  ).json()) as {
    start: number;
    importWh: number | null;
    quality: string;
  }[];
  const fmt = new Intl.DateTimeFormat('de-AT', {
    timeZone: 'Europe/Vienna',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const lines = [
    'Messzeitpunkt;Verbrauch (kWh);Qualität;Restnetzbezug (kWh);Qualität EG;Eigendeckung (kWh);Ideeller Anteil (kWh);Eigendeckung erneuerb. Energie (kWh)',
  ];
  for (const r of own) {
    if (r.importWh == null || r.quality !== 'exact') continue;
    const end = fmt.format(r.start + 900_000).replace(',', '');
    const kwh = ((r.importWh * 1.03) / 1000).toFixed(6).replace('.', ',');
    lines.push(`${end};${kwh};L1;${kwh};L1;0,000000;0,000000;0,000000`);
  }
  return { csv: lines.join('\r\n'), rows: lines.length - 1 };
}

test('imports a smart-meter export and applies the suggested calibration', async ({
  page,
  request,
}) => {
  const original = (await (await request.get('/api/settings')).json()) as unknown;
  const { csv, rows } = await portalCsv(request);
  expect(rows).toBeGreaterThan(100);

  await page.goto('/history?tab=reconciliation');
  await page
    .getByLabel('CSV file')
    .setInputFiles({ name: 'netz-noe-export.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByRole('status')).toContainText(`Imported ${rows} quarter-hours`);
  await expect(page.getByRole('status')).toContainText('timestamps = Interval end');
  await expect(page.getByTestId('import-columns')).toContainText('Column used: Verbrauch (kWh)');
  await expect(page.getByTestId('import-columns')).toContainText('Restnetzbezug (kWh)');
  await expect(page.getByTestId('batches')).toContainText('netz-noe-export.csv');

  await expect(page.getByTestId('suggested-factor')).toHaveText(/1[.,]03/);
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect
    .poll(
      async () =>
        ((await (await request.get('/api/settings')).json()) as { calibrationFactor: number })
          .calibrationFactor,
    )
    .toBeCloseTo(1.03, 3);

  // clean up: delete the batch, restore settings
  const batches = (await (await request.get('/api/reconciliation/batches')).json()) as {
    id: number;
    filename: string;
  }[];
  for (const b of batches.filter((x) => x.filename === 'netz-noe-export.csv')) {
    expect((await request.delete(`/api/reconciliation/batches/${b.id}`)).status()).toBe(204);
  }
  await request.put('/api/settings', { data: original });
});
