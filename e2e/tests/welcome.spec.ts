// Første gang på telefonen (IMPLEMENTERINGSPLAN steg 7.5, skjerm 14) i tre prosjekter: trinnene, «Turn on notifications»
// med mocket `Notification.requestPermission` og falsk push (ingen service worker under ng serve), den grønne pillen,
// desktop-banneret med «Install» fra et syntetisk `beforeinstallprompt`, og at første besøk på mobil går til /welcome.
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { loginViaApi } from '../helpers/auth';
import { forceLang } from '../helpers/e2e-api';
import { expectMobileRules, isMobileProject, navMasks } from '../helpers/mobile-rules';

/** Playwrights iPhone 14 er Safari uten hjemskjerm; slik simuleres «åpnet fra hjemskjermen» (navigator.standalone). */
const isWebKit = (testInfo: TestInfo) => testInfo.project.name === 'mobile-webkit';
async function asHomeScreenApp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { get: () => true, configurable: true });
  });
}

/** Falsk push utenom produksjon (PushService): tillatelsen svarer slik, og ingen abonnement registreres (ng serve har ingen service worker; WebKit på iPhone har ingen Notification). */
async function mockNotifications(page: Page, answer: 'granted' | 'denied' = 'granted'): Promise<void> {
  await page.addInitScript((result) => {
    (window as unknown as { __gpFakePush?: string }).__gpFakePush = result;
  }, answer);
}

test.describe('første gang på telefonen', () => {
  test('skjerm 14: to trinn, varsler på med grønn pille, Later går til oversikten', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await forceLang(page, 'en');
    await mockNotifications(page);
    await loginViaApi(page);
    await page.goto('/welcome');
    await expect(page.getByRole('heading', { name: 'Get alerts on your phone' })).toBeVisible();
    await expect(page.locator('.step .stitle')).toHaveText(['Add to home screen', 'Turn on notifications']);
    await expect(page.locator('gp-bottom-nav')).toHaveCount(0);
    if (!isMobileProject(testInfo)) await expect(page.locator('gp-sidebar')).toBeVisible();

    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('welcome.png', { fullPage: true, mask: navMasks(page) });

    if (isWebKit(testInfo)) {
      // iPhone i Safari: trinn 1 er fremhevet og knappen er byttet ut med forklaringen om hjemskjermen.
      await expect(page.getByTestId('ios-hint')).toContainText('home screen');
      await expect(page.locator('.step.hl')).toHaveCount(1);
      await expect(page.getByRole('button', { name: 'Turn on notifications' })).toHaveCount(0);
      await expectMobileRules(page, testInfo);
      expect(errors, 'sidefeil').toEqual([]);
      await page.getByRole('button', { name: 'Later' }).click();
      await expect(page).toHaveURL(/\/$/);
      return;
    }

    await page.getByRole('button', { name: 'Turn on notifications' }).click();
    await expect(page.getByTestId('push-on')).toHaveText('Notifications are on for this device');
    await expect(page.locator('.step.ok')).toHaveCount(1);
    await expectMobileRules(page, testInfo);
    expect(errors, 'sidefeil').toEqual([]);
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('avslått tillatelse forklares (iPhone: fra hjemskjermen)', async ({ page }, testInfo) => {
    await forceLang(page, 'en');
    if (isWebKit(testInfo)) await asHomeScreenApp(page);
    await mockNotifications(page, 'denied');
    await loginViaApi(page);
    await page.goto('/welcome');
    await page.getByRole('button', { name: 'Turn on notifications' }).click();
    await expect(page.getByTestId('push-denied')).toContainText('blocked');
    await expect(page.getByRole('button', { name: 'Turn on notifications' })).toHaveCount(0);
  });

  test('desktop: installasjonskortet vises når nettleseren tilbyr det', async ({ page }, testInfo) => {
    test.skip(isMobileProject(testInfo), 'beforeinstallprompt-banneret er for desktop');
    await forceLang(page, 'en');
    await mockNotifications(page);
    await loginViaApi(page);
    await page.goto('/welcome');
    await expect(page.getByRole('heading', { name: 'Get alerts on your phone' })).toBeVisible();
    await expect(page.getByTestId('install-card')).toHaveCount(0);
    await page.evaluate(() => {
      const e = Object.assign(new Event('beforeinstallprompt'), { prompt: () => Promise.resolve(), userChoice: Promise.resolve({ outcome: 'accepted' }) });
      window.dispatchEvent(e);
    });
    await expect(page.getByTestId('install-card')).toContainText('Install Glimtpanel as an app on this computer');
    await page.getByTestId('install-card').getByRole('button', { name: 'Install' }).click();
    await expect(page.getByTestId('install-card')).toContainText('Installed');
  });

  test('første besøk på mobil etter innlogging går til /welcome, bare én gang', async ({ page }, testInfo) => {
    test.skip(!isMobileProject(testInfo), 'skjerm 14 vises automatisk bare på mobil');
    await forceLang(page, 'en');
    await mockNotifications(page);
    await loginViaApi(page, undefined, { welcome: true });
    await page.goto('/');
    await expect(page).toHaveURL(/\/welcome$/);
    await page.getByRole('button', { name: 'Later' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: 'Servers' })).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(/\/$/);
  });
});
