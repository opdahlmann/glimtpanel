// Auth-skjermene og skallet (IMPLEMENTERINGSPLAN steg 3.3, 3.6): innlogging, sesjon over omlasting, utlogging,
// beskyttede ruter, språkbytte og mobilsjekklisten. Kjører i alle tre prosjektene.
import { test, expect } from '@playwright/test';
import { DEV_USER, gotoOverviewLoggedIn, loginViaForm, SERVERS_HEADING } from '../helpers/auth';
import { expectMobileRules, isMobileProject } from '../helpers/mobile-rules';

test.describe('innlogging', () => {
  test('innloggingsskjermen ser ut som skjerm 1 og følger mobilsjekklisten', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Glimtpanel' })).toBeVisible();
    await expect(page.getByText('Everything your servers are doing, right now.')).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Sign in' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('radio', { name: 'Create account' })).toBeVisible();
    await expect(page.getByPlaceholder('Email')).toBeVisible();
    await expect(page.getByPlaceholder('Password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Forgot password?' })).toBeVisible();
    await expect(page.getByText('Free in beta · 2 servers always free')).toBeVisible();
    // Autofokus i første felt kun på desktop (6.4: tastaturet skal ikke sprette opp på mobil).
    const emailFocused = await page.getByPlaceholder('Email').evaluate((el) => el === document.activeElement);
    expect(emailFocused).toBe(!isMobileProject(testInfo));

    await expectMobileRules(page, testInfo);
    expect(errors, 'sidefeil').toEqual([]);

    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400); // pdIn (250 ms)
    await expect(page).toHaveScreenshot('login.png', { fullPage: true });
  });

  test('segmentet bytter til registrering uten omlasting', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('radio', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/register$/);
    await expect(page.getByPlaceholder('Name')).toBeVisible();
    await expect(page.getByText('We send a confirmation email.')).toBeVisible();
    await page.getByRole('radio', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('tomt skjema viser valideringsfeil fra ordboken', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Enter a valid e-mail address')).toBeVisible();
    await expect(page.getByText('At least 10 characters')).toBeVisible();
  });

  test('feil passord viser «Wrong e-mail or password»', async ({ page }) => {
    await loginViaForm(page, { email: DEV_USER.email, password: 'definitely-wrong-password' });
    await expect(page.getByRole('alert')).toHaveText(/Wrong e-mail or password/);
    await expect(page).toHaveURL(/\/login$/);
  });

  test('dev-brukeren lander på / med sidepanel (desktop) eller topplinje + bunnlinje (mobil)', async ({ page }, testInfo) => {
    await loginViaForm(page);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: SERVERS_HEADING })).toBeVisible();
    if (isMobileProject(testInfo)) {
      await expect(page.locator('gp-topbar')).toBeVisible();
      await expect(page.locator('gp-bottom-nav')).toBeVisible();
      await expect(page.locator('gp-sidebar')).toHaveCount(0);
      await expect(page.locator('gp-bottom-nav a')).toHaveCount(4);
    } else {
      await expect(page.locator('gp-sidebar')).toBeVisible();
      await expect(page.locator('gp-sidebar nav a')).toHaveCount(4);
      await expect(page.locator('gp-sidebar').getByText(/(by|av) Kodetank/)).toBeVisible();
      await expect(page.locator('gp-topbar')).toHaveCount(0);
      await expect(page.locator('gp-bottom-nav')).toHaveCount(0);
    }
    await expectMobileRules(page, testInfo);
  });

  test('omlasting beholder sesjonen (oppfriskningscookie)', async ({ page }) => {
    await gotoOverviewLoggedIn(page);
    await page.reload();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: SERVERS_HEADING })).toBeVisible();
  });

  test('utlogging går til /login, og omlasting holder deg utlogget', async ({ page }) => {
    await gotoOverviewLoggedIn(page);
    await page.getByRole('button', { name: /^(Sign out|Logg ut)$/ }).first().click();
    await expect(page).toHaveURL(/\/login$/);
    await page.reload();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('/servers/x uinnlogget sendes til /login?next=', async ({ page }) => {
    await page.goto('/servers/x');
    await expect(page).toHaveURL(/\/login\?next=%2Fservers%2Fx$/);
    await expect(page.getByRole('heading', { name: 'Glimtpanel' })).toBeVisible();
  });

  test('språkbytte til norsk bytter tekstene uten omlasting', async ({ page }, testInfo) => {
    await gotoOverviewLoggedIn(page);
    const scope = page.locator(isMobileProject(testInfo) ? 'gp-topbar' : 'gp-sidebar');
    const saved = page.waitForResponse((r) => r.url().includes('/api/account') && r.request().method() === 'PATCH');
    await scope.getByRole('radio', { name: 'NO' }).click();
    try {
      await expect(page.getByRole('heading', { name: 'Servere' })).toBeVisible();
      if (!isMobileProject(testInfo)) {
        await expect(page.locator('gp-sidebar nav a')).toHaveText(['Servere', 'Logger', 'Varsler', 'Innstillinger']);
        await expect(page.locator('gp-sidebar').getByText('av Kodetank')).toBeVisible();
      } else {
        await expect(page.locator('gp-bottom-nav a')).toHaveText(['Servere', 'Logger', 'Varsler', 'Innstillinger']);
      }
      expect((await saved).ok()).toBeTruthy();
      // valget huskes i localStorage
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Servere' })).toBeVisible();
    } finally {
      // Tilbake til engelsk i profilen så de andre testene ikke arver norsk.
      await scope.getByRole('radio', { name: 'EN' }).click();
      await expect(page.getByRole('heading', { name: 'Servers' })).toBeVisible();
    }
  });
});
