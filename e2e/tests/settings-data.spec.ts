// Innstillinger › Abonnement og Data (IMPLEMENTERINGSPLAN steg 8.5–8.7, skjerm 13) i tre prosjekter: det grønne
// beta-kortet med tre chips, «What it would cost today» og nedlasting av eksporten som JSON-fil.
import { test, expect } from '@playwright/test';
import { ownerWithServer } from '../helpers/auth';
import { expectMobileRules, navMasks } from '../helpers/mobile-rules';

test.describe('innstillinger › abonnement og data', () => {
  test('skjerm 13: beta-kortet, prisen i dag og eksport som fil', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const { hostname, token, owner } = await ownerWithServer(page, testInfo, 'sub');

    await page.goto('/settings/subscription');
    await expect(page.getByTestId('beta-card')).toContainText('Free in beta');
    await expect(page.getByTestId('beta-card').locator('gp-chip .value')).toHaveText(['1', '2', '0']);
    await expect(page.getByTestId('beta-card')).toContainText('per node');
    await expect(page.getByTestId('cost')).toHaveText('0 USD');
    await expect(page.getByTestId('cost-card')).toContainText('0 × 12 USD · 60 days notice');
    await expect(page.getByTestId('cost-card')).toContainText('Payment options appear here when pricing starts');
    await expectMobileRules(page, testInfo);
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot('subscription.png', { fullPage: true, mask: navMasks(page) });

    await page.goto('/settings/data');
    await expect(page.getByTestId('export-card')).toBeVisible();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download everything' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('glimtpanel-export.json');
    const body = JSON.parse(await (await download.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks).toString('utf8'))) as { user: { email: string }; servers: { name: string; kind: string }[]; groups: unknown[] };
    expect(body.user.email).toBe(owner.email);
    expect(body.servers.map((s) => s.name)).toEqual([hostname]);
    expect(body.servers[0].kind).toBe('server');
    expect(Array.isArray(body.groups)).toBe(true);
    await expect(page.getByRole('button', { name: 'Delete everything' })).toBeVisible();
    await expectMobileRules(page, testInfo);
    await expect(page).toHaveScreenshot('data.png', { fullPage: true, mask: navMasks(page) });
    expect(errors, 'sidefeil').toEqual([]);
  });
});
