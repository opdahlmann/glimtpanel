// Innstillinger › Servere (IMPLEMENTERINGSPLAN steg 8.3 og 8.7, skjerm 11) i tre prosjekter: plasslinjen, gridet med
// begge nodetypene, tagger i rad-dialog, «Rotate key» (token én gang for containernoder) og «Remove» med
// avinstalleringskommando eller compose-hint. Hver test får sin egen eier med én server og én containernode.
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { loginViaApi } from '../helpers/auth';
import { connectFakeContainer, enrolFakeAgent, ensureEmptyOwner, forceLang, uniqueEmail, uniqueHostname } from '../helpers/e2e-api';
import { expectMobileRules, isMobileProject, navMasks } from '../helpers/mobile-rules';

async function ownerWithNodes(page: Page, testInfo: TestInfo): Promise<{ hostname: string; nodeName: string }> {
  const owner = await ensureEmptyOwner(page, uniqueEmail('srvset', testInfo));
  await forceLang(page, 'en');
  const token = await loginViaApi(page, owner);
  const headers = { authorization: `Bearer ${token}` };
  const keyRes = await page.request.post('/api/servers/enrol-key', { headers, data: { dockerMode: 'none' } });
  const { key } = (await keyRes.json()) as { key: string };
  const hostname = uniqueHostname(testInfo);
  await enrolFakeAgent(page, key, hostname);
  const nodeName = `node-${testInfo.project.name.replace(/[^a-z0-9]+/g, '-')}`;
  const created = await page.request.post('/api/servers', { headers, data: { kind: 'container', name: nodeName } });
  expect(created.ok()).toBeTruthy();
  await connectFakeContainer(page, ((await created.json()) as { token: string }).token);
  return { hostname, nodeName };
}

test.describe('innstillinger › servere', () => {
  test('skjerm 11: plasser, grid, tagger, rotasjon og fjerning for server og containernode', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const { hostname, nodeName } = await ownerWithNodes(page, testInfo);
    await page.goto('/settings/servers');
    await expect(page.getByTestId('slots-line')).toHaveText('2 slots in use · 2 free forever · 0 beta');
    const grid = page.locator('gp-data-grid');
    await expect(grid.locator('.ag-row')).toHaveCount(2);
    await expect(grid).toContainText(hostname);
    await expect(grid).toContainText(nodeName);
    await expect(grid).toContainText('container');

    await expectMobileRules(page, testInfo);
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot('servers.png', { fullPage: true, mask: [grid, ...navMasks(page)] });

    // Tagger i rad-dialogen.
    const mobile = isMobileProject(testInfo);
    const serverRow = grid.locator('.ag-row', { hasText: hostname });
    await (mobile ? serverRow.getByRole('button', { name: 'Edit tags' }) : serverRow.locator('[data-action="tags"]')).click();
    const tags = page.getByRole('dialog', { name: `Edit tags · ${hostname}` });
    await tags.locator('.tag.add').click();
    await tags.locator('.tag-input').fill('prod');
    await tags.locator('.tag-input').press('Enter');
    await tags.getByRole('button', { name: 'Save' }).click();
    await expect(tags).toHaveCount(0);
    await expect(serverRow).toContainText('prod');

    // Rotasjon: serveren gir toast, containernoden viser tokenet én gang.
    await (mobile ? serverRow.getByRole('button', { name: 'Rotate key' }) : serverRow.locator('[data-action="rotate"]')).click();
    const rotate = page.getByRole('dialog', { name: `Rotate key · ${hostname}` });
    await expect(rotate).toContainText('old one stops working in 10 minutes');
    await rotate.getByRole('button', { name: 'Rotate key' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'New key created' }).first()).toBeVisible();
    const nodeRow = grid.locator('.ag-row', { hasText: nodeName });
    await (mobile ? nodeRow.getByRole('button', { name: 'Rotate key' }) : nodeRow.locator('[data-action="rotate"]')).click();
    const rotateNode = page.getByRole('dialog', { name: `Rotate key · ${nodeName}` });
    await rotateNode.getByRole('button', { name: 'Rotate key' }).click();
    await expect(rotateNode.getByTestId('rotated-token')).toHaveText(/^agt_[A-Za-z0-9_-]{20,}$/);
    await expect(rotateNode).toContainText('old token works for 24 hours');
    await rotateNode.getByRole('button', { name: 'Done' }).click();

    // Fjern containernoden (hint) og serveren (avinstalleringskommando); plassene frigjøres straks.
    await (mobile ? nodeRow.getByRole('button', { name: 'Remove' }) : nodeRow.locator('[data-action="remove"]')).click();
    const removeNode = page.getByRole('dialog', { name: `Remove · ${nodeName}` });
    await removeNode.getByRole('button', { name: 'Remove' }).click();
    await expect(removeNode.getByTestId('remove-hint')).toHaveText('Remove the sidecar from your compose file');
    await removeNode.getByRole('button', { name: 'Done' }).click();
    await expect(grid.locator('.ag-row')).toHaveCount(1);
    await expect(page.getByTestId('slots-line')).toHaveText('1 slots in use · 2 free forever · 0 beta');

    await (mobile ? serverRow.getByRole('button', { name: 'Remove' }) : serverRow.locator('[data-action="remove"]')).click();
    const removeServer = page.getByRole('dialog', { name: `Remove · ${hostname}` });
    await removeServer.getByRole('button', { name: 'Remove' }).click();
    await expect(removeServer.getByTestId('uninstall-command')).toHaveText('sudo /usr/local/bin/glimt-agent uninstall');
    await removeServer.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByTestId('no-owned')).toBeVisible();
    expect(errors, 'sidefeil').toEqual([]);
  });
});
