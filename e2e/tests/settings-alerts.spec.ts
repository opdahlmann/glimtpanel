// Innstillinger › Varsler (IMPLEMENTERINGSPLAN steg 7.4 og 7.6, skjerm 10) i tre prosjekter: standardterskler med
// redigering, kanaler, daglig oppsummering, «Save» kun ved endring, og per-server-visningen med «Use account defaults»,
// overstyring og «Mute all alerts for this server». Hvert prosjekt får sin egen eier og sin egen falske server, så
// prosjektene ikke skriver over hverandres innstillinger mens de kjører parallelt.
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { ownerWithServer } from '../helpers/auth';
import { triggerE2E } from '../helpers/e2e-api';
import { expectMobileRules, navMasks } from '../helpers/mobile-rules';

const ruleRow = (page: Page, rule: string) => page.locator(`.rrow[data-rule="${rule}"]`);

test.describe('innstillinger › varsler', () => {
  test('skjerm 10: terskler, kanaler og oppsummering; Save kun ved endring', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const { owner } = await ownerWithServer(page, testInfo, 'settings');
    await page.goto('/settings/alerts');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.locator('gp-segment [role="radio"]')).toHaveText(['EN', 'NO', 'Account', 'Alerts', 'Servers', 'Access', 'Subscription', 'Data']);
    await expect(page.getByRole('radio', { name: 'Alerts' })).toHaveAttribute('aria-checked', 'true');

    // Sju regler med standardene fra ordboken, alle på.
    await expect(page.locator('.rrow')).toHaveCount(8);
    await expect(ruleRow(page, 'mem_pressure').locator('.rdef')).toHaveText('> 95 % for 5 min');
    await expect(ruleRow(page, 'disk_full').locator('.rdef')).toHaveText('> 90 % on a mount');
    await expect(ruleRow(page, 'server_down').locator('.rdef')).toHaveText('No heartbeat for 2 min');
    await expect(page.locator('.rrow [role="switch"][aria-checked="true"]')).toHaveCount(8);
    const save = page.getByRole('button', { name: 'Save' });
    await expect(save).toBeDisabled();

    // Kanaler: push-enheter, e-post med «alltid på», webhook-felt, hemmelighet skjult, oppsummering 08:00.
    await expect(page.getByTestId('push-devices')).toBeVisible();
    await expect(page.getByText('Always on for server down and disk full')).toBeVisible();
    await expect(page.getByTestId('email-line')).toContainText(owner.email);
    await expect(page.getByTestId('webhook-secret')).toHaveText('••••••••••••');
    await page.getByRole('button', { name: 'Show' }).click();
    await expect(page.getByTestId('webhook-secret')).toHaveText(/^whs_[0-9a-f]{48}$/);
    await page.getByRole('button', { name: 'Hide' }).click();
    await expect(page.getByTestId('digest-time')).toHaveValue('08:00');

    // Rediger minne til 90 % i 10 min, slå av omstart, sett webhook: Save aktiv → lagret → tekstene følger.
    await ruleRow(page, 'mem_pressure').getByRole('button', { name: 'Edit Memory pressure' }).click();
    await ruleRow(page, 'mem_pressure').getByLabel('Default').fill('90');
    await ruleRow(page, 'mem_pressure').getByLabel('minutes').fill('10');
    await ruleRow(page, 'mem_pressure').getByRole('button', { name: 'Done' }).click();
    await ruleRow(page, 'reboot').locator('[role="switch"]').click();
    await page.getByLabel('Webhook URL').fill('https://hooks.example/glimt');
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    await expect(save).toBeDisabled();
    await expect(ruleRow(page, 'mem_pressure').locator('.rdef')).toHaveText('> 90 % for 10 min');
    await expect(ruleRow(page, 'reboot').locator('[role="switch"]')).toHaveAttribute('aria-checked', 'false');
    await page.reload();
    await expect(ruleRow(page, 'mem_pressure').locator('.rdef')).toHaveText('> 90 % for 10 min');
    await expect(page.getByLabel('Webhook URL')).toHaveValue('https://hooks.example/glimt');

    // Varselsiden viser den justerte standarden.
    await page.goto('/alerts');
    await expect(page.locator('.rrow[data-rule="mem_pressure"] .rdef')).toHaveText('> 90 % for 10 min');
    await expect(page.locator('.rrow[data-rule="reboot"] gp-badge', { hasText: 'Off' })).toBeVisible();

    await page.goto('/settings/alerts');
    await expect(page.locator('.rrow')).toHaveCount(8);
    await expectMobileRules(page, testInfo);
    expect(errors, 'sidefeil').toEqual([]);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    await expect(page).toHaveScreenshot('settings-alerts.png', { fullPage: true, mask: [page.getByTestId('push-devices'), page.getByTestId('email-line'), ...navMasks(page)] });
  });

  test('per server: «Alerts for …», overstyring, kontostandarder og demp', async ({ page }, testInfo) => {
    const { serverId, hostname } = await ownerWithServer(page, testInfo, 'srvsettings');
    await page.goto(`/servers/${serverId}`);
    await page.getByRole('button', { name: 'Alert settings' }).click();
    await expect(page).toHaveURL(new RegExp(`/settings/alerts\\?server=${serverId}$`));
    await expect(page.getByTestId('alerts-for')).toHaveText(`Alerts for ${hostname}`);
    const useDefaults = page.getByRole('switch', { name: 'Use account defaults' });
    await expect(useDefaults).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.rrow')).toHaveCount(8);
    // Kontostandarder: reglene kan ikke redigeres.
    await expect(ruleRow(page, 'disk_full').locator('button.rdef')).toHaveCount(0);

    await useDefaults.click();
    await ruleRow(page, 'disk_full').getByRole('button', { name: 'Edit Disk almost full' }).click();
    await ruleRow(page, 'disk_full').getByLabel('Default').fill('95');
    await ruleRow(page, 'disk_full').getByRole('button', { name: 'Done' }).click();
    await page.getByRole('switch', { name: 'Mute all alerts for this server' }).click();
    const save = page.getByRole('button', { name: 'Save' });
    await save.click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    await expect(ruleRow(page, 'disk_full').locator('gp-badge', { hasText: 'overridden' })).toBeVisible();
    await expect(ruleRow(page, 'disk_full').locator('.rdef')).toHaveText('> 95 % on a mount');
    await page.reload();
    await expect(useDefaults).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('switch', { name: 'Mute all alerts for this server' })).toHaveAttribute('aria-checked', 'true');
    await expect(ruleRow(page, 'disk_full').locator('.rdef')).toHaveText('> 95 % on a mount');

    // Dempet: en tjeneste feiler → varselet står i listen som «silenced» (vist, ikke sendt).
    await triggerE2E(page, 'fail-service', { serverId, unit: 'backup.service' });
    await page.goto('/alerts');
    const row = page.locator(`.row[data-server="${serverId}"][data-rule="svc_failed"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.locator('gp-badge', { hasText: 'silenced' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Silence' })).toHaveCount(0);

    // Tilbake til kontostandarder og lyd på.
    await page.goto(`/settings/alerts?server=${serverId}`);
    await useDefaults.click();
    await page.getByRole('switch', { name: 'Mute all alerts for this server' }).click();
    await save.click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    await expect(ruleRow(page, 'disk_full').locator('.rdef')).toHaveText('> 90 % on a mount');
    await expect(ruleRow(page, 'disk_full').locator('gp-badge', { hasText: 'overridden' })).toHaveCount(0);
    await expectMobileRules(page, testInfo);
    await page.goto('/alerts');
    await expect(row.locator('gp-badge', { hasText: 'silenced' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Silence' })).toBeVisible();
  });
});
