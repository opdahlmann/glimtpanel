// Demoen (IMPLEMENTERINGSPLAN fase 10, steg 10.1; FB 15.1) i tre prosjekter: `/demo` uten innlogging viser oversikten med de
// 16 demoserverne, de tre containernodene og de to gruppene, serverside, containerside og logger under `/demo`; ingen varsler,
// deling eller eierknapper; innstillinger viser kun konto i visningsmodus; «Create a free account» går til registreringen;
// og huben avviser skriving fra demokontoen.
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { forceLang } from '../helpers/e2e-api';
import { expectMobileRules, isMobileProject, navMasks } from '../helpers/mobile-rules';

const DEMO_NAMES = ['web-01', 'web-02', 'api-prod', 'db-prod', 'worker-01', 'cache-01', 'staging-web', 'staging-db', 'acme-app', 'acme-db', 'nordic-shop', 'nordic-db', 'nas', 'pi-hole', 'media', 'backup'];

function liveMasks(page: Page) {
  return [page.locator('gp-ring'), page.locator('gp-chip'), page.locator('gp-sparkline'), page.getByTestId('summary'), page.locator('gp-server-card .info'), page.locator('gp-container-card .info'), page.locator('gp-container-card .status'), ...navMasks(page)];
}

async function waitForCards(page: Page): Promise<void> {
  for (const name of DEMO_NAMES) await expect(page.locator(`gp-server-card[aria-label^="${name}:"]`)).toBeVisible({ timeout: 15_000 });
}

/** Navigasjonen: sidepanelet på desktop, bunnlinjen på mobil. */
function navLinks(page: Page, testInfo: TestInfo) {
  return isMobileProject(testInfo) ? page.locator('gp-bottom-nav a') : page.locator('gp-sidebar nav a');
}

test.describe('demoen', () => {
  test('/demo uten innlogging: banner, hele oversikten, grupper, ingen varsler eller «Add»', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await forceLang(page, 'en');
    await page.goto('/demo');
    await expect(page).toHaveURL(/\/demo$/);
    await expect(page.getByTestId('demo-banner')).toContainText('Demo');
    await expect(page.getByTestId('demo-banner')).toContainText('fake servers');
    await expect(page.getByRole('heading', { name: 'Nodes' })).toBeVisible();
    await waitForCards(page);
    await expect(page.locator('gp-container-card')).toHaveCount(3);
    await expect(page.getByTestId('summary')).toHaveText(/^19 nodes · 16 servers · 3 containers/);

    // Varsler og deling er skjult: ingen Alerts i navigasjonen, ingen «Add», ingen «shared by».
    await expect(navLinks(page, testInfo)).toHaveText(['Servers', 'Logs', 'Settings']);
    await expect(navLinks(page, testInfo).first()).toHaveAttribute('href', '/demo');
    await expect(page.getByRole('button', { name: 'Add' })).toHaveCount(0);
    await expect(page.locator('gp-server-card .info', { hasText: 'shared by' })).toHaveCount(0);
    if (!isMobileProject(testInfo)) {
      await expect(page.locator('gp-sidebar .role')).toHaveText('Demo');
      await expect(page.locator('gp-sidebar .uname')).toHaveText('Demo');
    }

    // Gruppene fra 13.3: demokontoen har sin egen kopi, lesbar.
    await page.getByRole('radio', { name: 'Groups' }).click();
    await expect(page.locator('gp-group-card[data-group="Acme"]')).toBeVisible();
    await expect(page.locator('gp-group-card[data-group="Edge"]')).toBeVisible();
    await expect(page.locator('gp-group-card')).toHaveCount(2);
    await page.getByRole('radio', { name: 'Cards' }).click();
    await waitForCards(page);

    expect(errors, 'sidefeil').toEqual([]);
    await expectMobileRules(page, testInfo);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(700);
    await expect(page).toHaveScreenshot('demo-overview.png', { fullPage: true, mask: liveMasks(page) });

    // Kortet åpner serversiden under /demo (absolutte lenker sendes tilbake til demoen).
    await page.locator('gp-server-card[aria-label^="web-02:"]').first().focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/demo\/servers\/demo-web-02$/);
    await expect(page.getByTestId('demo-banner')).toBeVisible();
  });

  test('serverside, containerside og logger under /demo uten eierknapper', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await forceLang(page, 'en');
    await page.goto('/demo/servers/demo-web-02');
    await expect(page.locator('h1')).toHaveText('web-02');
    await expect(page.getByTestId('status')).toHaveText('live');
    await expect(page.getByRole('button', { name: 'Alert settings' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Share link' })).toHaveCount(0);
    await expect(page.getByTestId('info')).not.toContainText('shared by');
    await expect(page.locator('gp-cpu-panel')).toBeVisible();

    // Tilbake-knappen (navigate(['/'])) lander på /demo, ikke på innloggingen.
    await page.locator('header .back').click();
    await expect(page).toHaveURL(/\/demo$/);

    // Containernoden fra 12.11 og logger for en demoserver.
    await page.goto('/demo/servers/demo-acme-backend');
    await expect(page.locator('h1')).toHaveText('acme-backend');
    await expect(page.getByTestId('demo-banner')).toBeVisible();
    await navLinks(page, testInfo).filter({ hasText: 'Logs' }).click();
    await expect(page).toHaveURL(/\/demo\/logs/);
    await page.goto('/demo/logs?server=demo-web-02');
    await expect(page.getByRole('heading', { name: 'Logs' })).toBeVisible();
    await expect(page.locator('gp-select select').first()).toHaveValue('demo-web-02');
    await expect(page.locator('gp-log-view .line:not(.dropped)').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('log-status')).toContainText('streaming');
    expect(errors, 'sidefeil').toEqual([]);
    await expectMobileRules(page, testInfo);
  });

  test('innstillinger i demoen viser kun konto i visningsmodus; «Create a free account» avslutter demoen', async ({ page }, testInfo) => {
    await forceLang(page, 'en');
    await page.goto('/demo/settings/alerts');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.locator('gp-settings-page > .page > gp-segment')).toHaveCount(0); // ingen faner
    await expect(page.getByRole('radio', { name: 'Alerts' })).toHaveCount(0);
    await expect(page.getByTestId('demo-view-only')).toContainText('View only in the demo');
    await expect(page.getByTestId('email')).toHaveText('demo@glimtpanel.com');
    await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete account' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Change password' })).toHaveCount(0);
    await expectMobileRules(page, testInfo);
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot('demo-settings.png', { fullPage: true, mask: navMasks(page) });

    await page.getByTestId('demo-create-account').click();
    await expect(page).toHaveURL(/\/register$/);
    // Demoen er over: roten krever innlogging igjen.
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('huben avviser skriving fra demokontoen (403), lesing går', async ({ page }) => {
    const session = await page.request.post('/api/demo/session');
    expect(session.ok()).toBeTruthy();
    const { accessToken } = (await session.json()) as { accessToken: string };
    const headers = { authorization: `Bearer ${accessToken}` };
    const patch = await page.request.patch('/api/account', { headers, data: { name: 'Nope' } });
    expect(patch.status()).toBe(403);
    expect(((await patch.json()) as { title: string }).title).toBe('The demo account is read-only');
    const invite = await page.request.post('/api/access', { headers, data: { email: 'x@example.com' } });
    expect(invite.status()).toBe(403);
    const list = await page.request.get('/api/servers', { headers });
    expect(list.ok()).toBeTruthy();
    const servers = (await list.json()) as { id: string; role: string }[];
    expect(servers.filter((s) => s.id.startsWith('demo-')).every((s) => s.role === 'reader')).toBe(true);
  });
});
