// Oversikten (IMPLEMENTERINGSPLAN fase 4, steg 4.5): skjerm 4 (oversikten med de 16 demoserverne), 16 (server nede),
// 18 (leser) og 19 (norsk) i alle tre prosjektene, med skjermbilder og mobilsjekklisten. Levende tall (ringer, chips,
// sparklines og klokken i sammendraget) maskeres i skjermbildene.
import { test, expect, type Page } from '@playwright/test';
import { gotoOverviewLoggedIn, loginViaApi } from '../helpers/auth';
import { ensureReader, forceLang } from '../helpers/e2e-api';
import { expectMobileRules, isMobileProject } from '../helpers/mobile-rules';

const DEMO_NAMES = ['web-01', 'web-02', 'api-prod', 'db-prod', 'worker-01', 'cache-01', 'staging-web', 'staging-db', 'acme-app', 'acme-db', 'nordic-shop', 'nordic-db', 'nas', 'pi-hole', 'media', 'backup'];

function liveMasks(page: Page) {
  return [page.locator('gp-ring'), page.locator('gp-chip'), page.locator('gp-sparkline'), page.getByTestId('summary'), page.locator('gp-server-card .info')];
}

/** Alle 16 demoserverne står i oversikten (første Card kommer rett etter SubscribeOverview). */
async function waitForCards(page: Page): Promise<void> {
  for (const name of DEMO_NAMES) await expect(page.locator(`gp-server-card[aria-label^="${name}:"]`)).toBeVisible({ timeout: 15_000 });
}

test.describe('oversikten', () => {
  test('skjerm 4: sammendrag, verktøylinje, chips og 16 kort med levende tall', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await forceLang(page, 'en');
    await gotoOverviewLoggedIn(page);
    await waitForCards(page);

    await expect(page.getByTestId('summary')).toHaveText(/^\d+ servers · \d+ up · 1 down · \d+ paused · live · \d\d:\d\d:\d\d$/);
    await expect(page.getByRole('button', { name: 'Add server' })).toBeVisible();
    await expect(page.getByPlaceholder('Search servers…')).toBeVisible();
    await expect(page.locator('gp-select select')).toHaveValue('name');
    await expect(page.locator('main gp-segment')).toHaveCount(0); // språkbyttet i sidepanelet er også et segment
    const chips = page.locator('.chip');
    await expect(chips).toHaveText(['All', 'client-a', 'client-b', 'homelab', 'prod', 'staging', 'up', 'down', 'paused', 'Has alert']);

    // Kortet: tagger, navn, status, tre ringer, fem chips, to sparklines. Tallene lever (ringen endrer seg innen få sekunder).
    const web02 = page.locator('gp-server-card[aria-label^="web-02:"]');
    await expect(web02.locator('gp-badge')).toHaveText('prod');
    await expect(web02.locator('.status')).toHaveText('live');
    await expect(web02.locator('.info')).toHaveText(/^Ubuntu 24\.04 · 4 cores · 8 GB · up \d+d \d+h$/);
    await expect(web02.locator('gp-ring')).toHaveCount(3);
    await expect(web02.locator('gp-chip')).toHaveCount(5);
    await expect(web02.locator('gp-chip .label').first()).toHaveText('Net MB/s');
    await expect(web02.locator('gp-sparkline')).toHaveCount(2);
    await expect(web02.locator('gp-ring').nth(2).locator('.val')).toHaveText('92%');
    // Kort utenfor skjermen fryses med vilje (IntersectionObserver); rull kortet inn før vi ser etter liv.
    await web02.scrollIntoViewIfNeeded();
    const cpuBefore = await web02.locator('gp-ring').first().locator('.val').textContent();
    await expect
      .poll(async () => web02.locator('gp-ring').first().locator('.val').textContent(), { timeout: 10_000, message: 'CPU-ringen skal leve' })
      .not.toBe(cpuBefore);

    // Skjerm 16: nordic-db er nede siden 03:12 (rød prikk, «last seen», ringer på 0).
    const nordic = page.locator('gp-server-card[aria-label^="nordic-db:"]');
    await expect(nordic).toHaveAttribute('data-status', 'down');
    await expect(nordic.locator('.status')).toHaveText(/^last seen /);
    await expect(nordic.locator('gp-ring .val')).toHaveText(['0%', '0%', '0%']);
    await expect(nordic.locator('gp-chip .value').first()).toHaveText('—');

    // Vedlikeholdschips: omstart på db-prod, feilet tjeneste på worker-01, stoppede containere på web-01.
    await expect(page.locator('gp-server-card[aria-label^="db-prod:"] gp-chip').nth(3).locator('.value')).toHaveText('required');
    await expect(page.locator('gp-server-card[aria-label^="worker-01:"] gp-chip').nth(4).locator('.value')).toHaveText('1 failed');
    await expect(page.locator('gp-server-card[aria-label^="web-01:"] gp-chip').nth(1).locator('.value')).toHaveText('7 / 8');

    await expectMobileRules(page, testInfo);
    expect(errors, 'sidefeil').toEqual([]);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(700);
    await expect(page).toHaveScreenshot('overview.png', { fullPage: true, mask: liveMasks(page) });
    // Ett kort per tilstand i begge bredder (steg 4.2). Pauset finnes ikke i demodataene ennå (pause er Neste).
    await expect(web02).toHaveScreenshot('card-up.png', { mask: [web02.locator('gp-ring'), web02.locator('gp-chip'), web02.locator('gp-sparkline'), web02.locator('.info')] });
    await expect(nordic).toHaveScreenshot('card-down.png', { mask: [nordic.locator('.status')] });
  });

  test('filter, sortering og søk virker, og valget huskes over omlasting', async ({ page }) => {
    await forceLang(page, 'en');
    await gotoOverviewLoggedIn(page);
    await waitForCards(page);
    const cards = page.locator('gp-server-card');
    const chip = (name: string) => page.locator('.chip', { hasText: new RegExp(`^${name}$`) });

    await chip('homelab').click();
    await expect(cards).toHaveCount(4);
    await expect(chip('homelab')).toHaveAttribute('aria-pressed', 'true');
    await chip('down').click();
    await expect(cards).toHaveCount(0);
    await expect(page.getByText('No servers match the filter')).toBeVisible();
    await chip('All').click();
    await chip('down').click();
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toHaveAttribute('aria-label', /^nordic-db:/);
    await chip('Has alert').click();
    await expect(cards).toHaveCount(0); // varsler kommer i fase 7
    await chip('All').click();

    await page.locator('gp-select select').selectOption('cpu');
    await expect(cards.first()).toHaveAttribute('aria-label', /^api-prod:/);
    await page.locator('gp-select select').selectOption('status');
    await expect(cards.first()).toHaveAttribute('aria-label', /^nordic-db:/);

    await page.getByPlaceholder('Search servers…').fill('nordic');
    await expect(cards).toHaveCount(2);
    await page.getByPlaceholder('Search servers…').fill('client-a');
    await expect(cards).toHaveCount(2);
    await expect(cards.first()).toHaveAttribute('aria-label', /^acme-app:/);
    await page.getByPlaceholder('Search servers…').fill('');

    await chip('prod').click();
    await page.reload();
    await expect(page.locator('gp-select select')).toHaveValue('status');
    await expect(chip('prod')).toHaveAttribute('aria-pressed', 'true');
    await expect(cards).toHaveCount(6);
  });

  test('tastatur: «/» fokuserer søket, piltaster går mellom kort, Enter åpner serveren', async ({ page }, testInfo) => {
    test.skip(isMobileProject(testInfo), 'tastaturnavigasjon testes på desktop');
    await forceLang(page, 'en');
    await gotoOverviewLoggedIn(page);
    await waitForCards(page);
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('/');
    await expect(page.getByPlaceholder('Search servers…')).toBeFocused();
    await page.keyboard.press('Escape');
    await page.locator('gp-server-card').first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('gp-server-card').nth(1)).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.locator('gp-server-card').last()).toBeFocused();
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/servers\/demo-acme-app$/);
  });

  test('ringen åpner serversiden med panelet som fragment', async ({ page }) => {
    await forceLang(page, 'en');
    await gotoOverviewLoggedIn(page);
    await waitForCards(page);
    await page.locator('gp-server-card[aria-label^="web-02:"] gp-ring').nth(1).locator('button').click();
    await expect(page).toHaveURL(/\/servers\/demo-web-02#mem$/);
  });

  test('skjerm 18: leseren ser serverne uten «Add server» og med rollen Reader', async ({ page }, testInfo) => {
    const reader = await ensureReader(page);
    await forceLang(page, 'en');
    await loginViaApi(page, reader);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Servers' })).toBeVisible();
    await waitForCards(page);
    await expect(page.getByRole('button', { name: 'Add server' })).toHaveCount(0);
    if (!isMobileProject(testInfo)) {
      await expect(page.locator('gp-sidebar .role')).toHaveText('Reader');
    }
    await expectMobileRules(page, testInfo);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(700);
    await expect(page).toHaveScreenshot('overview-reader.png', { fullPage: true, mask: liveMasks(page) });
  });

  test('skjerm 19: norsk bytter alle tekstene i oversikten', async ({ page }, testInfo) => {
    await forceLang(page, 'no');
    await gotoOverviewLoggedIn(page);
    await expect(page.getByRole('heading', { name: 'Servere' })).toBeVisible();
    await waitForCards(page);
    await expect(page.getByTestId('summary')).toHaveText(/^\d+ servere · \d+ oppe · 1 nede · \d+ pauset · live · \d\d:\d\d:\d\d$/);
    await expect(page.getByRole('button', { name: 'Legg til server' })).toBeVisible();
    await expect(page.getByPlaceholder('Søk i servere…')).toBeVisible();
    await expect(page.locator('.chip')).toHaveText(['Alle', 'client-a', 'client-b', 'homelab', 'prod', 'staging', 'oppe', 'nede', 'pauset', 'Har varsel']);
    const web02 = page.locator('gp-server-card[aria-label^="web-02:"]');
    await expect(web02.locator('gp-ring .label')).toHaveText(['Prosessor', 'Minne', 'Disk']);
    await expect(web02.locator('gp-chip .label')).toHaveText(['Nett MB/s', 'Containere', 'Oppdat.', 'Omstart', 'Tjenester']);
    await expect(web02.locator('.info')).toHaveText(/kjerner .* oppe /);
    await expect(page.locator('gp-server-card[aria-label^="nordic-db:"] .status')).toHaveText(/^sist sett /);
    await expectMobileRules(page, testInfo);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(700);
    await expect(page).toHaveScreenshot('overview-no.png', { fullPage: true, mask: liveMasks(page) });
  });
});
