// Ekte agent (IMPLEMENTERINGSPLAN steg 11.1, nattlig jobb): den ekte glimt-agent-binæren i Ubuntu-containeren fra
// Dockerfile.dev (systemd, journald, sshd) meldt inn hos huben med dev-nøkkelen, i stedet for de falske agentene, for
// skjerm 4 (kortet i oversikten), 5 (serversiden med ekte tall) og 7 (journal-strømmen). Kjøres bare når
// GLIMT_E2E_REAL_AGENT=1 og containeren er startet (`npm run dev:agent` med GLIMT_AGENT_HUB_WS mot hubens adresse).
import { test, expect } from '@playwright/test';
import { loginAs } from '../helpers/auth';
import { forceLang } from '../helpers/e2e-api';
import { expectMobileRules } from '../helpers/mobile-rules';

const HOSTNAME = process.env.GLIMT_AGENT_NAME ?? 'ubuntu-dev';

test.describe('ekte agent', () => {
  test.skip(process.env.GLIMT_E2E_REAL_AGENT !== '1', 'GLIMT_E2E_REAL_AGENT=1 og agent-containeren kreves');

  test('skjerm 4, 5 og 7 med den ekte agenten i Ubuntu-containeren', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await forceLang(page, 'en');
    await loginAs(page, 'owner');
    await page.goto('/');

    // Skjerm 4: kortet kommer når agenten har sagt hello og sendt første snapshot (opptil et minutt etter oppstart).
    const card = page.locator(`gp-server-card[aria-label^="${HOSTNAME}:"]`);
    await expect(card).toBeVisible({ timeout: 120_000 });
    await expect(card.locator('.status')).toHaveText('live', { timeout: 60_000 });
    await expect(card.locator('.info')).toContainText(/Ubuntu 24\.04 · \d+ cores · [\d.]+ GB/);
    await expectMobileRules(page, testInfo);

    // Skjerm 5: serversiden med ekte tall fra /proc, systemctl og journald.
    await card.first().focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/servers\/[^/]+$/);
    await expect(page.locator('h1')).toHaveText(HOSTNAME);
    await expect(page.getByTestId('status')).toHaveText('live', { timeout: 30_000 });
    await expect(page.getByTestId('info')).toContainText(/Ubuntu 24\.04 · \S+ · \d+ cores/);
    await expect(page.locator('gp-cpu-panel .core').first()).toBeVisible();
    await expect(page.locator('gp-mem-panel gp-bar').first()).toBeVisible();
    // Inne i Docker er roten et overlay som agenten filtrerer bort, så diskpanelet kan stå uten monteringer her.
    await expect(page.locator('gp-disk-panel')).toBeVisible();
    await expect(page.locator('gp-data-grid .ag-row').first()).toBeVisible({ timeout: 30_000 });
    // sshd lytter på 22 i containeren, så sikkerhetspanelet har en ekte port.
    await expect(page.locator('gp-sec-panel')).toContainText('22');
    await expect(page.locator('gp-svc-panel')).toContainText('ssh.service');
    await expectMobileRules(page, testInfo);

    // Skjerm 7: journal-strømmen fra den ekte journald.
    const serverId = page.url().split('/servers/')[1];
    await page.goto(`/logs?server=${serverId}`);
    await expect(page.getByRole('heading', { name: 'Logs' })).toBeVisible();
    await expect(page.locator('gp-log-view .line:not(.dropped)').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('log-status')).toContainText('streaming');
    await expectMobileRules(page, testInfo);
    expect(errors, 'sidefeil').toEqual([]);
  });
});
