// Varselsiden (IMPLEMENTERINGSPLAN fase 7, steg 7.3 og 7.6): skjerm 8 (aktive/løste/alle, stille) og skjerm 17 (ingen
// varsler) i tre prosjekter, badgen i navigasjonen, og ende til ende: en server som forsvinner gir «Server down» i
// listen uten omlasting. Radene lever (varsler utløses etter hvert), så listen får fast høyde og maskeres i skjermbildet.
import { test, expect, type Page } from '@playwright/test';
import { loginViaApi, ownerWithServer } from '../helpers/auth';
import { ensureEmptyOwner, forceLang, triggerE2E } from '../helpers/e2e-api';
import { expectMobileRules, isMobileProject, navMasks } from '../helpers/mobile-rules';

// Fase 12: «Node down» og den åttende regelen «Health check failing».
const RULE_NAMES = ['Node down', 'Disk almost full', 'Memory pressure', 'CPU saturated', 'Container stopped or restart loop', 'Service failed', 'Reboot required', 'Health check failing'];

function row(page: Page, server: string, rule: string) {
  return page.locator(`.row[data-server="${server}"][data-rule="${rule}"]`);
}

async function gotoAlerts(page: Page): Promise<void> {
  await forceLang(page, 'en');
  await loginViaApi(page);
  await page.goto('/alerts');
  await expect(page.getByRole('heading', { name: 'Alerts', exact: true })).toBeVisible();
}

test.describe('varselsiden', () => {
  test('skjerm 8: aktive varsler fra demoserverne, badge, regler, stille og segmentene', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await gotoAlerts(page);

    // Fra første øyeblikksbilde: web-02 disk 92 %, worker-01 feilet tjeneste, db-prod omstart (info). nordic-db er nede siden 03:12 (første sveip, ≤ 10 s).
    const disk = row(page, 'demo-web-02', 'disk_full');
    await expect(disk).toBeVisible({ timeout: 20_000 });
    await expect(disk.locator('.server')).toHaveText('web-02');
    await expect(disk.locator('.rname')).toHaveText('Disk almost full');
    await expect(disk.locator('.detail')).toHaveText('/ · 92 %');
    await expect(disk.locator('.when')).toHaveText(/^(\d\d:\d\d|yesterday \d\d:\d\d|\w{3} \d{1,2} \d\d:\d\d)$/);
    await expect(row(page, 'demo-worker-01', 'svc_failed').locator('.detail')).toHaveText('cron-sync.service');
    await expect(row(page, 'demo-db-prod', 'reboot')).toBeVisible();
    await expect(row(page, 'demo-nordic-db', 'server_down').locator('.detail')).toHaveText(/^last seen \d\d:\d\d$/, { timeout: 20_000 });
    await expect(page.getByTestId('alerts-summary')).toHaveText(/^\d+ active · \d+ resolved$/);

    // Badgen i navigasjonen viser antall aktive.
    const badge = page.locator(isMobileProject(testInfo) ? 'gp-bottom-nav .badge' : 'gp-sidebar .badge');
    await expect(badge).toHaveText(/^[1-9]\d*$/);

    // Reglene: sju, i planens rekkefølge, med alvor og oppsummeringsteksten.
    await expect(page.locator('.rrow .rname')).toHaveText(RULE_NAMES);
    await expect(page.locator('.rrow[data-rule="disk_full"] gp-badge').first()).toHaveText('Critical');
    await expect(page.locator('.rrow[data-rule="reboot"] gp-badge').first()).toHaveText('Info');
    await expect(page.locator('.digest')).toHaveText(/^Info alerts are collected in one daily summary at \d\d:\d\d$/);

    // Stille (eier): tre valg glir inn under raden, «1 hour» gir badgen. Idempotent: en tidligere kjøring kan ha satt stille.
    const svc = row(page, 'demo-worker-01', 'svc_failed');
    if ((await svc.locator('gp-badge', { hasText: 'silenced' }).count()) === 0) {
      await svc.getByRole('button', { name: 'Silence' }).click();
      await expect(svc.locator('.choices gp-button')).toHaveText(['1 hour', 'Until tomorrow', 'Until Monday']);
      await svc.locator('.choices').getByRole('button', { name: '1 hour' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'silenced' })).toBeVisible();
    }
    await expect(svc.locator('gp-badge', { hasText: 'silenced' })).toBeVisible();
    await expect(svc.getByRole('button', { name: 'Silence' })).toHaveCount(0);

    // Segmentene.
    await page.getByRole('radio', { name: 'All' }).click();
    expect(await page.locator('.row').count()).toBeGreaterThanOrEqual(4);
    await page.getByRole('radio', { name: 'Resolved' }).click();
    await expect(page.locator('.row[data-state="firing"]')).toHaveCount(0);
    await page.getByRole('radio', { name: 'Active' }).click();
    await expect(disk).toBeVisible();

    // Klikk på servernavnet → serversiden; klikk på «Service failed» → loggene med enheten.
    await svc.locator('.rule').click();
    await expect(page).toHaveURL(/\/logs\?server=demo-worker-01&source=journal&unit=cron-sync\.service$/);
    await page.goBack();
    await disk.locator('.server').click();
    await expect(page).toHaveURL(/\/servers\/demo-web-02$/);
    await page.goBack();
    await expect(disk).toBeVisible();

    await expectMobileRules(page, testInfo);
    expect(errors, 'sidefeil').toEqual([]);
    // Toasten «silenced» lever i 2,2 s; den skal ikke inn i skjermbildet.
    await expect(page.getByRole('status').filter({ hasText: 'silenced' })).toBeHidden({ timeout: 5000 });
    await page.evaluate(() => document.fonts.ready);
    await page.addStyleTag({ content: '.rows { height: 320px; overflow: hidden; }' });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
    await expect(page).toHaveScreenshot('alerts.png', { fullPage: true, mask: [page.locator('.rows'), page.getByTestId('alerts-summary'), ...navMasks(page)] });
  });

  test('skjerm 17: en konto uten servere har ingen varsler, reglene står under', async ({ page }, testInfo) => {
    const owner = await ensureEmptyOwner(page);
    await forceLang(page, 'en');
    await loginViaApi(page, owner);
    await page.goto('/alerts');
    await expect(page.getByTestId('no-active')).toContainText('No active alerts');
    await expect(page.getByTestId('alerts-summary')).toHaveText('0 active · 0 resolved');
    await expect(page.locator('.rrow')).toHaveCount(8);
    await expect(page.locator(isMobileProject(testInfo) ? 'gp-bottom-nav .badge' : 'gp-sidebar .badge')).toHaveCount(0);
    await expectMobileRules(page, testInfo);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    await expect(page).toHaveScreenshot('alerts-empty.png', { fullPage: true });
  });

  test('ende til ende: en server som forsvinner gir «Server down» i listen og badgen uten omlasting', async ({ page }, testInfo) => {
    const { serverId, hostname } = await ownerWithServer(page, testInfo, 'down');

    await page.goto('/alerts');
    await expect(page.getByTestId('no-active')).toBeVisible();

    // Agenten forsvinner og har ikke vært sett på 130 s (bakdatert, så hubens klokke står): nede-deteksjonen og varselmotoren sveiper.
    await triggerE2E(page, 'disconnect-server', { serverId, seconds: 130 });
    const down = row(page, serverId, 'server_down');
    await expect(down).toBeVisible({ timeout: 15_000 });
    await expect(down.locator('.server')).toHaveText(hostname);
    await expect(down.locator('.detail')).toHaveText(/^last seen \d\d:\d\d$/);
    await expect(page.locator(isMobileProject(testInfo) ? 'gp-bottom-nav .badge' : 'gp-sidebar .badge')).toHaveText('1');

    // Agenten er tilbake: løst, og badgen forsvinner.
    await triggerE2E(page, 'reconnect-server', { serverId });
    await expect(page.getByTestId('no-active')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('radio', { name: 'Resolved' }).click();
    await expect(down).toHaveAttribute('data-state', 'resolved');
    await expect(down.locator('gp-badge', { hasText: 'Resolved' })).toBeVisible();
  });
});
