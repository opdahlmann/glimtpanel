// Skjermbilder til README (IMPLEMENTERINGSPLAN steg 11.5): oversikten i 1440 og 390 px uten masker, og ett bilde med
// begge side om side i docs/. Kjøres bare med GLIMT_DOCS_SHOTS=1, på desktop-chromium:
//   GLIMT_DOCS_SHOTS=1 npm --workspace e2e test -- screenshots --project desktop-chromium
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gotoOverviewLoggedIn } from '../helpers/auth';
import { forceLang } from '../helpers/e2e-api';

const docs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs');

async function settle(page: Page): Promise<void> {
  await expect(page.locator('gp-server-card')).toHaveCount(16, { timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(2500);
}

test.describe('skjermbilder til README', () => {
  test.skip(({ isMobile }) => process.env.GLIMT_DOCS_SHOTS !== '1' || !!isMobile, 'GLIMT_DOCS_SHOTS=1 på desktop');

  test('oversikten i 1440 og 390 px, og side om side', async ({ page }) => {
    fs.mkdirSync(docs, { recursive: true });
    await forceLang(page, 'en');
    await gotoOverviewLoggedIn(page);
    await settle(page);
    await page.screenshot({ path: path.join(docs, 'overview-1440.png'), clip: { x: 0, y: 0, width: 1440, height: 900 } });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await settle(page);
    await page.screenshot({ path: path.join(docs, 'overview-390.png') });

    // Side om side: begge bildene skalert til samme høyde på mørk bakgrunn.
    const wide = fs.readFileSync(path.join(docs, 'overview-1440.png')).toString('base64');
    const narrow = fs.readFileSync(path.join(docs, 'overview-390.png')).toString('base64');
    await page.setViewportSize({ width: 1600, height: 720 });
    await page.setContent(`<body style="margin:0;background:#0f1013;display:flex;gap:24px;padding:24px;align-items:flex-start">
      <img src="data:image/png;base64,${wide}" style="height:672px;border-radius:12px;box-shadow:0 8px 40px #0008">
      <img src="data:image/png;base64,${narrow}" style="height:672px;border-radius:12px;box-shadow:0 8px 40px #0008"></body>`);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(docs, 'overview.png'), fullPage: true });
    expect(fs.statSync(path.join(docs, 'overview.png')).size).toBeGreaterThan(50_000);
  });
});
