# e2e

Playwright-tester for Glimtpanel i tre prosjekter: `desktop-chromium` (1440×900), `mobile-webkit` (iPhone 14) og
`mobile-chromium` (Pixel 7). Hver skjerm testes i alle tre; `helpers/mobile-rules.ts` håndhever mobilsjekklisten
(ingen horisontal scroll, klikkbare flater minst 44×44 px).

- Lokalt: kjør `npm run dev` i ett vindu og `npm run test:e2e` i et annet (kjørende servere gjenbrukes, innloggingen
  bruker dev-brukeren fra `.env`).
- Uten `npm run dev` starter Playwright hub (`GLIMT_ENV=e2e`, demomodus med 16 falske servere) og web selv.
- `npx playwright install chromium webkit` første gang. Rapport: `npm --workspace e2e run report`.

## Bygget hub og web (steg 11.1)

`GLIMT_E2E_BUILT=1 npm --workspace e2e test` (slik CI kjører) starter huben fra `dotnet publish`
(`apps/glimt-hub/publish/`) og den bygde web-appen gjennom `scripts/serve-web.mjs` (statiske filer med SPA-fallback,
`/config.json` fra miljøet, proxy for `/api` og `/hub` inkludert WebSocket, og nginx-hodene fra
`apps/glimt-web/nginx/security-headers.conf`, CSP medregnet). Uten variabelen brukes `dotnet run` og `ng serve` som
før. Hele suiten (tre prosjekter, ca. 180 tester) tar under ett minutt lokalt og går med fire arbeidere i CI
(`timeout-minutes: 20` på jobben; planens mål er 15 min).

Felles hjelpere: `loginAs(page, 'owner' | 'reader' | 'demo')` (`helpers/auth.ts`), `expectMobileRules`
(`helpers/mobile-rules.ts`), `triggerE2E(page, action, data)` og `advanceClock(page, seconds)` (`helpers/e2e-api.ts`,
hubens `POST /api/e2e/*`).

- `tests/real-agent.spec.ts` (nattlig jobb `.github/workflows/nightly.yml`): den ekte agenten i Ubuntu-containeren
  (`node scripts/agent-container.mjs --start` med `GLIMT_DEV_ENROL_KEY=gp_e2e` og `GLIMT_AGENT_HUB_WS` mot huben) i
  stedet for de falske, for skjerm 4, 5 og 7. Kjøres bare med `GLIMT_E2E_REAL_AGENT=1`.
- `tests/screenshots.spec.ts`: `GLIMT_DOCS_SHOTS=1 … --project desktop-chromium` lager `docs/overview-1440.png`,
  `docs/overview-390.png` og `docs/overview.png` (side om side) til README, uten masker.

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

## Fase 4: oversikten og legg til server

- `tests/overview.spec.ts`: skjerm 4 (de 16 demoserverne som dev-brukeren eier, sammendrag, verktøylinje, chips, kort
  med levende tall), 16 (`nordic-db` nede), 18 (leser: ingen «Add server», rollen Reader) og 19 (norsk), filter/sortering/
  søk med huskede valg, tastatur (desktop) og ringen som åpner `/servers/:id#mem`. Skjermbilder `overview.png`,
  `overview-reader.png` og `overview-no.png` med ringer, chips, sparklines, infolinje og sammendrag maskert (de lever).
- `tests/add-server.spec.ts`: skjerm 3 (tom oversikt for en eier uten servere: kommando, nedtelling, Docker-valg,
  løfte, «venter», `empty-owner.png`), Copy (ikke i WebKit), og hele flyten: nøkkelen leses fra kommandoen,
  `POST /api/e2e/enrol-fake-agent { key, hostname }` lar en falsk agent bruke den, dialogen hopper til trinn 2, navn og
  tagg lagres, trinn 3 → «Done»/«Show me».
- `helpers/e2e-api.ts`: `ensureEmptyOwner`, `ensureReader` (hubens `POST /api/e2e/ensure-user`, passord
  `GlimtE2E-2026!`), `enrolFakeAgent`, unike e-poster/vertsnavn per prosjekt og kjøring, og `forceLang` (låser
  `gp.lang` i localStorage så profilspråket som språktesten bytter ikke slår inn).

## Fase 5: serversiden og containerdetalj

- `tests/server.spec.ts`: skjerm 5 (`/servers/demo-web-02`: topp, panelnav, alle ti paneler med ekte tall fra demoserveren,
  journal-strømmen i loggpanelet), lukk/husk/panelnav-rulling, 24 t-bytte med `history`-kall og pekemerke på kurven,
  prosesstabellen (sortering lest på `row-index` i ett `evaluate`, filter, utvidet kommandolinje, stablet på mobil),
  skjerm 16 (`demo-nordic-db` nede) og ringen på kortet → `#mem`. Skjermbilder `server.png`, `server-down.png` og
  `panel-<nøkkel>.png` per panel; alt som lever maskeres og loggboksen får fast høyde.
- `tests/container.spec.ts`: skjerm 6 via containerpanelet på web-02 → web-web: topp, to kurver, porter, volumer,
  loggstrøm med Pause («Resume · N new») og Resume, «Open full log view» → `/logs?…`, tilbake med `#cont`. `container.png`.

## Fase 6: loggsiden

- `tests/logs.spec.ts`: skjerm 7 (`/logs?server=demo-web-02`): journal strømmer, Login & sudo gir bare sshd/sudo/fail2ban,
  Errors bare røde linjer, 24 h gir ny strøm, Pause holder visningen og teller («Resume · N»), tekstfilter i `q`, Copy
  lines (ikke i WebKit), containere med chips, farge per container og «Side by side» på desktop, dyplenken «View log»
  fra `cron-sync.service` på worker-01 → `/logs?server=demo-worker-01&source=journal&unit=cron-sync.service`, og
  `GET /api/e2e/agent-streams` (kun `GLIMT_ENV=e2e`) viser 0 strømmer for worker-01 etter at siden forlates (kun
  desktop-prosjektet, siden prosjektene deler hub og tellingen er per server). Skjermbilde `logs.png` med loggboksen
  i fast høyde. Hvert klikk som endrer URL-en ventes inn før neste, siden en ny navigasjon overkjører en pågående.
