// Frakoblet (IMPLEMENTERINGSPLAN steg 9.1, skjerm 15) i tre prosjekter: `context.setOffline(true)` gir banneret
// «Connection lost · Showing last known values from 08:14:02» med «Reconnect», kortene beholder tallene, sammendraget
// sier «connection lost»; `setOffline(false)` tar banneret bort, tallene lever igjen og ingen navigasjon skjedde.
// Redusert bevegelse: prikken i banneret blinker ikke.
import { test, expect } from '@playwright/test';
import { gotoOverviewLoggedIn } from '../helpers/auth';
import { forceLang } from '../helpers/e2e-api';
import { expectMobileRules, navMasks } from '../helpers/mobile-rules';

test.describe('frakoblet', () => {
  test('skjerm 15: banner ved tapt forbindelse, siste tall står, gjenoppkobling uten omlasting', async ({ page, context }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await forceLang(page, 'en');
    await gotoOverviewLoggedIn(page);
    const web02 = page.locator('gp-server-card[aria-label^="web-02:"]');
    await expect(web02.locator('gp-ring').first().locator('.val')).not.toHaveText('0%', { timeout: 15_000 });
    await expect(page.getByTestId('summary')).toContainText('live ·');
    const cpuBefore = await web02.locator('gp-ring').first().locator('.val').textContent();
    const url = page.url();

    await context.setOffline(true);
    const banner = page.locator('.offline');
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText('Connection lost');
    await expect(banner).toContainText(/Showing last known values from \d\d:\d\d:\d\d/);
    await expect(banner.getByRole('button', { name: 'Reconnect' })).toBeVisible();
    await expect(page.getByTestId('summary')).toContainText('connection lost');
    // Kortene beholder siste tall – ingen nullstilling.
    await expect(web02.locator('gp-ring').first().locator('.val')).toHaveText(cpuBefore!);
    await expect(web02.locator('gp-ring').first().locator('.val')).not.toHaveText('0%');
    await expectMobileRules(page, testInfo);
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot('offline.png', { fullPage: false, mask: [page.locator('gp-ring'), page.locator('gp-chip'), page.locator('gp-sparkline'), page.getByTestId('summary'), page.locator('gp-server-card .info'), page.locator('gp-container-card .info'), page.locator('gp-container-card .status'), banner.locator('.num'), ...navMasks(page)] });

    // «Reconnect» tvinger et forsøk (feiler mens vi er offline); når nettet er tilbake forsvinner banneret av seg selv.
    await banner.getByRole('button', { name: 'Reconnect' }).click();
    await context.setOffline(false);
    await expect(banner).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByTestId('summary')).toContainText('live ·');
    await web02.scrollIntoViewIfNeeded();
    const cpuAfter = await web02.locator('gp-ring').first().locator('.val').textContent();
    await expect.poll(async () => web02.locator('gp-ring').first().locator('.val').textContent(), { timeout: 15_000, message: 'tallene skal leve igjen' }).not.toBe(cpuAfter);
    expect(page.url()).toBe(url);
    expect(errors, 'sidefeil').toEqual([]);
  });

  test('redusert bevegelse: ingen blinking i banneret', async ({ page, context }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await forceLang(page, 'en');
    await gotoOverviewLoggedIn(page);
    await context.setOffline(true);
    const dot = page.locator('.offline .dot');
    await expect(dot).toBeVisible({ timeout: 15_000 });
    expect(await dot.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
    await context.setOffline(false);
  });
});
