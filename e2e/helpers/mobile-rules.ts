// Mobilsjekklisten fra IMPLEMENTERINGSPLAN 6.8, som kjørbar hjelper. Brukes på hver skjerm i mobilprosjektene.
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';

/** Det som lever i navigasjonen og på kortene etter fase 7: varsel-badgen og kortets varselstripe (varsler utløses etter hvert). */
export function navMasks(page: Page): Locator[] {
  return [page.locator('gp-sidebar .badge'), page.locator('gp-bottom-nav .badge'), page.locator('gp-server-card .stripe')];
}

export function isMobileProject(testInfo: TestInfo): boolean {
  return testInfo.project.name.startsWith('mobile');
}

export async function expectMobileRules(page: Page, testInfo: TestInfo): Promise<void> {
  if (!isMobileProject(testInfo)) return;

  // 1. Ingen horisontal scroll på siden.
  const { scrollWidth, clientWidth } = await page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  });
  expect(scrollWidth, 'siden skal ikke scrolle horisontalt').toBeLessThanOrEqual(clientWidth);

  // 2. Alle synlige klikkbare flater er minst 44×44 px (unntatt elementer merket data-touch-exempt).
  //    Målt avrundet til hele piksler: WebKit rapporterer 43.99 for et 44 px felt.
  const small = await page.evaluate(() => {
    const sel = 'button, a[href], input, select, textarea, [role="button"]';
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      if (el.hasAttribute('data-touch-exempt')) continue;
      const r = el.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      if (visible && (Math.round(r.width) < 44 || Math.round(r.height) < 44)) out.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} ${Math.round(r.width)}×${Math.round(r.height)} "${(el.textContent ?? '').trim().slice(0, 30)}"`);
    }
    return out;
  });
  expect(small, 'klikkbare flater under 44×44 px').toEqual([]);
}
