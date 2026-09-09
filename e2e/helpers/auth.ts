// Innlogging i e2e. Dev-brukeren seedes av huben (GLIMT_DEV_USER_EMAIL/PASSWORD, satt i playwright.config.ts).
import { expect, type Page } from '@playwright/test';

export const DEV_USER = {
  email: process.env.GLIMT_DEV_USER_EMAIL ?? 'dev@glimtpanel.local',
  password: process.env.GLIMT_DEV_USER_PASSWORD ?? 'GlimtDev-2026!',
};

/** Overskriften på oversikten på begge språk (profilspråket kan være norsk mens språktesten kjører). */
export const SERVERS_HEADING = /^(Servers|Servere)$/;

/**
 * Logger inn gjennom API-et med sidens request-kontekst: cookien `glimt_refresh` havner i nettleserkonteksten,
 * så appen henter et tilgangstoken selv ved neste `goto` (`gp.hasSession` settes i localStorage, se SessionService).
 * Raskere enn skjemaet når innloggingen ikke er det som testes.
 */
export async function loginViaApi(page: Page, user = DEV_USER): Promise<void> {
  const res = await page.request.post('/api/auth/login', { data: { email: user.email, password: user.password } });
  expect(res.ok(), `login som ${user.email}: ${res.status()} ${await res.text()}`).toBeTruthy();
  // Cookien er httpOnly; appen prøver bare refresh ved oppstart når den vet at nettleseren har hatt en sesjon.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('gp.hasSession', 'true');
    } catch {
      // ingen lagring
    }
  });
}

/** Fyller inn skjermbilde 1 og sender med Enter. */
export async function loginViaForm(page: Page, user = DEV_USER): Promise<void> {
  await page.goto('/login');
  await page.getByPlaceholder(/^(Email|E-post)$/).fill(user.email);
  await page.getByPlaceholder(/^(Password|Passord)$/).fill(user.password);
  await page.keyboard.press('Enter');
}

/** Innlogget og på oversikten (venter på skallet). */
export async function gotoOverviewLoggedIn(page: Page): Promise<void> {
  await loginViaApi(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: SERVERS_HEADING })).toBeVisible();
}
