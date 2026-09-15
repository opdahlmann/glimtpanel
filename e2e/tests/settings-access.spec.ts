// Innstillinger › Tilganger og leser-opplevelsen (IMPLEMENTERINGSPLAN steg 8.4 og 8.7, skjerm 12 og 18) i tre
// prosjekter: invitasjon → raden med initialer og omfang → leseren (egen kontekst) ser eierens server med «shared by»,
// uten eierknapper, og får 403 fra huben på eierhandlinger; «Remove access» tar den bort igjen. Ugyldig akseptlenke
// viser en forklaring.
import { test, expect } from '@playwright/test';
import { loginViaApi, ownerWithServer } from '../helpers/auth';
import { ensureEmptyOwner, forceLang, uniqueEmail } from '../helpers/e2e-api';
import { expectMobileRules, navMasks } from '../helpers/mobile-rules';

test.describe('innstillinger › tilganger', () => {
  test('skjerm 12 og 18: inviter en leser, leseren ser serveren uten eierknapper, fjern tilgangen', async ({ page, browser }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const reader = await ensureEmptyOwner(page, uniqueEmail('invitee', testInfo));
    const { serverId, hostname, token, owner } = await ownerWithServer(page, testInfo, 'inviter');

    await page.goto('/settings/access');
    await expect(page.getByTestId('invite-card')).toBeVisible();
    await expect(page.getByTestId('grants-card')).toContainText('Nobody has access yet');
    await page.getByLabel('E-mail to invite').fill(reader.email);
    await expect(page.getByLabel('Scope').locator('option')).toHaveText(['All servers']);
    await page.getByRole('button', { name: 'Invite' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Invitation sent' }).first()).toBeVisible();
    const grid = page.locator('gp-data-grid');
    await expect(grid.locator('.ag-row')).toHaveCount(1);
    await expect(grid).toContainText(reader.email);
    await expect(grid).toContainText(/reader/i);
    await expect(grid).toContainText('All servers');
    await expect(grid).toContainText('accepted');

    await expectMobileRules(page, testInfo);
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot('access.png', { fullPage: true, mask: [grid, ...navMasks(page)] });

    // Leseren i egen kontekst (skjerm 18): serveren med «shared by», ingen «Add», ingen varselinnstillinger, fanene for eiere stengt, 403 fra huben.
    const context = await browser.newContext(testInfo.project.use);
    const readerPage = await context.newPage();
    await forceLang(readerPage, 'en');
    const readerToken = await loginViaApi(readerPage, reader);
    await readerPage.goto('/');
    const card = readerPage.locator(`gp-server-card[aria-label^="${hostname}:"]`);
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.locator('.info')).toContainText(`shared by ${owner.email}`);
    await expect(readerPage.getByRole('button', { name: 'Add', exact: true })).toHaveCount(0);
    await readerPage.goto(`/servers/${serverId}`);
    await expect(readerPage.getByTestId('info')).toContainText(`shared by ${owner.email}`);
    await expect(readerPage.getByRole('button', { name: 'Alert settings' })).toHaveCount(0);
    await readerPage.goto('/settings/servers');
    await expect(readerPage.getByTestId('owners-only')).toBeVisible();
    await readerPage.goto('/settings/access');
    await expect(readerPage.getByTestId('owners-only')).toBeVisible();
    const forbidden = await readerPage.request.patch(`/api/servers/${serverId}`, { headers: { authorization: `Bearer ${readerToken}` }, data: { name: 'hijack' } });
    expect(forbidden.status()).toBe(403);
    await context.close();

    // Ugyldig akseptlenke: forklaring, ikke krasj.
    await page.goto('/access/accept?token=not-a-token');
    await expect(page.getByTestId('accept-error')).toBeVisible();

    // Fjern tilgangen.
    await page.goto('/settings/access');
    await (page.locator('gp-data-grid [data-action="remove"]').or(page.locator('gp-data-grid').getByRole('button', { name: 'Remove access' }))).first().click();
    await expect(page.getByTestId('grants-card')).toContainText('Nobody has access yet');
    expect(errors, 'sidefeil').toEqual([]);
  });
});
