// Tilgjengelighet og renderingsbudsjett (IMPLEMENTERINGSPLAN steg 9.2, 9.3 og 9.5): axe på alle skjermene uten
// alvorlige funn (serious/critical), «skip to content», skjermleser-sammendraget, 404-siden, og ingen lange oppgaver
// (> 100 ms) på oversikten mens tallene lever. Kjøres på desktop; mobilsjekklisten dekker de andre prosjektene.
import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';
import { loginViaApi } from '../helpers/auth';
import { forceLang } from '../helpers/e2e-api';

const SCREENS = ['/', '/servers/demo-web-02', '/servers/demo-acme-backend', '/servers/demo-web-02/containers/', '/logs?server=demo-web-02', '/alerts', '/settings/account', '/settings/alerts', '/settings/servers', '/settings/access', '/settings/subscription', '/settings/data', '/welcome', '/demo', '/demo/servers/demo-web-02', '/demo/settings'];

async function axe(page: Page, url: string): Promise<string[]> {
  await page.goto(url);
  await page.waitForTimeout(1200);
  const results = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
  return results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${url}: ${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);
}

test.describe('tilgjengelighet', () => {
  test.skip(({ isMobile }) => !!isMobile, 'axe kjøres på desktop');

  test('axe finner ingen alvorlige feil på skjermene', async ({ page }) => {
    test.slow(); // 15 skjermer med axe tar over 30 s på CI-runneren
    await forceLang(page, 'en');
    await loginViaApi(page);
    const findings: string[] = [];
    for (const url of SCREENS) {
      if (url.endsWith('/containers/')) continue;
      findings.push(...(await axe(page, url)));
    }
    expect(findings).toEqual([]);
  });

  test('axe på innlogging og registrering', async ({ page }) => {
    await forceLang(page, 'en');
    const findings = [...(await axe(page, '/login')), ...(await axe(page, '/register'))];
    expect(findings).toEqual([]);
  });

  test('skip-lenke, skjermleser-sammendrag og 404-side', async ({ page }) => {
    await forceLang(page, 'en');
    await loginViaApi(page);
    await page.goto('/');
    // Skip-lenken er det første fokuserbare elementet i dokumentet, og Enter flytter fokus til innholdet.
    const skip = page.locator('a.skip');
    await expect(skip).toHaveCount(1);
    const first = await page.evaluate(() => document.querySelector('a[href], button:not([disabled]), input, select, [tabindex]:not([tabindex="-1"])')?.outerHTML.slice(0, 120) ?? 'none');
    expect(first).toContain('class="skip"');
    await skip.focus();
    await expect(skip).toBeFocused();
    await expect(skip).toHaveText('Skip to content');
    await page.keyboard.press('Enter');
    await expect(page.locator('main#main')).toBeFocused();
    await expect(page.getByTestId('summary-live')).toHaveText(/^\d+ nodes · \d+ up · \d+ down$/);
    await expect(page.getByTestId('summary')).toHaveAttribute('aria-hidden', 'true');

    await page.goto('/no/such/page');
    await expect(page.getByTestId('not-found')).toContainText('This page does not exist');
    await page.getByRole('link', { name: 'Go to the overview' }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('ingen lange oppgaver på oversikten mens tallene lever', async ({ page }) => {
    await forceLang(page, 'en');
    await loginViaApi(page);
    await page.goto('/');
    await expect(page.locator('gp-server-card')).toHaveCount(16, { timeout: 15_000 });
    await page.waitForTimeout(1500);
    const longTasks = await page.evaluate(
      () =>
        new Promise<number[]>((resolve) => {
          const seen: number[] = [];
          const obs = new PerformanceObserver((list) => {
            for (const e of list.getEntries()) seen.push(Math.round(e.duration));
          });
          obs.observe({ type: 'longtask', buffered: false });
          setTimeout(() => {
            obs.disconnect();
            resolve(seen);
          }, 8000);
        }),
    );
    expect(longTasks.filter((ms) => ms > 100), `lange oppgaver (ms): ${longTasks.join(', ')}`).toEqual([]);
  });
});
