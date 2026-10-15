import { expect, test } from '@playwright/test';

// The e2e stack runs the collector with Modbus against the mock inverter and
// CONTROL_WRITES_ENABLED=true (the mock is the only device ever written to).

test.describe.serial('control', () => {
  test.afterAll(async ({ request }) => {
    const { settings } = (await (await request.get('/api/control/status')).json()) as {
      settings: Record<string, unknown>;
    };
    await request.put('/api/control', {
      data: { ...settings, mode: 'dryRun', acknowledgeNoRevert: false },
    });
  });

  test('dry-run reads the battery via Modbus and shows decisions', async ({ page }) => {
    await page.goto('/control');
    const status = page.getByTestId('control-status');
    await expect(status).toContainText('connected', { timeout: 20_000 });
    await expect(status).toContainText('Max. power');
    await expect(page.getByTestId('control-decision')).toHaveText(
      /Battery free|Holding the reserve|Shaving|Battery empty/,
      { timeout: 20_000 },
    );
    await expect(page.getByTestId('mode-badge')).toHaveText('Dry-run');
    // the decision's limit is clearly marked as not written in dry-run
    await expect(page.getByTestId('status-mode')).toHaveText('Dry-run');
    await expect(status).toContainText('Inverter (read via Modbus)');
    await expect(page.getByTestId('wanted-limit')).toContainText(
      'Dry-run: not written to the inverter',
    );
  });

  test('Active is gated on the revert self-test, which passes on the mock', async ({
    page,
    request,
  }) => {
    // revert test + several mode changes with ~5 s status updates
    test.setTimeout(120_000);
    const { settings } = (await (await request.get('/api/control/status')).json()) as {
      settings: Record<string, unknown>;
    };
    await request.put('/api/control', {
      data: { ...settings, mode: 'dryRun', acknowledgeNoRevert: false },
    });
    await page.goto('/control');
    const revert = page.getByTestId('revert-status');
    if ((await revert.textContent()) !== 'passed') {
      await page.getByTestId('mode-active').click();
      await expect(page.getByRole('alert')).toContainText(/revert self-test/);
      await page.getByTestId('run-revert-test').click();
      await expect(revert).toHaveText('passed', { timeout: 60_000 });
    }
    await page.getByTestId('mode-active').click();
    await expect(page.getByTestId('mode-badge')).toHaveText('Active control', { timeout: 15_000 });
    // the collector writes (and verifies) the mock's model 124
    await expect(page.getByTestId('control-applying')).toHaveText('Limits applied', {
      timeout: 20_000,
    });
    await expect(page.getByTestId('status-mode')).toHaveText('Active');
    await expect(page.getByTestId('wanted-limit')).not.toContainText('not written');

    // pause hands control back to the inverter, resume takes it again
    await page.getByTestId('pause-30').click();
    await expect(page.getByTestId('control-applying')).toHaveText('not applied', {
      timeout: 20_000,
    });
    await page.getByTestId('resume').click();
    await expect(page.getByTestId('control-applying')).toHaveText('Limits applied', {
      timeout: 20_000,
    });
  });
});
