// Playwright-oppsett for Glimtpanel. Tre prosjekter: desktop (1440×900), mobil WebKit (iPhone 14) og mobil Chromium (Pixel 7).
// Alle skjermer kjøres i alle tre. baseURL peker på web (ng serve eller bygget web), som proxyer /api og /hub til huben.
import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webPort = Number(process.env.GLIMT_WEB_PORT ?? 4200);
const hubUrl = process.env.GLIMT_HUB_URL ?? 'http://localhost:5080';
const baseURL = process.env.GLIMT_E2E_BASE_URL ?? `http://localhost:${webPort}`;

// Miljø for hub og web når Playwright starter dem selv (CI). Lokalt gjenbrukes kjørende servere fra `npm run dev`.
const hubEnv = {
  ...process.env,
  GLIMT_ENV: process.env.GLIMT_ENV ?? 'e2e',
  GLIMT_HUB_URL: hubUrl,
  GLIMT_MONGO_URI: process.env.GLIMT_MONGO_URI ?? 'mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=200',
  GLIMT_MONGO_DB: process.env.GLIMT_MONGO_DB ?? 'GlimtpanelE2E',
  GLIMT_JWT_SECRET: process.env.GLIMT_JWT_SECRET ?? 'e2e-secret',
  GLIMT_DEV_ENROL_KEY: process.env.GLIMT_DEV_ENROL_KEY ?? 'gp_e2e',
};

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 4 : undefined,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['github']] : [['html', { open: 'never' }], ['list']],
  timeout: 30_000,
  expect: { timeout: 10_000, toHaveScreenshot: { maxDiffPixelRatio: 0.01 } },
  use: { baseURL, trace: 'on-first-retry', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile-webkit', use: { ...devices['iPhone 14'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command: 'dotnet run --project apps/glimt-hub/src/Glimt.Hub',
      url: `${hubUrl}/healthz`,
      cwd: repoRoot,
      reuseExistingServer: true,
      timeout: 120_000,
      env: hubEnv,
    },
    {
      command: `node scripts/web-config.mjs && npm --workspace apps/glimt-web run start -- --port ${webPort}`,
      url: baseURL,
      cwd: repoRoot,
      reuseExistingServer: true,
      timeout: 180_000,
      env: { ...process.env, GLIMT_HUB_INTERNAL_URL: hubUrl },
    },
  ],
});
