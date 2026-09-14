// Serversiden (IMPLEMENTERINGSPLAN fase 5, steg 5.14): skjerm 5 (web-02 med alle paneler, åpne/lukk, panelnav,
// pekemerke på kurven) og skjerm 16 (nordic-db nede) i alle tre prosjektene, med skjermbilder per panel og
// mobilsjekklisten. Levende tall maskeres.
import { test, expect, type Locator, type Page } from '@playwright/test';
import { loginViaApi } from '../helpers/auth';
import { forceLang } from '../helpers/e2e-api';
import { expectMobileRules, isMobileProject, navMasks } from '../helpers/mobile-rules';

const PANELS = ['cpu', 'mem', 'disk', 'net', 'proc', 'cont', 'svc', 'maint', 'sec', 'logs'];

/**
 * Alt som lever: tall, chips, kurver, stolper, grid-rader og logglinjer. Maskene er blokkelementer med fast bredde;
 * en maske på en inline-tekst ville fått ny bredde når tallet bytter sifre og gitt pikselavvik.
 */
function liveMasks(page: Page): Locator[] {
  return [
    page.locator('gp-panel .head'),
    page.locator('header .uptime'),
    page.locator('gp-chip'),
    page.locator('gp-chart .title'),
    page.locator('gp-chart .plot'),
    page.locator('gp-chart .ticks'),
    page.locator('gp-sparkline'),
    page.locator('gp-cpu-panel .core'),
    page.locator('gp-bar'),
    page.locator('gp-mem-panel .legend'),
    page.locator('gp-disk-panel gp-row'),
    page.locator('gp-net-panel gp-row'),
    // Containerne sorteres på levende CPU: hele listen maskeres som én blokk (rekkefølgen og dermed radhøydene varierer).
    page.locator('gp-cont-panel .rows'),
    page.locator('gp-data-grid .ag-row'),
    page.locator('gp-log-view'),
    page.locator('gp-sec-panel .attempt'),
    page.locator('gp-sec-panel .user'),
    ...navMasks(page),
  ];
}

async function freezeLogHeight(page: Page): Promise<void> {
  await page.addStyleTag({ content: 'gp-log-view .box { height: 200px; overflow: hidden; }' });
  // Sticky topplinje, panelnav og bunnlinje tegnes der siden står: alltid fra toppen i full-side-bildene.
  await page.evaluate(() => window.scrollTo(0, 0));
}

/** Panelbilder: samme rulleposisjon hver gang (panelnav er sticky og ville ellers overlappe ulikt). */
async function scrollPanelIntoPlace(panel: Locator): Promise<void> {
  await panel.evaluate((el) => {
    el.scrollIntoView({ block: 'start' });
    window.scrollBy(0, -140);
  });
  await panel.page().waitForTimeout(150);
}

async function gotoServer(page: Page, id: string): Promise<void> {
  await forceLang(page, 'en');
  await loginViaApi(page);
  await page.goto(`/servers/${id}`);
  await expect(page.locator('h1')).toHaveText(id.replace(/^demo-/, ''));
}

test.describe('serversiden', () => {
  test('skjerm 5: web-02 med topp, panelnav og ti paneler med ekte tall', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await gotoServer(page, 'demo-web-02');

    // Toppen.
    await expect(page.getByTestId('status')).toHaveText('live');
    await expect(page.locator('header gp-badge').first()).toHaveText('prod');
    await expect(page.getByTestId('info')).toHaveText(/^Ubuntu 24\.04 · .+ · 4 cores · 8 GB$/);
    await expect(page.getByTestId('uptime')).toHaveText(/^up \d+d \d+h · last boot /);
    await expect(page.locator('header gp-badge', { hasText: /^Supported until/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Alert settings' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Text mode' })).toHaveCount(0);

    // Panelnav og paneler i riktig rekkefølge.
    await expect(page.locator('gp-panel-nav .pill')).toHaveText(['CPU', 'Memory', 'Disk', 'Network', 'Processes', 'Containers', 'Services', 'Maintenance', 'Security', 'Logs']);
    await expect(page.locator('gp-panel')).toHaveCount(10);
    for (const key of PANELS) await expect(page.locator(`#panel-${key} .body`)).toBeVisible();

    // CPU: hode, fire kjerner, seks chips, kurve med 1 h / 24 h.
    await expect(page.locator('#panel-cpu .meta')).toHaveText(/^\d+% · \d\.\d of 4 cores$/);
    await expect(page.locator('gp-cpu-panel .core')).toHaveCount(4);
    await expect(page.locator('gp-cpu-panel gp-chip .label')).toHaveText(['Load 1m', 'Load 5m', 'Load 15m', 'user', 'system', 'iowait']);
    await expect(page.locator('#panel-cpu gp-chart [role="radiogroup"] button')).toHaveText(['1 h', '24 h']);

    // Minne: hode og legende.
    await expect(page.locator('#panel-mem .meta')).toHaveText(/^\d+% · \d\.\d of 8 GB · Swap \d\.\d GB$/);
    await expect(page.locator('gp-mem-panel .lname')).toHaveText(['used', 'Buffers & cache', 'free', 'Swap']);

    // Disk: én montering på web-02, 92 % på /.
    await expect(page.locator('#panel-disk .meta')).toHaveText('1 mounted');
    const root = page.locator('gp-disk-panel [data-mount="/"]');
    await expect(root.locator('gp-badge')).toHaveText('ext4');
    await expect(root.locator('.line span').nth(1)).toHaveText('92%');
    await expect(root.locator('.line span').first()).toHaveText(/^\d+ GB used of 80 GB$/);
    await expect(root.locator('.io')).toHaveText(/^read \d+\.\d · write \d+\.\d MB\/s$/);

    // Nettverk: eth0 med IP-badge og sparkline.
    await expect(page.locator('#panel-net .meta')).toHaveText(/^↓\d+\.\d ↑\d+\.\d MB\/s$/);
    const eth0 = page.locator('gp-net-panel [data-iface="eth0"]');
    await expect(eth0.locator('gp-badge')).toHaveText(/^10\.0\.\d+\.12$/);
    await expect(eth0.locator('gp-sparkline')).toBeVisible();

    // Prosesser: tabell med rader, kommandolinje ved klikk.
    await expect(page.locator('#panel-proc .meta')).toHaveText(/^\d+ total · \d+ waiting$/);
    const rows = page.locator('gp-proc-panel .ag-row:not(.ag-full-width-row)');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThan(5);

    // Containere: seks på web-02, alle running.
    await expect(page.locator('#panel-cont .meta')).toHaveText('6 running · 0 stopped/restarting');
    await expect(page.locator('gp-cont-panel gp-row')).toHaveCount(6);
    await expect(page.locator('gp-cont-panel [data-container="web-web"] gp-badge')).toHaveText('nginx:1.27');
    await expect(page.locator('gp-cont-panel [data-container="web-web"] .sub')).toHaveText(/^running · /);

    // Tjenester, vedlikehold, sikkerhet.
    await expect(page.locator('#panel-svc .meta')).toHaveText('0 failed · 7 running');
    await expect(page.locator('gp-svc-panel [data-service="postgresql.service"] .status')).toHaveText('stopped');
    await expect(page.locator('gp-maint-panel gp-chip .label')).toHaveText(['Reboot required', 'Pending updates', 'Security']);
    await expect(page.locator('gp-maint-panel gp-chip .value').first()).toHaveText('No');
    await expect(page.locator('gp-maint-panel gp-badge')).toHaveText(/^Supported until/);
    await expect(page.locator('#panel-sec .meta')).toHaveText('Listening ports · Logged in now · SSH · Firewall');
    const ports = page.locator('gp-sec-panel gp-data-grid .ag-row');
    await expect(ports.first()).toBeVisible();
    await expect(ports).toHaveCount(5);
    await expect(page.locator('gp-sec-panel .user').first()).toHaveText(/^ole · 10\.0\.0\.12 · pts\/0 · \d\d:\d\d$/);
    await expect(page.locator('gp-sec-panel gp-chip .label')).toHaveText(['last hour', 'last 24 h', 'ufw', 'fail2ban']);

    // Logger: journal-strømmen leverer linjer.
    await expect(page.locator('#panel-logs .meta')).toHaveText('journald · streaming · nothing is stored');
    await expect(page.locator('gp-logs-panel gp-log-view .line').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Open full log view' })).toBeVisible();

    await expectMobileRules(page, testInfo);
    expect(errors, 'sidefeil').toEqual([]);

    await page.evaluate(() => document.fonts.ready);
    await freezeLogHeight(page);
    await page.waitForTimeout(800);
    await expect(page).toHaveScreenshot('server.png', { fullPage: true, mask: liveMasks(page) });
    // Panelbildene: uten sticky topplinje, panelnav og bunnlinje, som ellers tegnes midt i et panel høyere enn skjermen.
    await page.addStyleTag({ content: 'gp-topbar, gp-panel-nav, gp-bottom-nav { visibility: hidden; }' });
    for (const key of PANELS) {
      const panel = page.locator(`#panel-${key}`);
      await scrollPanelIntoPlace(panel);
      await expect(panel).toHaveScreenshot(`panel-${key}.png`, { mask: liveMasks(page) });
    }
  });

  test('paneler kan lukkes og huskes, panelnav åpner og ruller, kurven bytter til 24 h og har pekemerke', async ({ page }, testInfo) => {
    await gotoServer(page, 'demo-web-02');
    await expect(page.locator('#panel-disk .body')).toBeVisible();
    await page.locator('#panel-disk .head').click();
    await expect(page.locator('#panel-disk .body')).toHaveCount(0);
    await expect(page.locator('#panel-disk .head')).toHaveAttribute('aria-expanded', 'false');
    await page.reload();
    await expect(page.locator('h1')).toHaveText('web-02');
    await expect(page.locator('#panel-disk .head')).toHaveAttribute('aria-expanded', 'false');

    // Panelnav åpner det lukkede panelet og ruller til det (70 px under toppen).
    await page.locator('gp-panel-nav .pill', { hasText: 'Disk' }).click();
    await expect(page.locator('#panel-disk .body')).toBeVisible();
    await expect.poll(async () => Math.round((await page.locator('#panel-disk').boundingBox())?.y ?? -1), { timeout: 5000 }).toBeLessThanOrEqual(isMobileProject(testInfo) ? 120 : 80);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

    // Kurven: 24 h henter historikk; pekemerke ved mus/finger.
    const cpuChart = page.locator('#panel-cpu gp-chart');
    await cpuChart.scrollIntoViewIfNeeded();
    const history = page.waitForResponse((r) => r.url().includes('/history?metric=cpu&range=24h'));
    await cpuChart.locator('[role="radiogroup"] button', { hasText: '24 h' }).click();
    expect((await history).ok()).toBeTruthy();
    const plot = cpuChart.locator('.plot');
    const box = await plot.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
      await page.mouse.down();
      await expect(cpuChart.locator('.chip')).toHaveText(/^\d+%\s?\d\d:\d\d$/);
      await page.mouse.up();
    }
  });

  test('prosesser: sortering, filter, utvidet kommandolinje; stablet på mobil', async ({ page }, testInfo) => {
    await gotoServer(page, 'demo-web-02');
    const panel = page.locator('gp-proc-panel');
    await panel.scrollIntoViewIfNeeded();
    const rows = panel.locator('.ag-row:not(.ag-full-width-row)');
    await expect(rows.first()).toBeVisible();
    const mobile = isMobileProject(testInfo);
    if (mobile) {
      await expect(panel.locator('gp-data-grid')).toHaveClass(/mobile/);
      await expect(rows.first().locator('gp-chip')).toHaveCount(3);
    } else {
      await expect(panel.locator('.ag-header-cell-text')).toHaveText(['Process', 'CPU', 'Memory', 'Time']);
    }
    // Sortert synkende på valgt kolonne: CPU først, så minne (MB/GB → MB). Leses i ett jafs (tallene lever), og
    // sorteres på row-index: AG Grid tegner radene med absolutt posisjon, så DOM-rekkefølgen sier ingenting.
    const column = (col: 'cpu' | 'mem'): Promise<number[]> =>
      page.evaluate(
        ({ col, mobile }) => {
          const rows = Array.from(document.querySelectorAll<HTMLElement>('gp-proc-panel .ag-row:not(.ag-full-width-row)'));
          return rows
            .map((row) => {
              const cell = mobile ? row.querySelectorAll('gp-chip .value')[col === 'cpu' ? 0 : 1] : row.querySelector(`.ag-cell[col-id="${col}"]`);
              const t = cell?.textContent ?? '';
              return { index: Number(row.getAttribute('row-index')), value: t.includes('GB') ? parseFloat(t) * 1024 : parseFloat(t) };
            })
            .sort((a, b) => a.index - b.index)
            .map((r) => r.value);
        },
        { col, mobile },
      );
    const descending = (v: number[]) => v.every((x, i) => i === 0 || v[i - 1] >= x);
    await expect.poll(() => column('cpu').then(descending)).toBe(true);
    await panel.locator('[role="radiogroup"] button', { hasText: 'By memory' }).click();
    await expect.poll(() => column('mem').then(descending)).toBe(true);
    expect((await column('mem'))[0]).toBeGreaterThanOrEqual(1400);

    await panel.locator('gp-input input').fill('sshd');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('sshd');
    await rows.first().click();
    await expect(panel.locator('.ag-full-width-row code')).toHaveText(/sshd/);
    await rows.first().click();
    await expect(panel.locator('.ag-full-width-row')).toHaveCount(0);
    await panel.locator('gp-input input').fill('');
    await expectMobileRules(page, testInfo);
  });

  test('skjerm 16: nordic-db er nede med «last seen», nedtonede tall og utilgjengelige prosesser og logger', async ({ page }, testInfo) => {
    await gotoServer(page, 'demo-nordic-db');
    await expect(page.getByTestId('status')).toHaveText(/^last seen /);
    await expect(page.locator('gp-server-page')).toHaveAttribute('data-status', 'down');
    await expect(page.getByTestId('uptime')).toHaveText(/^last boot /);
    await expect(page.locator('#panel-cpu .meta')).toHaveText(/^0%/);
    await expect(page.locator('gp-cpu-panel')).toHaveClass(/dim/);
    await expect(page.locator('gp-proc-panel')).toHaveText('Not available while the server is down');
    await expect(page.locator('gp-logs-panel')).toHaveText('Not available while the server is down');
    await expect(page.locator('gp-panel')).toHaveCount(10);
    await expectMobileRules(page, testInfo);
    await page.evaluate(() => document.fonts.ready);
    await freezeLogHeight(page);
    await page.waitForTimeout(800);
    await expect(page).toHaveScreenshot('server-down.png', { fullPage: true, mask: liveMasks(page) });
  });

  test('ringen på kortet åpner serversiden med #mem og ruller til minnepanelet', async ({ page }) => {
    await forceLang(page, 'en');
    await loginViaApi(page);
    await page.goto('/');
    const card = page.locator('gp-server-card[aria-label^="web-02:"]');
    await card.scrollIntoViewIfNeeded();
    await card.locator('gp-ring').nth(1).locator('button').click();
    await expect(page).toHaveURL(/\/servers\/demo-web-02#mem$/);
    await expect(page.locator('h1')).toHaveText('web-02');
    await expect(page.locator('#panel-mem .body')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 5000 }).toBeGreaterThan(0);
  });
});
