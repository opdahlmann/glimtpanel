import { test, expect } from '@playwright/test';
import { expectMobileRules } from '../helpers/mobile-rules';

const hubUrl = process.env.GLIMT_HUB_URL ?? 'http://localhost:5080';

test.describe('gående skjelett', () => {
  test('forsiden laster og viser Glimtpanel', async ({ page }, testInfo) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /glimtpanel/i }).first()).toBeVisible();
    await expectMobileRules(page, testInfo);
  });

  test('huben svarer på /healthz', async ({ request }) => {
    const res = await request.get(`${hubUrl}/healthz`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe('ok');
  });
});
