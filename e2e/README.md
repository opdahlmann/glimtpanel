# e2e

Playwright-tester for Glimtpanel i tre prosjekter: `desktop-chromium` (1440×900), `mobile-webkit` (iPhone 14) og
`mobile-chromium` (Pixel 7). Hver skjerm testes i alle tre; `helpers/mobile-rules.ts` håndhever mobilsjekklisten
(ingen horisontal scroll, klikkbare flater minst 44×44 px).

- Lokalt: kjør `npm run dev` i ett vindu og `npm run test:e2e` i et annet (kjørende servere gjenbrukes, innloggingen
  bruker dev-brukeren fra `.env`).
- Uten `npm run dev` starter Playwright hub (`GLIMT_ENV=e2e`, demomodus med 16 falske servere) og web selv.
- `npx playwright install chromium webkit` første gang. Rapport: `npm --workspace e2e run report`.

## MongoDB for innlogging

Innlogging trenger MongoDB (dev-brukeren `dev@glimtpanel.local` / `GlimtDev-2026!` seedes der ved oppstart, og
`GLIMT_ENV=e2e` gjør at den eier demoserverne). `playwright.config.ts` løser det slik, ved innlasting av config-filen
(fordi `webServer.env` er statisk og `globalSetup` kjører etter at serverne er startet):

1. `GLIMT_MONGO_URI` satt i miljøet → brukes som den er.
2. En hub svarer allerede på `GLIMT_HUB_URL/healthz` (`npm run dev`) → ingen Mongo startes.
3. Ellers, når `docker` finnes: `docker run -d --rm --name glimt-e2e-mongo -p 127.0.0.1:0:27017 mongo:8` med tilfeldig
   port. Config-filen venter på `ping` (huben seeder bare hvis Mongo er oppe ved oppstart) og setter
   `GLIMT_MONGO_URI` for huben. Databasen er `GlimtpanelE2E`, ny for hver kjøring. `global-teardown.ts` stopper
   containeren. Playwright laster config-filen også i arbeiderprosessene, men de arver miljøet, så containeren startes
   bare én gang.
4. Uten docker starter huben uten database; testene som logger inn feiler da med 503.

Testene i `tests/auth.spec.ts` (innlogging, sesjon over omlasting, utlogging, `/login?next=`, språkbytte) logger inn
gjennom skjemaet eller gjennom `helpers/auth.ts` (`loginViaApi` setter cookien i nettleserkonteksten). Skjermbildet
`login.png` sammenlignes med `tests/auth.spec.ts-snapshots/` (`--update-snapshots` etter designendringer).
