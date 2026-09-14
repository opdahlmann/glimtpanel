// Innstillinger › Konto (IMPLEMENTERINGSPLAN steg 8.2 og 8.7, skjerm 9) i tre prosjekter: profil med navn, tidssone
// og språk, passordbytte i dialog, og «Delete account» med passord → /login. Hver test får sin egen konto.
import { test, expect } from '@playwright/test';
import { loginViaApi } from '../helpers/auth';
import { E2E_PASSWORD, ensureEmptyOwner, forceLang, uniqueEmail } from '../helpers/e2e-api';
import { expectMobileRules, navMasks } from '../helpers/mobile-rules';

test.describe('innstillinger › konto', () => {
  test('skjerm 9: profil, tidssone, språk, passord og sletting', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const owner = await ensureEmptyOwner(page, uniqueEmail('account', testInfo));
    await forceLang(page, 'en');
    await loginViaApi(page, owner);
    await page.goto('/settings/account');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Account' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('email')).toHaveText(owner.email);
    const save = page.getByRole('button', { name: 'Save' });
    await expect(save).toBeDisabled();

    await expectMobileRules(page, testInfo);
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot('account.png', { fullPage: true, mask: [page.getByTestId('email'), ...navMasks(page)] });

    // Navn og tidssone med offset i teksten → Save aktiv → toast.
    await page.getByLabel('Name').fill('Ola Nordmann');
    await page.getByLabel('Time zone').selectOption('Europe/Oslo');
    await expect(page.getByLabel('Time zone').locator('option:checked')).toHaveText(/^Europe\/Oslo \(UTC[+-]\d\d:\d\d\)$/);
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved' }).first()).toBeVisible();
    const me = await page.request.get('/api/auth/me', { headers: { authorization: `Bearer ${await loginViaApi(page, owner)}` } });
    expect(((await me.json()) as { name: string; timezone: string }).name).toBe('Ola Nordmann');
    expect(((await me.json()) as { timezone: string }).timezone).toBe('Europe/Oslo');

    // Språk bytter straks.
    await page.getByRole('radio', { name: 'Norsk' }).click();
    await expect(page.getByRole('heading', { name: 'Innstillinger' })).toBeVisible();
    await page.getByRole('radio', { name: 'English' }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

    // E-postbytte krever passord; feil passord avvises, riktig gir «sjekk innboksen».
    await page.getByRole('button', { name: 'Edit' }).click();
    const emailDialog = page.getByRole('dialog', { name: 'New e-mail' });
    await emailDialog.getByLabel('New e-mail').fill(uniqueEmail('changed', testInfo));
    await emailDialog.getByLabel('Confirm with your password').fill('wrong-password');
    await emailDialog.getByRole('button', { name: 'Save' }).click();
    await expect(emailDialog.getByRole('alert')).toHaveText('Password is wrong');
    await emailDialog.getByLabel('Confirm with your password').fill(E2E_PASSWORD);
    await emailDialog.getByRole('button', { name: 'Save' }).click();
    await expect(emailDialog).toHaveCount(0);
    await expect(page.getByTestId('pending-email')).toContainText('Check the new mailbox');

    // Passord: gammelt må stemme.
    await page.getByRole('button', { name: 'Change password' }).first().click();
    const pwDialog = page.getByRole('dialog', { name: 'Change password' });
    await pwDialog.getByLabel('Current password').fill('wrong-password');
    await pwDialog.getByLabel('New password').fill('NewPassword-2026!');
    await pwDialog.getByRole('button', { name: 'Change password' }).click();
    await expect(pwDialog.getByRole('alert')).toHaveText('Password is wrong');
    await pwDialog.getByLabel('Current password').fill(E2E_PASSWORD);
    await pwDialog.getByRole('button', { name: 'Change password' }).click();
    await expect(pwDialog).toHaveCount(0);

    // Slett konto: passordet må stemme; så /login og kontoen er borte.
    await page.getByRole('button', { name: 'Delete account' }).click();
    const del = page.getByRole('dialog', { name: 'Delete account' });
    await expect(del.getByRole('alert')).toContainText('Cannot be undone');
    await del.getByLabel('Type your password to confirm').fill(E2E_PASSWORD);
    await del.getByRole('button', { name: 'Delete account' }).click();
    await expect(del.getByRole('alert').last()).toHaveText('Password is wrong');
    await del.getByLabel('Type your password to confirm').fill('NewPassword-2026!');
    await del.getByRole('button', { name: 'Delete account' }).click();
    await expect(page).toHaveURL(/\/login/);
    const gone = await page.request.post('/api/auth/login', { data: { email: owner.email, password: 'NewPassword-2026!' } });
    expect(gone.status()).toBe(401);
    expect(errors, 'sidefeil').toEqual([]);
  });
});
