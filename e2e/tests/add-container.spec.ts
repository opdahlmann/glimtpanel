// «Legg til container» (IMPLEMENTERINGSPLAN steg 12.10, skjerm 22): «+ Add» → Container, navn og «Create» gir tokenet
// én gang med snuttene, den falske containeragenten bruker tokenet (POST /api/e2e/connect-fake-container) og dialogen
// hopper til trinn 2 der tagger lagres. Kjøres i alle tre prosjektene.
import { test, expect } from '@playwright/test';
import { loginViaApi } from '../helpers/auth';
import { connectFakeContainer, ensureEmptyOwner, forceLang, uniqueEmail } from '../helpers/e2e-api';
import { expectMobileRules } from '../helpers/mobile-rules';

test.describe('legg til container', () => {
  test('skjerm 22: opprett → token vises én gang → agenten kobler til → trinn 2 med tagger', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const owner = await ensureEmptyOwner(page, uniqueEmail('node', testInfo));
    await forceLang(page, 'en');
    await loginViaApi(page, owner);
    await page.goto('/');

    // Tom-tilstanden har knappen «Add a container» (12.8); menyen under «+ Add» har det samme valget.
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByTestId('add-menu')).toBeVisible();
    await page.getByRole('menuitem', { name: 'Container' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add container' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Node name')).toBeVisible();
    await dialog.locator('gp-input input').fill(`api-${testInfo.project.name.replace(/[^a-z0-9]+/g, '-')}`);
    await dialog.getByRole('button', { name: 'Create' }).click();

    // Trinn 1: tokenet i <code> med Copy og «shown only once», segmentet bytter snutt, feltene fyller snutten.
    const token = dialog.getByTestId('node-token');
    await expect(token).toHaveText(/^agt_[A-Za-z0-9_-]{20,}$/);
    await expect(dialog.getByText('shown only once')).toBeVisible();
    await expect(dialog.getByRole('radio', { name: 'Sidecar (Compose)' })).toHaveAttribute('aria-checked', 'true');
    const snippet = dialog.getByTestId('node-snippet');
    await expect(snippet).toContainText('pid: "service:app"');
    await expect(snippet).toContainText('# GLIMT_HEALTH_URL:');
    await dialog.locator('gp-input input[name="healthUrl"]').fill('http://127.0.0.1:3000/healthz');
    await expect(snippet).toContainText('GLIMT_HEALTH_URL: http://127.0.0.1:3000/healthz');
    await expect(snippet).not.toContainText('# GLIMT_HEALTH_URL:');
    await dialog.getByRole('radio', { name: 'In your image' }).click();
    await expect(snippet).toContainText('COPY --from=');
    await expect(snippet).toContainText('ENV GLIMT_HEALTH_URL=http://127.0.0.1:3000/healthz');
    await expect(dialog.getByText('Waiting for the container…')).toBeVisible();
    await expectMobileRules(page, testInfo);
    await page.evaluate(() => document.fonts.ready);
    await expect(dialog).toHaveScreenshot('add-container-token.png', { mask: [token, snippet] });

    // Den falske agenten bruker tokenet: ServerStatus gir up, dialogen hopper til trinn 2.
    const serverId = await connectFakeContainer(page, (await token.textContent())!.trim());
    await expect(dialog.locator('.connected')).toContainText('connected', { timeout: 15_000 });
    await dialog.locator('.tag.add').click();
    await dialog.locator('.tag-input').fill('client-c');
    await dialog.locator('.tag-input').press('Enter');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);

    // Kortet i oversikten er et containerkort med image og helse; listen har noden som container.
    const card = page.locator(`gp-container-card[aria-label^="api-"]`).first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.locator('.info')).toContainText('container · ghcr.io/acme/app:1.0.0');
    await expect(card.locator('gp-badge')).toHaveText(['client-c']);
    const list = await page.request.get('/api/servers', { headers: { Authorization: `Bearer ${await loginViaApi(page, owner)}` } });
    const nodes = ((await list.json()) as { id: string; kind: string; tags: string[] }[]).filter((s) => s.id === serverId);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('container');
    expect(nodes[0].tags).toEqual(['client-c']);
    expect(errors, 'sidefeil').toEqual([]);
  });
});
