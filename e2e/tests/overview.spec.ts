// Oversikten (IMPLEMENTERINGSPLAN fase 4, steg 4.5; fase 12, steg 12.8): skjerm 4 (oversikten med de 16 demoserverne),
// 16 (server nede), 18 (leser), 19 (norsk) og 20 (containernoder) i alle tre prosjektene, med skjermbilder og mobilsjekklisten. Levende tall (ringer, chips,
// sparklines og klokken i sammendraget) maskeres i skjermbildene.
import { test, expect, type Page } from '@playwright/test';
import { gotoOverviewLoggedIn, loginViaApi } from '../helpers/auth';
import { ensureReader, forceLang } from '../helpers/e2e-api';
import { expectMobileRules, isMobileProject, navMasks } from '../helpers/mobile-rules';

const DEMO_NAMES = ['web-01', 'web-02', 'api-prod', 'db-prod', 'worker-01', 'cache-01', 'staging-web', 'staging-db', 'acme-app', 'acme-db', 'nordic-shop', 'nordic-db', 'nas', 'pi-hole', 'media', 'backup'];

function liveMasks(page: Page) {
  return [page.locator('gp-ring'), page.locator('gp-chip'), page.locator('gp-sparkline'), page.getByTestId('summary'), page.locator('gp-server-card .info'), page.locator('gp-container-card .info'), page.locator('gp-container-card .status'), ...navMasks(page)];
}

/** Alle 16 demoserverne står i oversikten (første Card kommer rett etter SubscribeOverview). */
async function waitForCards(page: Page): Promise<void> {
  for (const name of DEMO_NAMES) await expect(page.locator(`gp-server-card[aria-label^="${name}:"]`)).toBeVisible({ timeout: 15_000 });
}

test.describe('oversikten', () => {
  test('skjerm 4: sammendrag, verktøylinje, chips og 16 kort med levende tall', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await forceLang(page, 'en');
    await gotoOverviewLoggedIn(page);
    await waitForCards(page);

    // Fase 12: demoen har tre containernoder, så tittelen sier «Nodes» og sammendraget teller begge typer.
    await expect(page.getByRole('heading', { name: 'Nodes' })).toBeVisible();
    await expect(page.getByTestId('summary')).toHaveText(/^19 nodes · 16 servers · 3 containers · \d+ up · 1 down · \d sleeping · \d+ paused · live · \d\d:\d\d:\d\d$/);
    await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeVisible();
    await expect(page.getByPlaceholder('Search servers…')).toBeVisible();
    await expect(page.locator('gp-select select')).toHaveValue('name');
    await expect(page.locator('main gp-segment [role="radio"]')).toHaveText(['Cards', 'Groups']); // fase 13: visningssegmentet
    const chips = page.locator('.chip');
    await expect(chips).toHaveText(['All', 'client-a', 'client-b', 'edge', 'homelab', 'prod', 'staging', 'up', 'down', 'paused', 'sleeping', 'Servers', 'Containers', 'Has alert']);

    // Kortet: tagger, navn, status, tre ringer, fem chips, to sparklines. Tallene lever (ringen endrer seg innen få sekunder).
    const web02 = page.locator('gp-server-card[aria-label^="web-02:"]');
    await expect(web02.locator('gp-badge')).toHaveText('prod');
    await expect(web02.locator('.status')).toHaveText('live');
    await expect(web02.locator('.info')).toHaveText(/^Ubuntu 24\.04 · 4 cores · 8 GB · up \d+d \d+h$/);
    await expect(web02.locator('gp-ring')).toHaveCount(3);
    await expect(web02.locator('gp-chip')).toHaveCount(5);
    await expect(web02.locator('gp-chip .label').first()).toHaveText('Net MB/s');
    await expect(web02.locator('gp-sparkline')).toHaveCount(2);
    await expect(web02.locator('gp-ring').nth(2).locator('.val')).toHaveText('92%');
    // Kort utenfor skjermen fryses med vilje (IntersectionObserver); rull kortet inn før vi ser etter liv.
    await web02.scrollIntoViewIfNeeded();
    const cpuBefore = await web02.locator('gp-ring').first().locator('.val').textContent();
    await expect
      .poll(async () => web02.locator('gp-ring').first().locator('.val').textContent(), { timeout: 10_000, message: 'CPU-ringen skal leve' })
      .not.toBe(cpuBefore);

    // Skjerm 16: nordic-db er nede siden 03:12 (rød prikk, «last seen», ringer på 0).
    const nordic = page.locator('gp-server-card[aria-label^="nordic-db:"]');
    await expect(nordic).toHaveAttribute('data-status', 'down');
    await expect(nordic.locator('.status')).toHaveText(/^last seen /);
    await expect(nordic.locator('gp-ring .val')).toHaveText(['0%', '0%', '0%']);
    await expect(nordic.locator('gp-chip .value').first()).toHaveText('—');

    // Vedlikeholdschips: omstart på db-prod, feilet tjeneste på worker-01, stoppede containere på web-01.
    await expect(page.locator('gp-server-card[aria-label^="db-prod:"] gp-chip').nth(3).locator('.value')).toHaveText('required');
    await expect(page.locator('gp-server-card[aria-label^="worker-01:"] gp-chip').nth(4).locator('.value')).toHaveText('1 failed');
    await expect(page.locator('gp-server-card[aria-label^="web-01:"] gp-chip').nth(1).locator('.value')).toHaveText('7 / 8');

    await expectMobileRules(page, testInfo);
    expect(errors, 'sidefeil').toEqual([]);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(700);
    await expect(page).toHaveScreenshot('overview.png', { fullPage: true, mask: liveMasks(page) });
    // Ett kort per tilstand i begge bredder (steg 4.2). Pauset finnes ikke i demodataene ennå (pause er Neste).
    await expect(web02).toHaveScreenshot('card-up.png', { mask: [web02.locator('gp-ring'), web02.locator('gp-chip'), web02.locator('gp-sparkline'), web02.locator('.info'), web02.locator('.stripe')] });
    await expect(nordic).toHaveScreenshot('card-down.png', { mask: [nordic.locator('.status')] });
  });

  test('filter, sortering og søk virker, og valget huskes over omlasting', async ({ page }) => {
    await forceLang(page, 'en');
    await gotoOverviewLoggedIn(page);
    await waitForCards(page);
    const cards = page.locator('gp-server-card');
    const chip = (name: string) => page.locator('.chip', { hasText: new RegExp(`^${name}$`) });

    await chip('homelab').click();
    await expect(cards).toHaveCount(4);
    await expect(chip('homelab')).toHaveAttribute('aria-pressed', 'true');
    await chip('down').click();
    await expect(cards).toHaveCount(0);
    await expect(page.getByText('No servers match the filter')).toBeVisible();
    await chip('All').click();
    await chip('down').click();
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toHaveAttribute('aria-label', /^nordic-db:/);
    await chip('All').click();
    await chip('Has alert').click();
    // Fase 7: web-02 (disk 92 %) og nordic-db (nede) har aktive varsler fra første øyeblikksbilde.
    await expect(page.locator('gp-server-card[aria-label^="web-02:"]')).toBeVisible();
    await expect(page.locator('gp-server-card[aria-label^="nordic-db:"]')).toBeVisible();
    await expect(page.locator('gp-server-card[aria-label^="cache-01:"]')).toHaveCount(0);
    await chip('All').click();

    await page.locator('gp-select select').selectOption('cpu');
    await expect(cards.first()).toHaveAttribute('aria-label', /^api-prod:/);
    await page.locator('gp-select select').selectOption('status');
    await expect(cards.first()).toHaveAttribute('aria-label', /^nordic-db:/);

    await page.getByPlaceholder('Search servers…').fill('nordic');
    await expect(cards).toHaveCount(2);
    await page.getByPlaceholder('Search servers…').fill('client-a');
    await expect(cards).toHaveCount(2);
    await expect(cards.first()).toHaveAttribute('aria-label', /^acme-app:/);
    await page.getByPlaceholder('Search servers…').fill('');

    await chip('prod').click();
    await page.reload();
    await expect(page.locator('gp-select select')).toHaveValue('status');
    await expect(chip('prod')).toHaveAttribute('aria-pressed', 'true');
    await expect(cards).toHaveCount(6);
  });

  test('tastatur: «/» fokuserer søket, piltaster går mellom kort, Enter åpner serveren', async ({ page }, testInfo) => {
    test.skip(isMobileProject(testInfo), 'tastaturnavigasjon testes på desktop');
    await forceLang(page, 'en');
    await gotoOverviewLoggedIn(page);
    await waitForCards(page);
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('/');
    await expect(page.getByPlaceholder('Search servers…')).toBeFocused();
    await page.keyboard.press('Escape');
    // Piltastene går over begge korttypene (acme-backend er et containerkort rett etter acme-app).
    const anyCard = page.locator('gp-server-card, gp-container-card');
    await anyCard.first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(anyCard.nth(1)).toBeFocused();
    await page.keyboard.press('End');
    await expect(anyCard.last()).toBeFocused();
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/servers\/demo-acme-app$/);
  });

  test('ringen åpner serversiden med panelet som fragment', async ({ page }) => {
    await forceLang(page, 'en');
    await gotoOverviewLoggedIn(page);
    await waitForCards(page);
    await page.locator('gp-server-card[aria-label^="web-02:"] gp-ring').nth(1).locator('button').click();
    await expect(page).toHaveURL(/\/servers\/demo-web-02#mem$/);
  });

  test('skjerm 18: leseren ser serverne uten «Add server» og med rollen Reader', async ({ page }, testInfo) => {
    const reader = await ensureReader(page);
    await forceLang(page, 'en');
    await loginViaApi(page, reader);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Nodes' })).toBeVisible();
    await waitForCards(page);
    await expect(page.getByRole('button', { name: 'Add', exact: true })).toHaveCount(0);
    if (!isMobileProject(testInfo)) {
      await expect(page.locator('gp-sidebar .role')).toHaveText('Reader');
    }
    await expectMobileRules(page, testInfo);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(700);
    await expect(page).toHaveScreenshot('overview-reader.png', { fullPage: true, mask: liveMasks(page) });
  });

  test('skjerm 19: norsk bytter alle tekstene i oversikten', async ({ page }, testInfo) => {
    await forceLang(page, 'no');
    await gotoOverviewLoggedIn(page);
    await expect(page.getByRole('heading', { name: 'Noder' })).toBeVisible();
    await waitForCards(page);
    await expect(page.getByTestId('summary')).toHaveText(/^19 noder · 16 servere · 3 containere · \d+ oppe · 1 nede · \d sover · \d+ pauset · live · \d\d:\d\d:\d\d$/);
    await expect(page.getByRole('button', { name: 'Legg til' })).toBeVisible();
    await expect(page.getByPlaceholder('Søk i servere…')).toBeVisible();
    await expect(page.locator('.chip')).toHaveText(['Alle', 'client-a', 'client-b', 'edge', 'homelab', 'prod', 'staging', 'oppe', 'nede', 'pauset', 'sover', 'Servere', 'Containere', 'Har varsel']);
    const web02 = page.locator('gp-server-card[aria-label^="web-02:"]');
    await expect(web02.locator('gp-ring .label')).toHaveText(['Prosessor', 'Minne', 'Disk']);
    await expect(web02.locator('gp-chip .label')).toHaveText(['Nett MB/s', 'Containere', 'Oppdat.', 'Omstart', 'Tjenester']);
    await expect(web02.locator('.info')).toHaveText(/kjerner .* oppe /);
    await expect(page.locator('gp-server-card[aria-label^="nordic-db:"] .status')).toHaveText(/^sist sett /);
    await expectMobileRules(page, testInfo);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(700);
    await expect(page).toHaveScreenshot('overview-no.png', { fullPage: true, mask: liveMasks(page) });
  });
});

test.describe('containernoder i oversikten (fase 12)', () => {
  test('skjerm 20: tre containerkort med image, ringer, chips og typefilter', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await forceLang(page, 'en');
    await gotoOverviewLoggedIn(page);
    await waitForCards(page);
    const nodes = page.locator('gp-container-card');
    await expect(nodes).toHaveCount(3);

    // acme-backend er lenket til web-02 (12.6): «on web-02», helse ok, to ringer, fire chips, to sparklines.
    const backend = page.locator('gp-container-card[aria-label^="acme-backend:"]');
    await expect(backend).toHaveAttribute('data-kind', 'container');
    await expect(backend.locator('.info')).toHaveText(/^container · ghcr\.io\/acme\/backend:2\.4\.1 · up \d+d \d+h · on web-02$/);
    await expect(backend.locator('gp-ring')).toHaveCount(2);
    await expect(backend.locator('gp-ring').first().locator('.sub')).toHaveText(/of 2 cores$/);
    await expect(backend.locator('gp-ring').nth(1).locator('.sub')).toHaveText(/of 1 GB$/);
    await expect(backend.locator('gp-chip .label')).toHaveText(['Net MB/s', 'restarts', 'health', 'Listening ports']);
    await expect(backend.locator('gp-chip').nth(2).locator('.value')).toHaveText('ok');
    await expect(backend.locator('gp-sparkline')).toHaveCount(2);
    await expect(backend.locator('gp-badge')).toHaveText(['prod', 'client-a']);

    // acme-frontend har ingen grense; edge-worker mangler cgroup (≈) og sover 02–06.
    const frontend = page.locator('gp-container-card[aria-label^="acme-frontend:"]');
    await expect(frontend.locator('gp-ring').nth(1).locator('.sub')).toHaveText(/no limit$/);
    const edge = page.locator('gp-container-card[aria-label^="edge-worker:"]');
    await expect(edge.locator('.info')).toHaveAttribute('title', 'Summed over visible processes: no readable cgroup on this platform');
    await expect(edge.locator('.status')).toHaveText(/^(live|sleeping since .+)$/);

    // Typefilteret: bare containere, så bare servere.
    const chip = (name: string) => page.locator('.chip', { hasText: new RegExp(`^${name}$`) });
    await chip('Containers').click();
    await expect(page.locator('gp-server-card')).toHaveCount(0);
    await expect(nodes).toHaveCount(3);
    await chip('Servers').click();
    await expect(nodes).toHaveCount(0);
    await expect(page.locator('gp-server-card')).toHaveCount(16);
    await chip('All').click();

    // «+ Add» har menyen Server / Container.
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Server' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Container' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('add-menu')).toHaveCount(0);

    await expectMobileRules(page, testInfo);
    expect(errors, 'sidefeil').toEqual([]);
    await page.evaluate(() => document.fonts.ready);
    await expect(backend).toHaveScreenshot('card-container.png', { mask: [backend.locator('gp-ring'), backend.locator('gp-chip'), backend.locator('gp-sparkline'), backend.locator('.info'), backend.locator('.stripe')] });
  });
});

test.describe('grupper (fase 13)', () => {
  test('skjerm 23: to demogrupper med summer og medlemmer; ny gruppe fra kortet, nytt navn, vis som kort, slett', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await forceLang(page, 'en');
    await gotoOverviewLoggedIn(page);
    await waitForCards(page);

    // Gruppevisningen: «Acme» (web-02, acme-backend, acme-frontend, db-prod) og «Edge» (edge-worker, worker-01).
    await page.getByRole('radio', { name: 'Groups' }).click();
    const acme = page.locator('gp-group-card[data-group="Acme"]');
    const edge = page.locator('gp-group-card[data-group="Edge"]');
    await expect(acme).toBeVisible();
    await expect(edge).toBeVisible();
    await expect(acme.getByTestId('group-summary')).toHaveText(/^4 nodes · \d up/);
    await expect(acme.locator('gp-chip .label')).toHaveText(['CPU', 'Memory', 'Alerts']);
    await expect(acme.locator('gp-chip').first().locator('.value')).toHaveText(/\d+\.\d of 18 cores$/);
    await expect(acme.locator('gp-chip').nth(1).locator('.value')).toHaveText(/\d+\.\d of 57 GB$/);
    await expect(acme.locator('.member')).toHaveCount(4);
    await expect(acme.locator('.member gp-badge')).toHaveText(['server', 'container', 'container', 'server']);
    await expect(edge.locator('.member')).toHaveCount(2);
    await expect(edge.getByTestId('group-summary')).toHaveText(/^2 nodes · \d up/);
    await expect(page.locator('gp-server-card')).toHaveCount(0);

    await expectMobileRules(page, testInfo);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
    await expect(page).toHaveScreenshot('groups.png', { fullPage: true, mask: [page.locator('gp-chip'), page.locator('.mnum'), page.locator('gp-group-card .summary'), page.getByTestId('summary'), ...navMasks(page)] });

    // Ny gruppe fra et nodekort: ⋯ → New group… → navn → Create. Kortet dukker opp i gruppevisningen med ett medlem.
    const name = `Test ${testInfo.project.name.replace(/[^a-z0-9]+/g, '-')} ${Date.now().toString(36).slice(-4)}`;
    await page.getByRole('radio', { name: 'Cards' }).click();
    await page.locator('gp-server-card[aria-label^="cache-01:"] gp-node-menu button').click();
    const menu = page.getByRole('dialog', { name: 'cache-01' });
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Acme' })).toHaveAttribute('aria-checked', 'false');
    await menu.getByRole('button', { name: 'New group…' }).click();
    await menu.locator('gp-input input').fill(name);
    await menu.getByRole('button', { name: 'Create' }).click();
    await expect(menu.getByRole('menuitemcheckbox', { name })).toHaveAttribute('aria-checked', 'true');
    await menu.getByRole('button', { name: 'Close' }).click();
    await expect(menu).toHaveCount(0);

    await page.getByRole('radio', { name: 'Groups' }).click();
    const mine = page.locator(`gp-group-card[data-group="${name}"]`);
    await expect(mine).toBeVisible();
    await expect(mine.locator('.member')).toHaveText([/cache-01/]);

    // Nytt navn.
    await mine.locator('.more').click();
    const groupMenu = page.getByRole('dialog', { name });
    await groupMenu.getByRole('menuitem', { name: 'Rename' }).click();
    await groupMenu.locator('gp-input input').fill(`${name} renamed`);
    await groupMenu.getByRole('button', { name: 'Save' }).click();
    const renamed = page.locator(`gp-group-card[data-group="${name} renamed"]`);
    await expect(renamed).toBeVisible();

    // «Show as cards»: kortvisningen med chip «Group: … ×» og bare medlemmet.
    await renamed.locator('.more').click();
    await page.getByRole('dialog', { name: `${name} renamed` }).getByRole('menuitem', { name: 'Show as cards' }).click();
    await expect(page).toHaveURL(/[?&]group=/);
    await expect(page.getByTestId('group-chip')).toHaveText(`Group: ${name} renamed ×`);
    await expect(page.locator('gp-server-card, gp-container-card')).toHaveCount(1);
    await page.getByTestId('group-chip').click();
    await expect(page).not.toHaveURL(/[?&]group=/);
    await expect(page.locator('gp-server-card')).toHaveCount(16);

    // Slett (to klikk: Delete group → Confirm).
    await page.getByRole('radio', { name: 'Groups' }).click();
    await renamed.locator('.more').click();
    const del = page.getByRole('dialog', { name: `${name} renamed` }).getByRole('menuitem', { name: /Delete group|Confirm delete/ });
    await del.click();
    await del.click();
    await expect(renamed).toHaveCount(0);
    await expect(acme).toBeVisible();
    expect(errors, 'sidefeil').toEqual([]);
  });
});
