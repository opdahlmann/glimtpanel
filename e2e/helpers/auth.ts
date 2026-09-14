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
 * Raskere enn skjemaet når innloggingen ikke er det som testes. Merker også skjerm 14 som sett (`gp.welcomeSeen`), ellers
 * ville hvert mobiltestbesøk gått til /welcome først; `welcome: true` lar den stå.
 */
export async function loginViaApi(page: Page, user = DEV_USER, options: { welcome?: boolean } = {}): Promise<string> {
  const res = await page.request.post('/api/auth/login', { data: { email: user.email, password: user.password } });
  expect(res.ok(), `login som ${user.email}: ${res.status()} ${await res.text()}`).toBeTruthy();
  const { accessToken } = (await res.json()) as { accessToken: string };
  // Cookien er httpOnly; appen prøver bare refresh ved oppstart når den vet at nettleseren har hatt en sesjon.
  await page.addInitScript((welcome) => {
    try {
      localStorage.setItem('gp.hasSession', 'true');
      if (!welcome) localStorage.setItem('gp.welcomeSeen', 'true');
    } catch {
      // ingen lagring
    }
  }, options.welcome === true);
  return accessToken;
}

/** Fyller inn skjermbilde 1 og sender med Enter. Skjerm 14 merkes som sett, så mobilprosjektene lander på oversikten. */
export async function loginViaForm(page: Page, user = DEV_USER): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('gp.welcomeSeen', 'true');
    } catch {
      // ingen lagring
    }
  });
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
