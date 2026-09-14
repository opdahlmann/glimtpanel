// Loggsiden (IMPLEMENTERINGSPLAN fase 6, steg 6.5, skjerm 7) i tre prosjekter: kilde, prioritet, tidsrom, pause/resume,
// kopier, containere flettet med farge per container, dyplenke fra en feilet tjeneste, og at ingen strøm står igjen i
// agenten etter at siden forlates (GET /api/e2e/agent-streams). Loggboksen får fast høyde før skjermbildet.
import { test, expect, type Page } from '@playwright/test';
import { loginViaApi } from '../helpers/auth';
import { forceLang } from '../helpers/e2e-api';
import { expectMobileRules, isMobileProject, navMasks } from '../helpers/mobile-rules';

/** Åpne strømmer for én server (tallet er globalt for huben, så bare en server ingen annen test bruker gir et sikkert svar). */
async function openStreams(page: Page, serverId: string): Promise<number> {
  const res = await page.request.get('/api/e2e/agent-streams');
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { byServer: Record<string, number> }).byServer[serverId] ?? 0;
}

async function gotoLogs(page: Page, query = 'server=demo-web-02'): Promise<void> {
  await forceLang(page, 'en');
  await loginViaApi(page);
  await page.goto(`/logs?${query}`);
  await expect(page.getByRole('heading', { name: 'Logs' })).toBeVisible();
}

const lines = (page: Page) => page.locator('gp-log-view .line:not(.dropped)');

test.describe('loggsiden', () => {
  test('skjerm 7: journal strømmer, kilde, prioritet og tidsrom gir nye strømmer, pause og resume', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await gotoLogs(page);
    await expect(page.locator('gp-select select')).toHaveValue('demo-web-02');
    await expect(page.locator('.sources [role="radio"]')).toHaveText(['System', 'Login & sudo', 'Kernel', 'Packages', 'Web server', 'Firewall', 'Containers']);
    await expect(page.locator('.sources [aria-checked="true"]')).toHaveText('System');
    await expect(lines(page).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('log-status')).toContainText('streaming · nothing is stored');
    await expect(page.getByTestId('line-count')).toHaveText(/^\d+ lines$/);

    // Login & sudo: bare sshd/sudo/fail2ban-linjer, og hint-teksten følger kilden.
    await page.locator('.sources [role="radio"]', { hasText: 'Login & sudo' }).click();
    await expect(page).toHaveURL(/source=auth/);
    await expect(page.locator('.hint')).toHaveText('Who logged in, who failed, who used sudo');
    await expect(lines(page).first()).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await lines(page).locator('.unit').allTextContents()).every((u) => ['sshd', 'sudo', 'fail2ban'].includes(u))).toBe(true);

    // Errors: bare røde linjer.
    await page.locator('.sources [role="radio"]', { hasText: 'System' }).click();
    await expect(page).toHaveURL(/source=journal/);
    await page.locator('.priority [role="radio"]', { hasText: 'Errors' }).click();
    await expect(page).toHaveURL(/priority=err/);
    // Byttet tømmer visningen (URL-en endres før strømmen er byttet), så vent til de gamle linjene er borte.
    await expect(page.locator('gp-log-view .line:not(.err):not(.dropped)')).toHaveCount(0);
    await expect(page.locator('gp-log-view .line.err').first()).toBeVisible({ timeout: 15_000 });
    expect(await page.locator('gp-log-view .line:not(.err):not(.dropped)').count()).toBe(0);
    await page.locator('.priority [role="radio"]', { hasText: 'All' }).click();
    await expect(page).not.toHaveURL(/priority=/);

    // Tidsrom 24 h: ny strøm.
    await page.locator('.range [role="radio"]', { hasText: '24 h' }).click();
    await expect(page).toHaveURL(/range=24h/);
    await expect(lines(page).first()).toBeVisible({ timeout: 15_000 });

    // Pause holder visningen og teller nye linjer; Resume slipper dem inn.
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.getByTestId('log-status')).toContainText('paused');
    const frozen = await lines(page).count();
    await expect(page.getByRole('button', { name: /^Resume · \d+$/ })).toBeVisible({ timeout: 15_000 });
    expect(await lines(page).count()).toBe(frozen);
    await page.getByRole('button', { name: /^Resume/ }).click();
    await expect(page.getByTestId('log-status')).toContainText('streaming');
    expect(await lines(page).count()).toBeGreaterThan(frozen);

    await expectMobileRules(page, testInfo);
    expect(errors, 'sidefeil').toEqual([]);
    await page.evaluate(() => document.fonts.ready);
    await page.addStyleTag({ content: 'gp-log-view .box { height: 300px; overflow: hidden; }' });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);
    await expect(page).toHaveScreenshot('logs.png', { fullPage: true, mask: [page.locator('gp-log-view'), page.locator('.status'), page.locator('.bar'), ...navMasks(page)] });
  });

  test('tekstfilter filtrerer det som er lastet og står i URL-en; Copy lines kopierer', async ({ page, context }, testInfo) => {
    await gotoLogs(page);
    await expect(lines(page).first()).toBeVisible({ timeout: 15_000 });
    await page.locator('gp-input input').fill('sshd');
    await expect(page).toHaveURL(/q=sshd/);
    // Filteret treffer enhet, container eller melding.
    await expect.poll(async () => (await lines(page).allTextContents()).every((t) => t.includes('sshd'))).toBe(true);
    await page.reload();
    await expect(page.locator('gp-input input')).toHaveValue('sshd');

    test.skip(testInfo.project.name === 'mobile-webkit', 'WebKit i headless gir ikke tilgang til utklippstavlen');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await expect(lines(page).first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Copy lines' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Copied to clipboard' })).toBeVisible();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toMatch(/^\d\d:\d\d:\d\d sshd: /);
  });

  test('containere: chips, flettet med farge per container, side om side på desktop', async ({ page }, testInfo) => {
    await gotoLogs(page, 'server=demo-web-02&source=container');
    const chips = page.locator('[data-testid="container-chips"] .chip');
    await expect(chips).toHaveCount(6);
    await expect(page.locator('gp-log-view')).toContainText('Containers on this server · up to 4');
    await chips.filter({ hasText: 'web-web' }).click();
    await expect(page).toHaveURL(/container=web-web/);
    await chips.filter({ hasText: 'web-api' }).click();
    await expect(page).toHaveURL(/container=web-web%2Cweb-api|container=web-web,web-api/);
    await expect(lines(page).first()).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => new Set(await lines(page).locator('.unit').allTextContents()).size, { timeout: 15_000 }).toBe(2);
    const colors = await lines(page).locator('.unit').evaluateAll((els) => [...new Set(els.map((e) => (e as HTMLElement).style.color))]);
    expect(colors.length).toBe(2);

    if (isMobileProject(testInfo)) {
      await expect(page.locator('.layout')).toHaveCount(0);
    } else {
      await page.locator('.layout [role="radio"]', { hasText: 'Side by side' }).click();
      await expect(page.locator('.columns .column')).toHaveCount(2);
      await expect(page.locator('.columns .colhead')).toHaveText(['web-web', 'web-api']);
    }
    await expectMobileRules(page, testInfo);
    // Andre tester (og prosjekter) strømmer også fra web-02 samtidig; det eksakte tallet sjekkes mot worker-01 under.
    expect(await openStreams(page, 'demo-web-02')).toBeGreaterThanOrEqual(2);
  });

  test('dyplenke fra feilet tjeneste lander med enhetsfilter, og ingen strøm står igjen etter at siden forlates', async ({ page }, testInfo) => {
    // Kun ett prosjekt, så tellingen for worker-01 er vår alene (prosjektene kjører parallelt mot samme hub).
    test.skip(isMobileProject(testInfo), 'strømtellingen krever at ingen andre bruker worker-01');
    await forceLang(page, 'en');
    await loginViaApi(page);
    await page.goto('/servers/demo-worker-01');
    const failed = page.locator('gp-svc-panel [data-service="cron-sync.service"]');
    await failed.scrollIntoViewIfNeeded();
    await expect(failed.locator('.status')).toHaveText('failed');
    await failed.getByRole('button', { name: 'View log' }).click();
    await expect(page).toHaveURL(/\/logs\?server=demo-worker-01&source=journal&unit=cron-sync\.service$/);
    await expect(page.locator('.hintrow .chip')).toContainText('Unit · cron-sync.service');
    await expect(lines(page).first()).toBeVisible({ timeout: 15_000 });
    await expect(lines(page).first().locator('.msg')).toContainText('cron-sync.service');
    expect(await openStreams(page, 'demo-worker-01')).toBe(1);

    await page.locator('.hintrow .chip').click();
    await expect(page).not.toHaveURL(/unit=/);
    await expect(lines(page).first()).toBeVisible({ timeout: 15_000 });

    await page.getByRole('link', { name: 'Servers' }).first().click();
    await expect(page).toHaveURL(/\/$/);
    await expect.poll(() => openStreams(page, 'demo-worker-01'), { timeout: 10_000 }).toBe(0);
  });
});
