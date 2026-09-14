// Containerdetalj (IMPLEMENTERINGSPLAN steg 5.13, skjerm 6): fra containerpanelet på web-02 til web-web, kurver,
// porter, volumer, loggstrøm med pause og «Open full log view», tilbake til serversiden med #cont.
import { test, expect, type Page } from '@playwright/test';
import { loginViaApi } from '../helpers/auth';
import { forceLang } from '../helpers/e2e-api';
import { expectMobileRules, navMasks } from '../helpers/mobile-rules';

async function gotoContainer(page: Page): Promise<void> {
  await forceLang(page, 'en');
  await loginViaApi(page);
  await page.goto('/servers/demo-web-02');
  await expect(page.locator('h1')).toHaveText('web-02');
  const row = page.locator('gp-cont-panel [data-container="web-web"]');
  await row.scrollIntoViewIfNeeded();
  await row.locator('button').click();
  await expect(page).toHaveURL(/\/servers\/demo-web-02\/containers\/[0-9a-f]{12}$/);
  await expect(page.locator('h1')).toHaveText('web-web');
}

test.describe('containersiden', () => {
  test('skjerm 6: topp, kurver, porter, volumer og loggstrøm', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await gotoContainer(page);

    await expect(page.getByTestId('status')).toHaveText(/^running · /);
    await expect(page.locator('header gp-badge')).toHaveText('nginx:1.27');
    await expect(page.getByTestId('meta')).toHaveText(/^restarts \d+image age \d+ dhealth (healthy|—)compose (web|—)$/);
    await expect(page.locator('gp-history-chart')).toHaveCount(2);
    await expect(page.locator('gp-history-chart').first()).toContainText('CPU');
    await expect(page.locator('gp-history-chart').nth(1)).toContainText(/Memory \d+ MB \/ 1024 MB/);
    await expect(page.locator('.facts .tag')).toHaveText(['80→8080', '443→8443', './nginx → /etc/nginx/conf.d']);

    // Loggen strømmer: linjer kommer, «Pause» holder visningen og teller nye linjer, «Resume» slipper dem inn.
    const lines = page.locator('gp-log-view .line');
    await expect(lines.first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('log-status')).toHaveText('streaming · nothing is stored');
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.getByTestId('log-status')).toHaveText('paused');
    const frozen = await lines.count();
    await expect(page.getByRole('button', { name: /^Resume · \d+ new$/ })).toBeVisible({ timeout: 15_000 });
    expect(await lines.count()).toBe(frozen);
    await page.getByRole('button', { name: /^Resume/ }).click();
    await expect(page.getByTestId('log-status')).toHaveText('streaming · nothing is stored');
    expect(await lines.count()).toBeGreaterThan(frozen);

    await expectMobileRules(page, testInfo);
    expect(errors, 'sidefeil').toEqual([]);
    await page.evaluate(() => document.fonts.ready);
    // Loggen er tilfeldig og bryter ulikt: fast høyde på boksen så siden får samme høyde hver gang.
    await page.addStyleTag({ content: 'gp-log-view .box { height: 420px; overflow: hidden; }' });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(800);
    await expect(page).toHaveScreenshot('container.png', {
      fullPage: true,
      // Blokkelementer med fast bredde (en maske på inline-tekst får ny bredde når tallet bytter sifre).
      mask: [page.locator('header .meta'), page.locator('header .status'), page.locator('gp-chart .title'), page.locator('gp-chart .plot'), page.locator('gp-chart .ticks'), page.locator('gp-log-view'), page.locator('.logbtns'), ...navMasks(page)],
    });
  });

  test('«Open full log view» går til loggsiden, tilbake-lenken går til serversiden med #cont', async ({ page }) => {
    await gotoContainer(page);
    await page.getByRole('button', { name: 'Open full log view' }).click();
    await expect(page).toHaveURL(/\/logs\?server=demo-web-02&source=container&container=[0-9a-f]{12}$/);
    await page.goBack();
    await expect(page.locator('h1')).toHaveText('web-web');
    await page.locator('.back').click();
    await expect(page).toHaveURL(/\/servers\/demo-web-02#cont$/);
    await expect(page.locator('#panel-cont .body')).toBeVisible();
  });
});
