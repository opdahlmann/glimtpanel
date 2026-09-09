// Komponentsiden /dev/components (IMPLEMENTERINGSPLAN steg 3.5): skjermbilde i alle tre prosjekter, mobilsjekklisten, ingen konsollfeil.
import { test, expect } from '@playwright/test';
import { expectMobileRules } from '../helpers/mobile-rules';

test.describe('felleskomponenter', () => {
  test('/dev/components ser ut som designet og følger mobilsjekklisten', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/dev/components');
    await expect(page.getByRole('heading', { name: 'Components' })).toBeVisible();
    await expect(page.locator('gp-data-grid .ag-row').first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(700); // pdIn (250 ms) og width/dasharray-overgangene (600 ms) skal være ferdige

    await expectMobileRules(page, testInfo);
    expect(errors, 'konsollfeil').toEqual([]);

    // Ringen har designets mål og segmentet er en pille.
    const ring = page.locator('gp-ring svg').first();
    await expect(ring).toHaveAttribute('width', '76');
    await expect(ring.locator('circle').first()).toHaveAttribute('r', '32');
    await expect(page.locator('gp-segment [role="radiogroup"]').first()).toBeVisible();

    await expect(page).toHaveScreenshot('components.png', { fullPage: true });
  });

  test('dialog og toast virker', async ({ page }) => {
    await page.goto('/dev/components');
    await page.getByRole('button', { name: 'Open modal' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add server' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await page.getByRole('button', { name: 'Show toast' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Copied to clipboard' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Copied to clipboard' })).toBeHidden({ timeout: 5000 });
  });
});
