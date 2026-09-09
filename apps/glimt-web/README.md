# glimt-web

Dashbordet til Glimtpanel: Angular 22 (standalone, zoneless, OnPush), ren CSS med delte tokens fra
`@glimt/design-tokens`, SignalR mot huben. Fase 3 er på plass: layout-skallet (steg 3.3), ordboken (3.2),
kjerne-tjenestene (3.4), felleskomponentene med `/dev/components` (3.5) og auth-skjermene (3.6). Oversikten på `/`
er fortsatt en midlertidig liste; serverkortet kommer i fase 4.

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
│       │   ├── session.service.ts           # bruker, tilgangstoken, login/logout/refresh, isOwnerOf
│       │   ├── live.service.ts              # SignalR (/hub/live): refcount-abonnement, adaptivt intervall, logger
│       │   ├── live.store.ts                # signal per server (Card/Server), siste-time-ring
│       │   ├── activity.service.ts, connection.service.ts, prefs.service.ts, clipboard.service.ts, alert.store.ts
│       │   ├── guards.ts                    # authGuard, guestGuard, ownerGuard, devGuard
│       │   ├── live.reducer.ts              # rene funksjoner fra skjelettet (applyServerStatus, sortServers)
│       │   └── live.types.ts                # DTO-ene fra huben (CardDto, ServerDto, UserDto, …)
│       ├── shell/                           # layout-skallet (steg 3.3): shell, auth-shell, sidebar, topbar, bottom-nav, nav.service, title.service
│       ├── shared/                          # felleskomponenter (gp-*), se under
│       ├── i18n/                            # en.json, no.json, nav-icons.ts
│       ├── dev/components.page.ts           # /dev/components: alle komponentene i alle tilstander (kun utvikling)
│       └── features/
│           ├── auth/                        # /login, /register, /confirm, /forgot, /reset (steg 3.6)
│           └── overview/                    # midlertidig oversikt (rute `/`)
├── scripts/i18n-check.mjs                   # `npm run i18n:check`: nøkkelsett og ukjente nøkler i maler
├── public/                                  # favicon.svg; config.json genereres hit (git-ignorert)
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
`formatGb`, `formatDuration`, `formatDurationClock`, `formatTime` (Intl, 24 t, valgfri tidssone) og `BreakpointService`
(`isMobile`-signal fra en ResizeObserver på rot-elementet, < 760 px).

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
