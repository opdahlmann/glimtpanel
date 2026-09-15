// Playwright-oppsett for Glimtpanel. Tre prosjekter: desktop (1440×900), mobil WebKit (iPhone 14) og mobil Chromium (Pixel 7).
// Alle skjermer kjøres i alle tre. baseURL peker på web (ng serve eller bygget web), som proxyer /api og /hub til huben.
import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV_USER } from './helpers/auth';
import { ensureMongo } from './mongo';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webPort = Number(process.env.GLIMT_WEB_PORT ?? 4200);
const hubUrl = process.env.GLIMT_HUB_URL ?? 'http://localhost:5080';
const baseURL = process.env.GLIMT_E2E_BASE_URL ?? `http://localhost:${webPort}`;

// Innlogging trenger MongoDB (dev-brukeren seedes der). Uten GLIMT_MONGO_URI startes en mongo:8-container med
// tilfeldig port her, ved innlasting av config-filen, slik at huben under får riktig URI (se mongo.ts og README).
const mongoUri = ensureMongo(hubUrl);

// Miljø for hub og web når Playwright starter dem selv (CI). Lokalt gjenbrukes kjørende servere fra `npm run dev`.
// GLIMT_E2E_BUILT=1 (steg 11.1, CI): hub fra `dotnet publish` og bygget web servert av scripts/serve-web.mjs med
// proxy og de samme sikkerhetshodene som nginx, i stedet for `dotnet run` og `ng serve`.
const built = process.env.GLIMT_E2E_BUILT === '1';
const hubEnv = {
  ...process.env,
  GLIMT_ENV: process.env.GLIMT_ENV ?? 'e2e',
  GLIMT_HUB_URL: hubUrl,
  GLIMT_MONGO_URI: mongoUri ?? 'mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=200',
  GLIMT_MONGO_DB: process.env.GLIMT_MONGO_DB ?? 'GlimtpanelE2E',
  GLIMT_JWT_SECRET: process.env.GLIMT_JWT_SECRET ?? 'e2e-secret',
  GLIMT_DEV_ENROL_KEY: process.env.GLIMT_DEV_ENROL_KEY ?? 'gp_e2e',
  GLIMT_DEV_USER_EMAIL: DEV_USER.email,
  GLIMT_DEV_USER_PASSWORD: DEV_USER.password,
  GLIMT_WEB_PUBLIC_URL: process.env.GLIMT_WEB_PUBLIC_URL ?? baseURL,
};

export default defineConfig({
  testDir: './tests',
  globalTeardown: './global-teardown.ts',
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
      command: built
        ? 'dotnet publish apps/glimt-hub/src/Glimt.Hub -c Release -o apps/glimt-hub/publish --nologo -v q && dotnet apps/glimt-hub/publish/Glimt.Hub.dll'
        : 'dotnet run --project apps/glimt-hub/src/Glimt.Hub',
      url: `${hubUrl}/healthz`,
      cwd: repoRoot,
      reuseExistingServer: true,
      timeout: built ? 300_000 : 120_000,
      env: hubEnv,
    },
    {
      command: built
        ? `npm --workspace apps/glimt-web run build -- --configuration production && node scripts/serve-web.mjs --port ${webPort}`
        : `node scripts/web-config.mjs && npm --workspace apps/glimt-web run start -- --port ${webPort}`,
      url: baseURL,
      cwd: repoRoot,
      reuseExistingServer: true,
      timeout: built ? 400_000 : 180_000,
      env: { ...process.env, GLIMT_HUB_INTERNAL_URL: hubUrl, GLIMT_ENV: process.env.GLIMT_ENV ?? 'e2e', GLIMT_WEB_PUBLIC_URL: process.env.GLIMT_WEB_PUBLIC_URL ?? baseURL },
    },
  ],
});
