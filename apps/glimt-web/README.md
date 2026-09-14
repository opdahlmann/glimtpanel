# glimt-web

Dashbordet til Glimtpanel: Angular 22 (standalone, zoneless, OnPush), ren CSS med delte tokens fra
`@glimt/design-tokens`, SignalR mot huben. Fase 3 er på plass: layout-skallet (steg 3.3), ordboken (3.2),
kjerne-tjenestene (3.4), felleskomponentene med `/dev/components` (3.5) og auth-skjermene (3.6). Fase 4 gir oversikten
på `/`: serverkortet, verktøylinje med søk, sortering og filterchips, tom-tilstanden med innrulleringskortet og dialogen
«Legg til server» (steg 4.1–4.5). Fase 5 gir serversiden på `/servers/:id` med alle ti panelene og kurver for siste time
og 24 timer, og containerdetaljen på `/servers/:id/containers/:cid` (steg 5.1–5.14). Fase 6 gir loggsiden på `/logs`
(steg 6.1–6.5). Fase 7 gir varselsiden på `/alerts`, Innstillinger › Varsler på `/settings/alerts` (også per server),
skjerm 14 på `/welcome`, PWA med service worker, installasjon og push (steg 7.3–7.6). Se «Serversiden», «Loggsiden»,
«Varsler» og «PWA og push» under.

## Struktur

```
apps/glimt-web/
├── src/
│   ├── index.html, main.ts, styles.css      # styles.css importerer tokens.css og fonts.css
│   └── app/
│       ├── app.ts, app.config.ts, app.routes.ts
│       ├── core/                            # kjerne-tjenester (steg 3.4), se under
│       │   ├── config.service.ts            # /config.json -> signal `config`; feature-flags.ts leser flaggene
│       │   ├── i18n.service.ts, t.pipe.ts   # ordboken, `| t`, dato/klokkeslett (steg 3.2)
│       │   ├── api.service.ts               # fetch + Bearer + refresh ved 401, ProblemDetails -> ApiError
│       │   ├── history.service.ts           # GET /api/servers/{id}/history, mellomlagret 60 s per (server, metrikk, område)
│       │   ├── log-stream.service.ts        # strømmenes livssyklus for én loggvisning (per side, ikke root)
│       │   ├── session.service.ts           # bruker, tilgangstoken, login/logout/refresh, isOwnerOf
│       │   ├── live.service.ts              # SignalR (/hub/live): refcount-abonnement, adaptivt intervall, logger
│       │   ├── live.store.ts                # signal per server (Card/Server), siste-time-ring
│       │   ├── activity.service.ts, connection.service.ts, prefs.service.ts, clipboard.service.ts
│       │   ├── alert.store.ts, alerts.service.ts   # varslene (liste + Alert-hendelser, badgen) og REST for varsler/innstillinger (fase 7)
│       │   ├── push.service.ts, pwa.service.ts     # Web Push i nettleseren; installasjon, hjemskjerm og «ny versjon» (steg 7.5)
│       │   ├── guards.ts                    # authGuard, guestGuard, ownerGuard, devGuard
│       │   ├── live.reducer.ts              # rene funksjoner fra skjelettet (applyServerStatus, sortServers)
│       │   └── live.types.ts                # DTO-ene fra huben (CardDto, ServerDto, UserDto, …)
│       ├── shell/                           # layout-skallet (steg 3.3): shell, auth-shell, sidebar, topbar, bottom-nav, nav.service, title.service
│       ├── shared/                          # felleskomponenter (gp-*), se under
│       ├── i18n/                            # en.json, no.json, nav-icons.ts
│       ├── dev/components.page.ts           # /dev/components: alle komponentene i alle tilstander (kun utvikling)
│       └── features/
│           ├── auth/                        # /login, /register, /confirm, /forgot, /reset (steg 3.6)
│           ├── overview/                    # oversikten (rute `/`, fase 4), se «Oversikten» under
│           │   ├── overview.page.*          # tittel, sammendrag, verktøylinje, chips, kortgrid, tom-tilstand, tastatur
│           │   ├── overview.model.ts        # rene filter-/sorteringsfunksjoner (testet mot de 16 demoserverne i overview.fixtures.ts)
│           │   ├── server-card/             # gp-server-card + card-view.ts (avledede verdier)
│           │   ├── enrol/                   # gp-enrol-panel: nøkkel, nedtelling, Docker-valg, Copy, «venter»
│           │   └── add-server/              # gp-add-server-dialog: tre trinn
│           ├── server/                      # serversiden (rute `/servers/:id`, fase 5), se «Serversiden» under
│           │   ├── server.page.*            # ramme: abonnement, snapshot, historikk-seeding, topp, panelnav, ti paneler, fragment
│           │   ├── server-view.ts           # rene avledninger per panel fra ServerDto (testet mot server.fixtures.ts)
│           │   ├── history-chart.component.ts # gp-history-chart: 1 t fra ringen eller historikken, 24 t fra historikken
│           │   ├── panel-nav.component.ts   # sticky piller med fargeprikk
│           │   └── panels/                  # gp-cpu-panel, gp-mem-panel, gp-disk-panel, gp-net-panel, gp-proc-panel, gp-cont-panel,
│           │                                #   gp-svc-panel, gp-maint-panel, gp-sec-panel, gp-logs-panel (kun innhold; gp-panel er rammen)
│           ├── container/                   # containerdetalj (rute `/servers/:id/containers/:cid`, steg 5.13)
│           ├── logs/                        # loggsiden (rute `/logs`, fase 6), se «Loggsiden» under
│           ├── alerts/                      # varselsiden (rute `/alerts`, steg 7.3) + alerts.model.ts (rene funksjoner, testet)
│           ├── settings/                    # innstillingsskallet med faner (skjerm 9–13); alert-settings.component (steg 7.4), resten i fase 8
│           └── pwa/                         # /welcome (skjerm 14, steg 7.5)
├── scripts/i18n-check.mjs                   # `npm run i18n:check`: nøkkelsett og ukjente nøkler i maler
├── scripts/icons.mjs                        # `npm run icons`: PWA-ikonene i public/icons fra favicon.svg (Playwrights Chromium)
├── ngsw-config.json                         # service worker: app-shell prefetch, config.json som freshness, /api og /hub aldri
├── public/                                  # favicon.svg, manifest.webmanifest, icons/; config.json genereres hit (git-ignorert)
├── nginx/default.conf.template              # nginx i containeren, ${GLIMT_HUB_INTERNAL_URL} fylles inn ved start
├── nginx/10-glimt-resolver.envsh            # entrypoint: DNS-resolver for hub-oppslag fra /etc/resolv.conf
├── nginx/40-glimt-config.sh                 # entrypoint-skript som skriver config.json fra GLIMT_*-env
├── proxy.conf.mjs                           # dev-proxy for ng serve
├── Dockerfile                               # bygg-kontekst = repo-rot
└── angular.json, tsconfig*.json, eslint.config.js
```

Sti-alias: `@core/*`, `@shared/*`, `@i18n/*`, `@features/*` (tsconfig.json). Komponentprefiks er `gp-`.

## Felleskomponenter (`src/app/shared/`, IMPLEMENTERINGSPLAN 6.3 og steg 3.5)

Alle er standalone, `OnPush`, med signal-inputs (`input()`/`model()`), prefiks `gp-` og kun tokens fra
`@glimt/design-tokens` i stilene. Importer fra `@shared/index` (barrel):

| Komponent | Bruk |
|---|---|
| `gp-ring` | Ringkort 76×76 (`value`, `color`, `label`, `sub`, `unit`, `threshold`), er en knapp, sender `pressed` |
| `gp-chip`, `gp-badge`, `gp-row` | Chip med `tone`, badge med `tone`, rad med slots `[leading]`/`[trailing]`/`[footer]`, `stripe`, `interactive` |
| `gp-bar` | Stolpe 5/8/3 px, terskelfarget, eller `segments` (minne) |
| `gp-segment`, `gp-toggle`, `gp-button` | Segmentkontroll (`radiogroup`, piltaster, `scroll`, `full`), bryter (`role="switch"`), knapp (`primary`/`ghost`/`danger`, `lg`/`md`/`sm`, `icon`, `loading`) |
| `gp-input`, `gp-select` | ControlValueAccessor rundt native felt; `label`, `error`, `leadingIcon` (lupe) |
| `gp-sparkline`, `gp-chart` | Sparkline (prototypens `sparkPath`) og kurve med 1 t/24 t-segment, pekemerke (`pointermove`), hull ved `null`, nedsampling til 600 punkter |
| `gp-panel`, `gp-modal`, `gp-toast-host` + `ToastService` | Tonet panel med `open`-modell og `aria-expanded`; dialog med fokusfelle og Esc; toast-kø (2,2 s) |
| `gp-live-dot`, `gp-logo`, `gp-log-view` | Statusprikk, logoen fra glimt-site, loggboks (nyeste øverst, prioritetsfarger) |
| `gp-data-grid` | AG Grid Community (tema fra 6.6). Importeres fra `@shared/data-grid/data-grid.component` (ikke barrel) slik at AG Grid havner i en lat chunk. `columns`, `rows`, `getRowId`, `mobileRenderer` (komponent eller `ng-template`), `expandedRowRenderer` (full-bredde-rad under valgt rad), `filterText`, `sortBy`/`sortDir` (brukes på mobil). Under 760 px målt på verten: én stablet kolonne uten hode |

Hjelpere i `shared/util/`: `thr(pct, base)` (crit ≥ 90, warn ≥ 80), `metricColor`, `withAlpha`, `formatBytes`, `formatRate`,
`formatGb`, `formatDuration`, `formatDurationClock`, `formatTime` (Intl, 24 t, valgfri tidssone), `BreakpointService`
(`isMobile`-signal fra en ResizeObserver på rot-elementet, < 760 px) og direktivet `gpAutofocus` (fokus ved rendering).

Berøring: alle klikkbare flater er minst 44 px. Segment-knapper og panelhoder får treffflaten via gjennomsiktige kanter/negative
marger så designmålene (32 px hode, 28/24 px segmentknapper) beholdes; `gp-button` `md`/`sm` blir 44 px høye under `(pointer: coarse)`.

`/dev/components` viser alt i alle tilstander og fotograferes av `e2e/tests/components.spec.ts` i 1440 og 390.

## Kjøre, teste, linte

Alt kjøres fra repo-roten (npm workspaces). `npm install` i roten først.

| Hva | Kommando |
|---|---|
| Dev-server med proxy | `npm run dev:web` (lager config.json og starter `ng serve` på 4200), eller `npm --workspace apps/glimt-web run start -- --port 4200` |
| Hele stacken | `npm run dev` (hub + agent-container + web, se scripts/dev.mjs) |
| Produksjonsbygg | `npm --workspace apps/glimt-web run build` → `dist/glimt-web/browser` |
| Enhetstester (Vitest, jsdom) | `npm --workspace apps/glimt-web test -- --watch=false` |
| Lint (angular-eslint) | `npm --workspace apps/glimt-web run lint` |
| Ordboken | `npm --workspace apps/glimt-web run i18n:check` (identisk nøkkelsett i en/no, ingen ukjente `t('…')`/`'…' \| t`/`setKey('…')`) |
| Komponentsiden i nettleseren | `npm run dev:web` og åpne http://localhost:4200/dev/components |
| Skjermbilder av komponentsiden | `npm --workspace e2e test -- components` (`--update-snapshots` etter designendringer) |

Tester ligger ved siden av koden som `*.spec.ts`. `ApiService` og `SessionService` testes med mocket `fetch`,
`LiveStore` (fletting og siste-time-ringen), `ActivityService` og `ConnectionService` med falsk tid, guardene mot
en SessionService-stubb, og auth-skjemaene på validering og feilmeldinger. Playwright (`e2e/tests/auth.spec.ts`)
dekker innlogging, sesjon over omlasting, utlogging, `/login?next=` og språkbytte i alle tre prosjektene.

## config.json (kjøretidskonfigurasjon)

Web leser aldri miljøvariabler ved byggetid. Ved oppstart henter `provideAppInitializer` i `app.config.ts`
`/config.json` via `ConfigService.load()`. Formen er:

```json
{
  "env": "development",
  "apiUrl": "/api",
  "hubUrl": "/hub/live",
  "hubPublicUrl": "http://localhost:5080",
  "installUrl": "http://localhost:5080/install",
  "docsUrl": "https://github.com/opdahlmann/glimtpanel#readme",
  "vapidPublic": "",
  "defaultLang": "en",
  "featureFlags": []
}
```

- Lokalt: `node scripts/web-config.mjs` (kjøres av `npm run dev` og `npm run dev:web`) skriver `public/config.json`
  fra `.env` / `.env.dev`. Filen er git-ignorert.
- I containeren: `nginx/40-glimt-config.sh` skriver samme fil til `/usr/share/nginx/html/config.json` fra
  `GLIMT_ENV`, `GLIMT_HUB_PUBLIC_URL`, `GLIMT_INSTALL_URL`, `GLIMT_DOCS_URL`, `GLIMT_VAPID_PUBLIC`,
  `GLIMT_DEFAULT_LANG` og `GLIMT_FEATURE_FLAGS` (kommaseparert → array).
- Mangler filen (f.eks. `ng build` uten generert fil), brukes `DEFAULT_CONFIG` med en `console.warn`. Appen starter uansett.

## Proxy i utvikling

`proxy.conf.mjs` sender `/api` og `/hub` (inkl. WebSocket) til `GLIMT_HUB_INTERNAL_URL`, standard
`http://localhost:5080`. Nettleseren snakker dermed same-origin både lokalt og i produksjon, uten CORS.
`scripts/dev.mjs` laster `.env`/`.env.dev` før `ng serve` startes, så variabelen er satt.

## Layout-skallet (steg 3.3)

`ShellComponent` (`shell/`) ligger rundt alle innloggede ruter: bakgrunn (`gp-backdrop`: to aurora-sirkler og
48 px rutenett, `pointer-events: none`), `gp-sidebar` på desktop (220 px sticky, `--color-ink-2`, fire elementer i MVP,
fem når flagget `containersPage` er på; avviket fra prototypens fem er bevisst, 7.3 er Neste), `gp-topbar` +
`gp-bottom-nav` under 760 px (`BreakpointService.isMobile` fra en ResizeObserver på rot), `<main>` med
`24px 28px 40px` / `12px 12px 24px`, frakoblet-banner fra `ConnectionService` og `gp-toast-host`. `NavService` gir
elementene med ikoner fra `i18n/nav-icons.ts` og aktiv-logikk (server- og containersider markerer «Servers»), badge fra
`AlertStore` (stubb, 0 til fase 7). `TitleService` setter sidetittelen i topplinjen (`setKey('servers')` eller fri
tekst) og `document.title`. Ruter med `data: { bottomNav: false }` (`/welcome`) får ingen bunnlinje. Auth-sidene bruker
`AuthShellComponent` (sentrert, uten navigasjon). Språkbyttet (EN/NO) ligger i sidepanelet og topplinjen; det er
steg 3.2 sin «midlertidige knapp» og flyttes til innstillingene i fase 8. Utlogging ligger som ikonknapp ved avataren
(desktop) og i topplinjen (mobil) til innstillingene er på plass.

## i18n (steg 3.2)

`I18nService.t(key)` slår opp i `i18n/en.json`/`no.json` (importert statisk, `type I18nKey = keyof typeof en`), `| t`
i malene (`TPipe`, uren så språkbytte oppdaterer alt). `lang` = lagret valg (`gp.lang` i localStorage) → brukerens
profil → `config.defaultLang`. `setLang` lagrer lokalt og `PATCH /api/account { language }` når innlogget.
Klokkeslett og datoer via `Intl` i brukerens tidssone, 24 t i begge språk: `formatClock` («08:14:05»),
`formatTimeShort` («08:14»), `formatWhen` («08:11» i dag, «yesterday 23:10», ellers «Sep 7 14:20»), `formatDate`.
Tekster med tall bygges av deler i malene, ikke av setningsmaler.

## Kjerne-tjenestene (steg 3.4)

- `ApiService`: `fetch` mot `config.apiUrl`, JSON, `Authorization: Bearer` fra `SessionService`, `credentials: 'include'`
  (oppfriskningscookien `glimt_refresh`), én automatisk `POST /api/auth/refresh` + nytt forsøk ved 401 (delt mellom
  samtidige kall), `{ anonymous: true }` for login/register/refresh. ProblemDetails → `ApiError { status, code, title,
  detail, errors }`, `errorKey(err)` → ordboksnøkkel (`emailTaken`, `emailNotConfirmed`, `invalidToken`,
  `wrongCredentials`, `networkError`, `errorGeneric`).
- `SessionService`: `user`, `accessToken`, `isAuthenticated`, `ready`. Ved oppstart (`app.config.ts`, etter
  config.json) prøves refresh med cookien én gang og deretter `GET /api/auth/me`; guardene venter på `whenReady()`.
  Tokenet oppfriskes 60 s før `expiresAt`. `isOwnerOf(id)` leser rollekartet som `ServerListService` fyller fra
  `GET /api/servers`. `demoMode` brukes av `/demo` (fase 10).
- `LiveService`: `HubConnection` mot `config.hubUrl` med `accessTokenFactory`, JSON-protokoll (MessagePack sender
  PascalCase-navn), `withAutomaticReconnect([0, 2000, 5000, 10000, 30000])` og ny full tilkobling hvert 5. s når den
  gir opp. `subscribeOverview()` / `subscribeServer(id)` returnerer en avmeldingsfunksjon og deler ett hub-abonnement
  mellom flere komponenter (refcount, gjenopprettes etter gjenoppkobling). `startLog(req, handlers)` / `stopLog(id)`,
  `onServerAdded` / `onServerRemoved`. Reagerer på `ActivityService.mode`: `hidden` → alle abonnementer og loggstrømmer
  av (refcountene beholdes, alt gjenopprettes ved synlig), `idle` → `SetInterval(5000)`, `active` → `SetInterval(1000)`.
  Stopper ved utlogging. Skallet holder forbindelsen åpen så lenge man er innlogget.
- `LiveStore`: én `WritableSignal` per server for `Card` og `Server` (`card(id)`, `server(id)`, `cards` sortert),
  `applyStatus` fletter status/connected/lastSeen inn uten å røre tallene. Siste time som ring på 3 600 slots à 1 s per
  server, seedet fra kortets `cpuLastHour`/`memLastHour` (120 × 30 s) og påfylt for hvert `Card`; `lastHour(id)` gir
  120 punkter (maks per 30 s) for sparklines. Ringen seedes på nytt etter mer enn 60 s stillhet (skjult fane).
- `ActivityService` (`active | idle | hidden`: `visibilitychange`, 2 min uten pointermove/keydown/touchstart/scroll/wheel),
  `ConnectionService` (`offline` når forbindelsen har vært borte > 2 s eller `navigator.onLine === false`, `frozenAt` =
  siste melding, `reconnect()`), `PrefsService` (typet localStorage: sort, filters, view, collapsed, sparklines,
  welcomeSeen, lang), `FeatureFlags`, `ClipboardService` (kopier + toast «Copied to clipboard»), `AlertStore` (stubb).
- Guards: `authGuard` (venter på `ready`, → `/login?next=`), `guestGuard` (→ `/` eller `next`), `ownerGuard`,
  `devGuard` (`development` og `e2e`, der Playwright fotograferer `/dev/components`).

## Auth-skjermene (steg 3.6)

`/login` og `/register` er skjerm 1–2: `gp-auth-frame` (logo 36 + «Glimtpanel» + tagline, glasskort 360 px, grønn
prikk + `authNote` under), `gp-segment` som bytter rute uten omlasting, `gp-input` med Reactive Forms (Angular 22
har Signal Forms i `@angular/forms/signals`, men `gp-input` er en ControlValueAccessor, så skjemaene bruker
`FormGroup` med validatorer som returnerer ordboksnøkler: `invalidEmail`, `passwordTooShort` (≥ 10), `nameRequired`).
Feil vises under feltet etter blur eller innsending, i `--color-crit` 11 px. Serverfeil: `wrongCredentials`,
`emailNotConfirmed` (med «Send again»), `emailTaken`. Registrering → «Check your e-mail» med «Send again». `/confirm?token=`
→ `POST /api/auth/confirm` → innlogget → `/`. `/forgot` → 204 → «Check your e-mail». `/reset?token=` → nytt passord →
`/login` med toast. Enter sender skjemaet; autofokus i første felt bare på desktop. Betaløftet under kortet er
ordboksteksten `authNote` (`GET /api/subscription` krever innlogging, så konstantene hentes ikke derfra på
innloggingsskjermen).

## Oversikten (fase 4)

`OverviewPage` (`features/overview/`) er skjerm 3, 4, 16 og 18 fra designet:

- **Sammendraget** bygges av deler: `16 servers · 13 up · 1 down · 1 paused · live · 08:14:05` (klokken tikker hvert
  sekund; «connection lost» fra ConnectionService, «reconnecting…» fra LiveService). «Add server» vises for alle unntatt
  lesere uten egne servere (`readerOf > 0` og `ownsServers` falsk fra `/api/auth/me`).
- **Verktøylinjen**: `gp-input` med lupe (søk på navn og tagger, 150 ms debounce), `gp-select` med sortering
  (`name`, `cpu`, `mem`, `disk`, `status`, `tag`; status sorterer nede → pauset → oppe, tagg på sammenslått taggstreng,
  tallene synkende med nede-servere sist), og visningssegmentet Cards/Groups (Compact bare bak flagget `compact`; grupper er levert i fase 13)
  er på (i MVP rendres det ikke). Filterchips: All, én chip per tagg (alfabetisk), up/down/paused med prikk, «Has alert»
  uavhengig. `PrefsService` husker sortering, filter og visning; søket huskes ikke. Funksjonene ligger i
  `overview.model.ts` og testes mot de 16 demoserverne i `overview.fixtures.ts`.
- **Serverkortet** (`gp-server-card`, input `id`) leser `LiveStore.card(id)` og `LiveStore.lastHour(id)` selv, slik at ett
  `Card` bare tegner ett kort. Avledningene (`card-view.ts`): status/prikk/opasitet, infolinje «Ubuntu 24.04 · 4 cores ·
  8 GB · up 12d 4h» (huben sender `uptimeSec` på kortet), ringene med «1.9 of 4 cores» / «4.9 of 8 GB» / «/ 92%», chips
  Net (MB/s), Containers (gul når noen ikke kjører, «—» uten Docker), Updates «3 (1)» (oransje ved sikkerhet), Reboot
  («required»/«—»), Services («1 failed»/«ok»), stripe i varselets farge (alvorsgrad per varsel kommer i fase 7; til da er
  aktive varsler røde). Ringene er knapper til `/servers/:id#cpu|mem|disk`, navnet til `/servers/:id`, Enter på kortet
  åpner. Kort utenfor skjermen (IntersectionObserver, 120 px marg) fryser det som tegnes (`linkedSignal`) mens signalene
  lever videre. Sparklines kan slås av i `PrefsService.sparklines`. Hele kortet har `aria-label` med status og de tre
  prosentene. Nede: ringer på 0, opasitet .6, «last seen 03:12» (`formatWhen`). Pauset: nøytral prikk, opasitet .6.
- **Tom-tilstand** (skjerm 3) når `GET /api/servers` er lastet og tom: «No servers yet» og glasskortet med
  `gp-enrol-panel`. Panelet henter nøkkelen ved visning (`POST /api/servers/enrol-key { dockerMode }`), teller ned fra
  `expiresAt`, gir «New key» ved utløp, Docker-segmentet (Secure = `proxy`, Simple = `simple`) henter en ny nøkkel med
  det valget (huben lagrer valget på nøkkelen), Copy går gjennom `ClipboardService` og viser «Copied» i 1,8 s. Lesere
  uten servere ser «You have not been given access to any servers yet».
- **«Legg til server»** (`gp-add-server-dialog`, `gp-modal` 560 px) har tre trinn: (0) `gp-enrol-panel`, (1) grønt
  «connected»-kort, navnefelt forhåndsutfylt med hostname, taggchips (eksisterende tagger + «+» for ny, samme regel som
  huben: 1–24 tegn a-z, 0-9 og -), «Next» lagrer med `PATCH /api/servers/{id}`; (2) forslag om appen med «Done» og «Show
  me» → `/welcome`. Siden lytter på `LiveService.onServerAdded`: mens tom-tilstanden vises eller dialogen står på trinn 0,
  hopper dialogen til trinn 1 med den nye serveren. Dialogen kan lukkes når som helst; nøkkelen lever til den utløper.
  Alt innholdet ligger bak `@if (open())`, fordi projisert innhold ellers instansieres (og ville hentet en nøkkel) selv
  når dialogen er lukket.
- **Tastatur** (FB 13.6): `/` fokuserer søket, piltaster/Home/End flytter fokus mellom kortene, Enter åpner.
- **Mobil**: søk i full bredde, sortering under, chips ruller horisontalt (`scrollbar-width: none`), ett kort per rad,
  chips 44 px ved `(pointer: coarse)`.

Playwright (`e2e/tests/overview.spec.ts`, `e2e/tests/add-server.spec.ts`) dekker skjerm 3, 4, 16, 18 og 19 i alle tre
prosjektene med skjermbilder (levende tall maskeres) og hele flyten fra tom oversikt til «Done» via hubens e2e-endepunkt
`enrol-fake-agent`. Ytelsesmålet i steg 4.5 (30 kort under 5 % CPU i Chrome) er ikke målt ennå; det gjøres i fase 9
sammen med den fysiske mobiltesten.

## Serversiden (fase 5)

`ServerPage` (`features/server/`) er skjerm 5 og 16. `id` kommer fra ruten. Ved inngang: `LiveService.subscribeServer(id)`
(avmeldes ved utgang), `GET /api/servers/{id}/snapshot` så siden tegnes før første `Server` fra strømmen (404/403 gir
«Server not found»), og `history?metric=cpu|mem&range=1h` seeder siste-time-ringen i `LiveStore` (dyplenke uten kort).
`LiveStore.applyServer` legger hvert `Server` inn i ringen (serversiden får ingen `Card`), og `LiveStore.hourChart(id)` gir
kurven for siste time med 600 punkter à 6 s (maks per bøtte, `null` for hull), beregnet bare for servere noen ser på.
`GET /api/servers` gir `supportUntil`/`eol` og rollen (`Alert settings` kun for eier).

- **Toppen**: «‹ Servers», h1 + prikk + status («live», «last seen 03:12», «paused») + tagger, infolinje «Ubuntu 24.04 ·
  6.8.0-45-generic · 4 cores · 8 GB», «up 41d 2h · last boot Jul 30 01:05», rød EOL-badge og «Supported until Apr 2029».
  «Text mode», «Copy snapshot» og «Share link» rendres bare bak flaggene `textmode`, `snapshot` og `share`.
- **Panelnav** (`gp-panel-nav`): sticky (`top: 0`, `top: 44px` under topplinjen på mobil), klikk åpner panelet og ruller
  det til 70 px under toppen. Fragment `#cpu|#mem|#disk` (kortets ringer) gjør det samme ved inngang; alle panelnøklene
  godtas. Lukkede paneler huskes i `PrefsService.collapsed` (per panel, ikke per server).
- **Panelene** i rekkefølge CPU, Memory, Disk, Network, Processes, Containers, Services, Maintenance, Security, Logs.
  Rammen er `gp-panel` (tittel, `meta` fra `server-view.ts`, tone, `open`); innholdet er egne komponenter i `panels/` som
  får ferdige visningsobjekter som input. `server-view.ts` er rene funksjoner: `headerView`, `cpuView` (kjerner, seks
  chips: load over kjerner og iowait over 5 % er oransje), `memView` (brukt = total − free − buffers − cached),
  `diskView` (fulleste først, GB under 1 000 GB ellers TB, inoder, I/O), `netView`, `procView`, `containersView`
  (restarting/stopped først, så CPU; minne mot grense, uten grense mot 2 GB i nøytral farge), `servicesView` (feilede →
  running → stoppede, kun `.service`, maks 200 + «Show all»), `maintView`, `securityView` og `rememberPorts` («new»-badge
  for porter som ikke fantes i et tidligere øyeblikksbilde, høyst 24 t, lagret i `PrefsService.knownPorts` per server;
  første besøk merker ingenting som nytt).
- **Kurver** (`gp-history-chart`): 1 t fra `live` (ringen) når den finnes, ellers `history?range=1h`; 24 t fra
  `history?range=24h`. Hentes ved bytte og oppfriskes hvert 60. sekund (`HistoryService` mellomlagrer 60 s). Nettverkets
  sparklines henter `net:<grensesnitt>` for siste time. Hull i bufferen vises som brudd.
- **Prosesser** (`gp-proc-panel`): segment By CPU / By memory, filter på navn eller bruker, `gp-data-grid` med Process
  (navn + «bruker · pid»), CPU (oransje over 50 %), Memory («812 MB», «1.5 GB»), Time (`3d 04:12`). Klikk viser
  kommandolinjen som full-bredde-rad. `getRowId = pid`, oppdateres hvert sekund. Stablet på mobil med tre chips.
  `gp-data-grid` fikk `breakpoint` (portene i sikkerhetspanelet stables først under 300 px, siden de står i en av to
  kolonner) og hurtigfilter som ser de opprinnelige kolonnene også i stablet modus.
- **Logger** (`gp-logs-panel`): starter en `journal`-strøm med `tail: 10` når panelet er åpent, fanen synlig og
  forbindelsen oppe; stoppes når panelet lukkes eller siden forlates, gjenstartes etter skjult fane og gjenoppkobling.
  «Open full log view» → `/logs?server=:id`. «View log» på en feilet tjeneste → `/logs?server=:id&source=journal&unit=`.
- **Nede** (skjerm 16): rød prikk og «last seen», tallene nedtonet (`.dim`), kurvene viser hull, prosesser og logger
  «Not available while the server is down».
- **Mobil**: topplinjen viser servernavnet (`TitleService`), knappene bryter, containernes tall på egen linje,
  sparklines under grensesnittnavnet, tabellene i stablet modus.

`ContainerPage` (`features/container/`) er skjerm 6: «‹ servernavn», h1 + prikk «running · 3d 4h» + image-badge,
meta-linje (restarts, image age, health, compose), CPU- og minnekurve fra `history?metric=cont:<id>` og
`cont:<id>:mem` (1 t og 24 t fra historikken), porter som chips, volumer i monospace, og loggseksjon: `container`-strøm
med `tail: 200` ved inngang, «Pause» holder visningen og teller nye linjer i knappen («Resume · 12 new»), «Open full
log view» → `/logs?server=:id&source=container&container=<id>`, tilbake-lenken går til serversiden med `#cont`.
Containeren finnes på full id, kort id eller navn.

Playwright (`e2e/tests/server.spec.ts`, `e2e/tests/container.spec.ts`) dekker skjerm 5, 6 og 16 i alle tre prosjektene
med skjermbilder per panel; levende tall, kurver, grid-rader, containerrader (sortert på levende CPU) og logglinjer
maskeres, og loggboksen får fast høyde før skjermbildet så sidehøyden er den samme hver gang.

## Loggsiden (fase 6)

`LogsPage` (`features/logs/`) er skjerm 7. Alt lever i spørreparametrene `server`, `source` (hubens navn: `journal`,
`auth`, `kernel`, `packages`, `web`, `firewall`, `container`), `unit`, `container` (kommaseparert, høyst 4),
`priority` (`err`/`warn`/`info`), `range` (`15m`/`1h`/`24h`, standard 1 h) og `q`, så dyplenkene fra tjenestepanelet
(«View log» → `unit`), loggpanelet, containerpanelet og containersiden (`source=container&container=`) lander med riktig
filter og siden kan deles internt. Hvert valg skriver hele spørrestrengen fra sidens egne verdier (`replaceUrl`).

- **Verktøylinje**: server-`<select>` (alle servere med tilgang, første som standard), tekstfilter (filtrerer det som er
  lastet, 100 ms debounce, `q` i URL-en), tidsromsegment 15 min / 1 h / 24 h (`sinceMs` = nå − tidsrom, satt når
  strømmen byttes, ikke hvert sekund). Kildesegment System, Login & sudo, Kernel, Packages, Web server, Firewall,
  Containers med hint-tekst per kilde; «Custom files» er Neste og vises ikke. Prioritetssegment All / Errors / Warnings /
  Info sendes som `priority`. Enhetsfilteret vises som en chip som kan fjernes. Scope-segmentet kun bak flagget `crossLogs`.
- **`LogStreamService`** (`core/`, `providers: [LogStreamService]` på siden): `configure(requests)` holder nøyaktig disse
  strømmene åpne (høyst 4); bytte av server, kilde, enhet, container, prioritet eller tidsrom er StopLog + StartLog og
  tømmer linjene. Nyeste øverst, høyst 300 linjer i minnet. Pause samler linjer i en buffer (høyst 300) og knappen viser
  «Resume · 42»; Resume flytter dem inn. `dropped` fra huben blir en grå linje «n lines dropped». Stopp ved skjult fane og
  frakobling (LiveService avslutter med `hidden`/`reconnecting`/`disconnected`), gjenstart ved synlig/tilkoblet med
  `sinceMs` = siste mottatte linje + 1 og uten `tail`, så ingenting mangler. En avslutning fra huben eller agenten
  (`eof`, `unavailable`, `error`) står til forespørselen byttes; `unavailable` vises som «Not found on this server»
  (webtjenerloggen på en server uten nginx/Apache). Alt stoppes når siden forlates.
- **Containere** (steg 6.3): kilden Containers viser chips for alle containere på serveren (fra `GET /api/servers/{id}/snapshot`),
  flere kan velges (høyst 4), hver får en farge fra prototypens `CCOL` på enhetsnavnet, én `container`-strøm per valgt.
  Flettet visning sortert på tidsstempel er standard; på desktop kan «Side by side» dele visningen i kolonner (høyst 3).
- **Sticky bunnlinje**: «Pause»/«Resume» som primærknapp og «Copy lines» (markerte linjer i loggboksen, ellers de 50
  nyeste som «08:14:05 sshd: melding»). På mobil ligger den 60 px over navigasjonen; kildesegmentet ruller, linjer bryter.

Playwright (`e2e/tests/logs.spec.ts`) dekker kilde, prioritet, tidsrom, pause/resume, tekstfilter i URL-en, kopiering,
containere flettet med farge og side om side, dyplenken fra en feilet tjeneste på worker-01, og at
`GET /api/e2e/agent-streams` viser 0 strømmer for serveren etter at siden forlates.

## Varsler (fase 7)

`AlertStore` (`core/`) holder listen fra `GET /api/alerts?state=all` (nyeste først; løste på `resolvedAt`) og de levende
`Alert(event)`-meldingene som `LiveService` gir videre (huben sender dem til alle tilkoblinger, uansett side). Skallet
laster listen ved innlogging, så badgen i navigasjonen (`activeCount`) er riktig fra første skjerm; hendelsen oppdaterer
også kortets `activeAlerts`/`alertSeverity` i `LiveStore` uten å vente på neste `Card`, og kortets stripe følger alvoret
(rød kritisk, oransje advarsel, grå info). `AlertsService` er REST-en: stille, kontoinnstillinger, kanaler, per server,
push-abonnementer.

- **Varselsiden** (`features/alerts/`, skjerm 8 og 17): sammendrag «5 active · 3 resolved», segment Active / Resolved /
  All, rader med prikk (rød/oransje/info, grønn når løst), servernavn (→ serversiden), regel + detalj (→ panelet:
  `#disk`, `#mem`, `#cpu`, `#cont`, `#maint`; «Service failed» → `/logs?server=&source=journal&unit=`), badges «silenced» og
  «Resolved 02:15», tid som «08:11» / «yesterday 23:10» / «Sep 7 14:20» i brukerens tidssone, og «Silence» for eiere med
  1 hour / Until tomorrow / Until Monday som glir inn under raden (`POST /api/alerts/silence`, regnet i brukerens
  tidssone av huben). Tom-tilstanden er grønn. Regelseksjonen viser de sju reglene med standard fra
  `GET /api/alert-settings`, så justerte terskler vises («> 90 % for 10 min» bygges av deler i `alerts.model.ts`),
  alvor-badge, «Off» når regelen er av, og oppsummeringsteksten med kontoens klokkeslett.
- **Innstillinger › Varsler** (`features/settings/alert-settings.component`, skjerm 10): «Default thresholds» med én rad per
  regel (prikk, navn, standard som tekst; klikk gir små tallfelt for prosent/antall og minutter, Enter/Esc lukker; bryter
  av/på), Kanaler (Push med antall enheter og navn fra `pushDevices` og en egen bryter for *denne* enheten, E-post med
  adressen og «Always on for server down and disk full», Webhook med URL, hemmelighet med Show/Copy/New secret og
  «Send test»), Daglig oppsummering (bryter + «HH:mm» som tekstfelt, 24-timers i alle nettlesere). «Save» er bare aktiv ved
  endring (utkastet sammenlignes med det lagrede), lagrer regler (`PUT /api/alert-settings`, hele avviket fra
  standardene) og kanaler (`PUT /api/channels`), og viser toasten «Saved». Med `?server=:id` (fra serversidens «Alert
  settings»): «‹ web-02», «Alerts for web-02», bryterne «Use account defaults» og «Mute all alerts for this server»,
  «Silenced until …» med «Resume alerts», og per-regel overstyring merket «overridden» (`PUT
  /api/servers/{id}/alert-settings` med hele overstyringen). `settings.page` er fanesegmentet (Account, Alerts, Servers,
  Access, Subscription, Data); de andre fanene sier «Not available yet» til fase 8.
- **PWA og push** (`features/pwa/welcome.page`, `core/push.service`, `core/pwa.service`, skjerm 14): `manifest.webmanifest`
  (Glimtpanel, `standalone`, `#0f1013`, ikoner 192/512 + maskable fra logoen, `start_url /`), service worker fra
  `@angular/service-worker` (`provideServiceWorker`, kun i produksjonsbygg; `ngsw-config.json` prefetcher app-skallet,
  henter `config.json` med `freshness` og rører aldri `/api`, `/hub`, `/agent`), `apple-touch-icon` og
  `black-translucent`-statuslinje for iOS. `/welcome`: logo 56, «Get alerts on your phone», to nummererte trinn, på
  desktop et glasskort «Install Glimtpanel as an app on this computer» når nettleseren gir `beforeinstallprompt`
  (`PwaService.install()`), «Turn on notifications» (48 px) → `Notification.requestPermission` →
  `SwPush.requestSubscription({ serverPublicKey: config.vapidPublic })` → `POST /api/push-subscriptions` med enhetsnavn
  («iPhone · Safari», «Mac · Chrome» fra `userAgentData`/UA) → grønn pille «Notifications are on for this device»;
  «Later». På iPhone i Safari (ikke hjemskjerm, `navigator.standalone === false`) er trinn 1 fremhevet og knappen byttet ut
  med forklaringen om hjemskjermen. Avslått tillatelse og manglende støtte forklares. Siden vises første gang appen
  åpnes på mobil etter innlogging (`PrefsService.welcomeSeen`, skallet sender dit én gang) og fra «Show me» i
  legg-til-server-dialogen. Et klikk på et push-varsel navigerer til `url` i nyttelasten (`notificationClicks`).
  `SwUpdate` gir banneret «New version available · Reload» øverst i skallet. Utenom produksjon kan Playwright sette
  `window.__gpFakePush = 'granted' | 'denied'`: tillatelsen svarer slik og abonnementet simuleres lokalt, siden `ng serve`
  ikke har service worker og WebKit på iPhone ikke har `Notification`.

**Manuell sjekkliste for push (før fasen lukkes, ikke gjennomført ennå):** hub med `GLIMT_VAPID_*` satt og
`GLIMT_WEB_PUBLIC_URL` på https; produksjonsbygg av web (service worker); (1) Chrome på macOS: `/welcome` → «Turn on
notifications» → enhet vises under Innstillinger › Varsler › Push; utløs et varsel (`POST /api/e2e/fail-service` i e2e,
eller fyll en disk) → push kommer, klikk åpner serveren/loggene; (2) Firefox og Safari på macOS likt; (3) iPhone: åpne i
Safari → Del → Legg til på Hjem-skjerm → åpne fra hjemskjermen → `/welcome` → varsler på → push mottas låst skjerm;
(4) Android Chrome: installer fra banneret → varsler på → push mottas; (5) e-post til eieren for «Disk almost full» og
webhook mot en `requestbin`-URL med gyldig signatur.

Playwright (`e2e/tests/alerts.spec.ts`, `settings-alerts.spec.ts`, `welcome.spec.ts`) dekker skjerm 8, 10, 14 og 17 i alle
tre prosjektene: radene fra demoserverne, badgen, stille, segmentene, dyplenkene, redigering av terskler og kanaler med
«Save» kun ved endring, per-server-visningen med overstyring og demp, skjerm 14 med falsk push (og iPhone-varianten i
WebKit), installasjonskortet på desktop, første besøk på mobil → `/welcome`, og ende til ende: `disconnect-server` med
bakdatert «sist sett» gir «Server down» i listen og badgen uten omlasting, `reconnect-server` løser det. Varsel-badgen og
kortets stripe maskeres i alle skjermbildene (varsler utløses etter hvert som demoserverne lever).

## Containernoder (fase 12)

En node er enten en server (agenten på en Ubuntu-maskin) eller en container (agenten inne i containeren, som sidecar
eller binær i imaget). `CardDto`/`ServerDto` har `kind`, og `status` kan være `sleeping` (noden sa `bye`).

- **Oversikten (steg 12.8, skjerm 20).** Tittelen og `TitleService` sier «Nodes»/«Noder» når kontoen har minst én
  containernode, ellers «Servers» som før; sammendraget blir «19 nodes · 16 servers · 3 containers · 14 up · 1 down ·
  1 sleeping · 1 paused». `gp-container-card` (`features/overview/container-card/`) bruker serverkortets ramme og CSS:
  infolinje «container · nginx:1.27 · up 3d 4h · on web-02» (verten kun når lenket), to ringer (CPU mot tildelte
  kjerner, minne mot grensen, «no limit» uten), fire chips (Net, Restarts oransje over 3 siste 24 t, Health ok/fail/—,
  Listening ports) og to sparklines; `sleeping` gir nøytral prikk, «sleeping since 14:02», ringer på 0 og opasitet .6;
  `approx` gir «≈» foran tallene med forklaring i `title`. Avledningene er rene funksjoner i `container-card-view.ts`.
  Filterchipsene får «sleeping», «Servers» og «Containers» (`OverviewFilters.kind`, husket av PrefsService), sortering
  på status er nede → sover → pauset → oppe. Serverpanelets containerrad får en «node»-badge som lenker til noden når
  verten ser en container som er en egen node (`ServerDto.linkedNodes`). Tom-tilstanden har «Add a container».
- **Containernodens side (steg 12.9, skjerm 21).** `ServerPage` velger panelliste etter `kind` (`panelsFor`): CPU,
  Memory, Volumes (diskpanelet med roten som `/`), Network, Processes, Listening ports (`gp-ports-panel`), Health &
  checks (`gp-health-panel`, grønt/rødt tonet: helse-URL med status, svartid og «checked 08:14:02», én rad per
  `check`), Host (`gp-host-panel`, kun når lenket: image, image-alder, omstarter, tilstand, lenke til verten) og Logs.
  Toppen har «‹ Nodes», image-badge, «on web-02» som knapp, «sleeping since …»; ingen EOL og ingen «Text mode».
  `capabilities.procAll`/`netns` usann gir «not readable on this platform» i stedet for tomme tall. Loggpanelet
  (`gp-logs-panel`) viser chips per fil fra `logPaths` (`source: file` + `path`) og «stdout (via host)» når lenket;
  uten begge et hint om `GLIMT_LOG_PATHS`. Loggsiden får kilden «Files» (chips per sti, spørreparameter `path`) for
  containernoder, og «Containers» er der stdout via verten (huben ruter).
- **«Add container» (steg 12.10, skjerm 22).** «+ Add server» er blitt «+ Add» med menyen Server / Container.
  `gp-add-container-dialog` (`features/overview/add-container/`): (0) navn og «Create» → `POST /api/servers`;
  (1) tokenet i `<code>` med Copy og «shown only once», segmentet Sidecar (Compose) / In your image, valgfrie felt som
  fyller `GLIMT_HEALTH_URL`, `GLIMT_CHECKS` og `GLIMT_LOG_PATHS` inn i snutten (`snippets.ts`), «Waiting for the
  container…»; (2) tagger og «Done» når kortets status blir `up`. Innstillinger › Servere-fanen (Type-kolonne, rotasjon
  med token én gang) bygges i steg 8.3.
- **Ordboken.** `nodes`, `node`, `sleeping`, `sleepingSince`, `addContainer`, `approx`, `healthChecks`, `host`,
  `files`, `stdoutViaHost`, `notReadable`, `r_health_failed`/`d_health_failed` (åttende regel) m.fl.; `r_server_down`
  heter nå «Node down».

Vitest: `container-card-view.spec.ts`, `overview.nodes.spec.ts`, `node-view.spec.ts`, `snippets.spec.ts`. Playwright:
skjerm 20 (`overview.spec.ts`), 21 (`server.spec.ts`: `acme-backend` lenket til `web-02`, `edge-worker` uten cgroup) og
22 (`add-container.spec.ts`: opprett → token → `connect-fake-container` → trinn 2) i tre prosjekter.

## Grupper (fase 13)

Navngitte, personlige samlinger av noder på tvers av servere, containere og verter (skjerm 23; designramme F3 for
summene, men medlemskapet er eksplisitt). `GroupsStore` (`core/groups.store.ts`) henter `GET /api/groups` når
oversikten åpnes og oppdaterer lokalt etter hver endring; ingen SignalR-melding, gruppekortet regnes i nettleseren fra
`Card`-ene (`group-view.ts`: kjerner i bruk av totalt, GB i bruk av totalt, aktive varsler, verste status nede > sover >
pauset > oppe). Demokontoen (`demo@glimtpanel.com`) ser gruppene som lesbare (`readOnly`).

- **Visningssegmentet** Cards/Groups finnes alltid (flagget `groups` er borte). Gruppevisningen viser
  `gp-group-card` i `order`: navn, «4 nodes · 3 up · 1 sleeping», verste status som prikk og stripe, tre chips
  (CPU «5.8 of 12 cores», Memory «14.2 of 32 GB», Alerts «2 active») og én medlemsrad per node (prikk, navn,
  type-badge, CPU %, Mem %) som åpner noden. Tom gruppe: «No nodes yet · add from a card». Piltaster opp/ned på
  kortet bytter `order` med naboen (`PATCH` på begge).
- **⋯ på nodekortene** (`gp-node-menu`, 32 px med 44 px treffflate, i status-cellen): «Add to group…» med hake per
  gruppe og «New group…» med navnefelt som lager gruppen med noden som første medlem. Menyen er en `gp-modal` (440 px)
  på desktop og et bunnark (`sheet`) på mobil, så den aldri klippes av kortets `overflow: hidden`; Esc lukker.
- **⋯ på gruppekortet**: «Show as cards» (kortvisningen med `?group=id` og chipen «Group: Acme ×»), «Rename»,
  «Delete group» (andre klikk bekrefter).

Vitest: `group-view.spec.ts`. Playwright: skjerm 23 i `overview.spec.ts` (demoens «Acme» og «Edge»; ny gruppe fra
`cache-01`, nytt navn, vis som kort, slett) i tre prosjekter.

## Innstillinger, tilganger, abonnement og data (fase 8)

`/settings/:tab` (steg 8.1) har fanesegmentet Account, Alerts, Servers, Access, Subscription, Data (ruller horisontalt
på mobil); innholdet står i kort i `auto-fit minmax(300px, 1fr)`, én kolonne på mobil, `pdIn` ved fanebytte
(`settings.css`). Servers, Access og Subscription vises bare for eiere (eller kontoer uten noder); lesere får
«Owners only» med forklaring.

- **Konto (8.2, skjerm 9)** `gp-account-settings`: navn, e-post (dialog med ny adresse + passord → huben sender
  bekreftelse til den nye innboksen, adressen byttes ved `/confirm`), tidssone-`<select>` fra
  `Intl.supportedValuesOf('timeZone')` med offset nå («Europe/Oslo (UTC+02:00)»), språksegment som bytter straks,
  «Save» kun ved endring; «Change password» i dialog (gammelt + nytt, ≥ 10 tegn); tofaktor bak flagget `twofa`;
  «Delete account» → `gp-delete-account-dialog` med passord og advarselen → `/login`.
- **Servere (8.3, skjerm 11)** `gp-servers-settings`: plasslinjen «2 slots in use · 2 free forever · 0 beta» fra
  `GET /api/subscription` (noder av begge typer), `gp-data-grid` med Node (prikk + navn), Type, Tags (rad-dialog med
  chips og «+»), Status og handlingene «Rotate key» (bekreftelse → toast; containernoder får tokenet vist én gang
  med «old token works for 24 hours») og «Remove» (dialog → avinstalleringskommando med Copy for servere,
  «remove the sidecar …» for containernoder; plassen frigjøres straks). Knappene i cellene er HTML-renderere
  (`data-action`) som komponenten fanger på verten; på mobil en stablet mal med 44 px-knapper. Pause bak flagget `pause`.
- **Tilganger (8.4, skjerm 12)** `gp-access-settings`: invitasjonskort (e-post, omfang «All servers» + eierens tagger,
  «Invite» → toast «Invitation sent»), grid med initialer, e-post, badge Reader, omfang, «invited · not accepted yet»
  i oransje, «Remove access». `/access/accept?token=` (`gp-accept-page`, innlogget rute – authGuard sender til
  `/login?next=`) → `POST /api/access/accept` → toast «You now have read access to N servers» → oversikten.
  Leser-opplevelsen: kortet og serversiden viser «shared by eier@…», ingen «Add», ingen varselinnstillinger, ingen
  redigering; huben håndhever 403 uansett. Grupper er personlige (leseren lager egne av nodene de ser).
- **Abonnement (8.5, skjerm 13)** `gp-subscription-settings`: grønt kort «Free in beta» med tre chips og «per node»,
  kortet «What it would cost today» (rabattert pris stort, full pris gjennomstreket, «per year», rabattlinje bare for
  tidlig-kontoer, «N × 12 USD · 60 days notice …», «Payment options appear here when pricing starts»).
- **Data (8.6, skjerm 13)** `gp-data-settings`: «Download everything» henter `GET /api/account/export` og lagrer som
  `Blob` (`glimtpanel-export.json`, virker i PWA); «Delete everything» åpner samme dialog som Konto.

Vitest: `settings-helpers.spec.ts` (tidssoner med offset, tilgangsrader). Playwright: `settings-account.spec.ts`
(skjerm 9), `settings-servers.spec.ts` (skjerm 11), `settings-access.spec.ts` (skjerm 12 og 18: leseren i egen
kontekst, 403 fra huben, ugyldig akseptlenke), `settings-data.spec.ts` (skjerm 13 med nedlasting) i tre prosjekter.

## Dockerfile

Bygg-kontekst er repo-roten, slik Dokploy og `npm run build:images` gjør det:

```
docker build -f apps/glimt-web/Dockerfile -t glimt-web:local .
docker run --rm -p 8080:80 -e GLIMT_HUB_INTERNAL_URL=http://host.docker.internal:5080 glimt-web:local
```

1. `node:26-alpine`: kopierer workspace-manifestene, `npm ci --workspace apps/glimt-web`, kopierer
   `packages/design-tokens` og `apps/glimt-web`, `ng build --configuration production`.
2. `nginx:1.27-alpine`: statiske filer i `/usr/share/nginx/html`, `default.conf.template` i `/etc/nginx/templates`
   (nginx-imaget kjører `envsubst` på den ved oppstart; `NGINX_ENVSUBST_FILTER=GLIMT_` gjør at kun `GLIMT_*`
   byttes ut), `10-glimt-resolver.envsh` og `40-glimt-config.sh` i `/docker-entrypoint.d`, `HEALTHCHECK` mot `/`,
   port 80.

nginx: `/api/` og `/hub/` proxyes til `GLIMT_HUB_INTERNAL_URL` (standard `http://glimt-hub:8080`, uten skråstrek
på slutten) med WebSocket-oppgradering og 1 times timeout; SPA-fallback til `index.html`; gzip; `immutable`-cache
for hashede filer; `no-store` for `config.json`; `X-Content-Type-Options` og `Referrer-Policy` på alle svar.
Hub-navnet slås opp ved kjøretid (nginx `resolver`), slik at web starter selv om huben ikke er oppe ennå og følger
med når hub-containeren får ny IP etter en utrulling. Resolveren hentes fra containerens `/etc/resolv.conf`
(`127.0.0.11` på brukerdefinerte Docker-nettverk som i Dokploy) og kan overstyres med `GLIMT_DNS_RESOLVER`.
nginx leser ikke `/etc/hosts`: på Linux med `--add-host host.docker.internal:host-gateway` må hub-adressen gis som
IP eller som containernavn på et felles nettverk.
