// Skjerm 3 og «Legg til server» (IMPLEMENTERINGSPLAN steg 4.3–4.4): tom-tilstanden med kommando, nedtelling og
// Docker-valg; en falsk agent bruker nøkkelen (POST /api/e2e/enrol-fake-agent) og dialogen hopper til trinn 2;
// navn og tagger lagres, trinn 3 foreslår appen. Kjøres i alle tre prosjektene.
import { test, expect, type Locator, type Page } from '@playwright/test';
import { loginViaApi } from '../helpers/auth';
import { enrolFakeAgent, ensureEmptyOwner, forceLang, uniqueEmail, uniqueHostname } from '../helpers/e2e-api';
import { expectMobileRules } from '../helpers/mobile-rules';

const KEY_RE = /--key (gp_[A-Za-z0-9]{22}) --docker (proxy|simple)/;

async function readKey(scope: Page | Locator): Promise<{ key: string; mode: string }> {
  const text = (await scope.getByTestId('enrol-command').textContent()) ?? '';
  const m = KEY_RE.exec(text);
  expect(m, `kommandoen skal inneholde nøkkelen: ${text}`).not.toBeNull();
  return { key: m![1], mode: m![2] };
}

test.describe('legg til server', () => {
  test('skjerm 3: tom oversikt med kommando, nedtelling, Docker-valg og «venter»', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const owner = await ensureEmptyOwner(page);
    await forceLang(page, 'en');
    await loginViaApi(page, owner);
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Servers' })).toBeVisible();
    await expect(page.getByText('No servers yet')).toBeVisible();
    await expect(page.getByText('Paste one command on your Ubuntu server.')).toBeVisible();
    await expect(page.getByText('Run this on the server')).toBeVisible();
    await expect(page.getByTestId('enrol-command')).toHaveText(/curl -fsSL \S+ \| sh -s -- --key gp_[A-Za-z0-9]{22} --docker proxy/);
    await expect(page.getByRole('button', { name: 'Copy' })).toBeVisible();
    await expect(page.getByText('The one-time key expires in')).toBeVisible();
    const countdown = page.getByTestId('enrol-countdown');
    await expect(countdown).toHaveText(/^59:\d\d$/);
    const first = await countdown.textContent();
    await expect.poll(() => countdown.textContent(), { timeout: 5_000, message: 'nedtellingen skal gå' }).not.toBe(first);
    await expect(page.getByRole('radio', { name: 'Secure (recommended)' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('A small read-only proxy in front of the socket.')).toBeVisible();
    await expect(page.getByText('It can never change anything on the server.')).toBeVisible();
    await expect(page.getByText('Waiting for the agent…')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add a container' })).toBeVisible();
    await expect(page.getByTestId('summary')).toHaveText(/^0 servers · 0 up · 0 down · 0 paused · live · \d\d:\d\d:\d\d$/);

    // Docker-segmentet henter en ny nøkkel med det valget og bytter forklaringen.
    const before = await readKey(page);
    await page.getByRole('radio', { name: 'Simple' }).click();
    await expect(page.getByTestId('enrol-command')).toHaveText(/--docker simple/);
    await expect(page.getByText('The agent reads directly from the Docker socket.')).toBeVisible();
    const after = await readKey(page);
    expect(after.key).not.toBe(before.key);

    await expectMobileRules(page, testInfo);
    expect(errors, 'sidefeil').toEqual([]);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(700);
    await expect(page).toHaveScreenshot('empty-owner.png', { fullPage: true, mask: [page.getByTestId('enrol-command'), page.getByTestId('enrol-countdown'), page.getByTestId('summary')] });
  });

  test('Copy kopierer kommandoen og viser «Copied»', async ({ page, context }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile-webkit', 'WebKit i headless gir ikke tilgang til utklippstavlen');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const owner = await ensureEmptyOwner(page);
    await forceLang(page, 'en');
    await loginViaApi(page, owner);
    await page.goto('/');
    await expect(page.getByTestId('enrol-command')).toHaveText(KEY_RE);
    await page.getByRole('button', { name: 'Copy' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Copied to clipboard' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toMatch(KEY_RE);
  });

  test('full flyt: agenten kobler til, dialogen hopper til trinn 2, navn og tagger lagres, trinn 3 foreslår appen', async ({ page }, testInfo) => {
    const owner = await ensureEmptyOwner(page, uniqueEmail('add', testInfo));
    await forceLang(page, 'en');
    await loginViaApi(page, owner);
    await page.goto('/');
    await expect(page.getByTestId('enrol-command')).toHaveText(KEY_RE);
    const { key } = await readKey(page);
    const hostname = uniqueHostname(testInfo);

    // Den falske agenten bruker nøkkelen: huben sender ServerAdded, og dialogen åpnes på trinn 2.
    const serverId = await enrolFakeAgent(page, key, hostname);
    expect(serverId).toBe(`demo-${hostname}`);
    const dialog = page.getByRole('dialog', { name: 'Add server' });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog.locator('.connected')).toContainText(hostname);
    await expect(dialog.locator('.connected')).toContainText('connected · Ubuntu 24.04 · 2 cores · 4 GB');
    await expect(dialog.getByText('Give it a name and tags')).toBeVisible();
    const nameField = dialog.locator('gp-input input');
    await expect(nameField).toHaveValue(hostname);

    await nameField.fill(`${hostname}-renamed`);
    await dialog.getByRole('button', { name: 'Add tag' }).click();
    await dialog.getByRole('textbox', { name: 'Add tag' }).fill('e2e');
    await dialog.getByRole('textbox', { name: 'Add tag' }).press('Enter');
    await expect(dialog.locator('.tag', { hasText: /^e2e$/ })).toHaveAttribute('aria-pressed', 'true');
    await expectMobileRules(page, testInfo);

    const saved = page.waitForResponse((r) => r.url().includes(`/api/servers/${serverId}`) && r.request().method() === 'PATCH');
    await dialog.getByRole('button', { name: 'Next' }).click();
    expect((await saved).ok()).toBeTruthy();
    await expect(dialog.getByText('Get alerts on your phone: install the app and turn on notifications.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Show me' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();

    // Serveren står i oversikten med nytt navn og taggen, og lever.
    const card = page.locator(`gp-server-card[aria-label^="${hostname}-renamed:"]`);
    await expect(card).toBeVisible();
    await expect(card.locator('gp-badge')).toHaveText('e2e');
    await expect(card.locator('.status')).toHaveText('live');
    await expect(card.locator('gp-ring').first().locator('.val')).toHaveText(/^[1-9]\d?%$/);
    await expect(page.getByText('No servers yet')).toHaveCount(0);
    await expect(page.locator('.chip', { hasText: /^e2e$/ })).toBeVisible();

    // Nøkkelen er brukt: en ny agent med samme nøkkel avvises.
    const again = await page.request.post('/api/e2e/enrol-fake-agent', { data: { key, hostname: `${hostname}-2` } });
    expect(again.status()).toBe(404);
  });

  test('«Add server» i oversikten åpner dialogen på trinn 1, og «Show me» går til /welcome', async ({ page }, testInfo) => {
    const owner = await ensureEmptyOwner(page, uniqueEmail('dialog', testInfo));
    await forceLang(page, 'en');
    await loginViaApi(page, owner);
    await page.goto('/');
    // Fase 12: «+ Add» åpner menyen Server / Container.
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Server' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add server' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('enrol-command')).toHaveText(KEY_RE);
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeVisible();
    await expectMobileRules(page, testInfo);
    const { key } = await readKey(dialog);
    const hostname = uniqueHostname(testInfo);
    await enrolFakeAgent(page, key, hostname);
    await expect(dialog.locator('.connected')).toContainText(hostname, { timeout: 15_000 });
    await dialog.getByRole('button', { name: 'Next' }).click();
    await dialog.getByRole('button', { name: 'Show me' }).click();
    await expect(page).toHaveURL(/\/welcome$/);
  });
});
