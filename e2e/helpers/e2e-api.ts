// Hubens e2e-endepunkter (kun GLIMT_ENV=e2e): testkontoer og en falsk agent som bruker en ekte engangsnøkkel.
// Kalles gjennom web-proxyen (`/api/e2e/*`), så de virker både mot `npm run dev` (GLIMT_ENV=e2e) og Playwrights egne servere.
import { expect, type Page, type TestInfo } from '@playwright/test';

export const E2E_PASSWORD = 'GlimtE2E-2026!';

export interface E2eUser {
  email: string;
  password: string;
}

/** En bekreftet konto uten servere (skjerm 3). Idempotent. */
export async function ensureEmptyOwner(page: Page, email = 'empty-owner@glimtpanel.e2e'): Promise<E2eUser> {
  const res = await page.request.post('/api/e2e/ensure-user', { data: { email, password: E2E_PASSWORD } });
  expect(res.ok(), `ensure-user ${email}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return { email, password: E2E_PASSWORD };
}

/** En bekreftet konto med lesetilgang til demoserverne (skjerm 18). Idempotent. */
export async function ensureReader(page: Page, email = 'reader@glimtpanel.e2e'): Promise<E2eUser> {
  const res = await page.request.post('/api/e2e/ensure-user', { data: { email, password: E2E_PASSWORD, readerOf: 'all' } });
  expect(res.ok(), `ensure-user ${email}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return { email, password: E2E_PASSWORD };
}

/** Unik e-post per prosjekt og kjøring, til flyter som endrer kontoen (legg til server). */
export function uniqueEmail(prefix: string, testInfo: TestInfo): string {
  return `${prefix}-${testInfo.project.name}-${Date.now().toString(36)}@glimtpanel.e2e`;
}

/** Unikt vertsnavn per prosjekt og kjøring (huben avviser et navn som allerede finnes). */
export function uniqueHostname(testInfo: TestInfo): string {
  const project = testInfo.project.name.replace(/[^a-z0-9]+/g, '-');
  // Tid + tilfeldig hale: to tester i samme prosjekt kan starte i samme millisekund (parallelle arbeidere).
  return `web-${project}-${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`;
}

/** En falsk agent bruker nøkkelen: serveren dukker opp for eieren som ServerAdded. */
export async function enrolFakeAgent(page: Page, key: string, hostname: string): Promise<string> {
  const res = await page.request.post('/api/e2e/enrol-fake-agent', { data: { key, hostname } });
  expect(res.ok(), `enrol-fake-agent: ${res.status()} ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { serverId: string }).serverId;
}

/** Låser språket i localStorage før siden lastes, så profilspråket (som en annen test kan bytte) ikke slår inn. */
export async function forceLang(page: Page, lang: 'en' | 'no'): Promise<void> {
  await page.addInitScript((value) => {
    try {
      localStorage.setItem('gp.lang', JSON.stringify(value));
    } catch {
      // ingen lagring
    }
  }, lang);
}

/** En falsk containeragent bruker nodetokenet fra `POST /api/servers` (fase 12): noden går til `up` og dialogen hopper til trinn 2. */
export async function connectFakeContainer(page: Page, token: string): Promise<string> {
  const res = await page.request.post('/api/e2e/connect-fake-container', { data: { token } });
  expect(res.ok(), `connect-fake-container: ${res.status()} ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { serverId: string }).serverId;
}

/** Lar en containernode si `bye` (planlagt stopp): status `sleeping`. */
export async function sleepNode(page: Page, serverId: string): Promise<void> {
  const res = await page.request.post('/api/e2e/sleep-node', { data: { serverId } });
  expect(res.ok(), `sleep-node ${serverId}: ${res.status()}`).toBeTruthy();
}

/** Lar en containernodes helsesjekk svare 503 (`ok: false`) eller 200 igjen. */
export async function failHealth(page: Page, serverId: string, ok = false): Promise<void> {
  const res = await page.request.post('/api/e2e/fail-health', { data: { serverId, ok } });
  expect(res.ok(), `fail-health ${serverId}: ${res.status()}`).toBeTruthy();
}
