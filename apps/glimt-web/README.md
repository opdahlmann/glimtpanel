# glimt-web

Dashbordet til Glimtpanel: Angular 22 (standalone, zoneless, OnPush), ren CSS med delte tokens fra
`@glimt/design-tokens`, SignalR mot huben. Dette er det gående skjelettet fra IMPLEMENTERINGSPLAN steg 0.9:
én side som lister tilkoblede agenter live. Layout-skall, i18n og felleskomponenter kommer i fase 3–4.

## Struktur

```
apps/glimt-web/
├── src/
│   ├── index.html, main.ts, styles.css      # styles.css importerer tokens.css og fonts.css
│   └── app/
│       ├── app.ts, app.config.ts, app.routes.ts
│       ├── core/
│       │   ├── config.service.ts            # /config.json -> signal `config`
│       │   ├── live.service.ts              # SignalR-forbindelse (/hub/live), `state` og `servers`
│       │   ├── live.reducer.ts              # rene funksjoner: applyServerStatus, sortServers
│       │   └── live.types.ts                # ServerStatusDto, LiveState
│       └── features/overview/               # midlertidig oversikt (rute `/`)
├── public/                                  # favicon.svg; config.json genereres hit (git-ignorert)
├── nginx/default.conf.template              # nginx i containeren, ${GLIMT_HUB_INTERNAL_URL} fylles inn ved start
├── nginx/10-glimt-resolver.envsh            # entrypoint: DNS-resolver for hub-oppslag fra /etc/resolv.conf
├── nginx/40-glimt-config.sh                 # entrypoint-skript som skriver config.json fra GLIMT_*-env
├── proxy.conf.mjs                           # dev-proxy for ng serve
├── Dockerfile                               # bygg-kontekst = repo-rot
└── angular.json, tsconfig*.json, eslint.config.js
```

Sti-alias: `@core/*`, `@shared/*`, `@i18n/*`, `@features/*` (tsconfig.json). Komponentprefiks er `gp-`.

## Kjøre, teste, linte

Alt kjøres fra repo-roten (npm workspaces). `npm install` i roten først.

| Hva | Kommando |
|---|---|
| Dev-server med proxy | `npm run dev:web` (lager config.json og starter `ng serve` på 4200), eller `npm --workspace apps/glimt-web run start -- --port 4200` |
| Hele stacken | `npm run dev` (hub + agent-container + web, se scripts/dev.mjs) |
| Produksjonsbygg | `npm --workspace apps/glimt-web run build` → `dist/glimt-web/browser` |
| Enhetstester (Vitest, jsdom) | `npm --workspace apps/glimt-web test -- --watch=false` |
| Lint (angular-eslint) | `npm --workspace apps/glimt-web run lint` |

Tester ligger ved siden av koden som `*.spec.ts`. Reduksjonslogikken i `live.reducer.ts` testes uten SignalR;
`ConfigService` testes med mocket `fetch`.

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

## Live-forbindelsen

`LiveService` bygger en `HubConnection` mot `config.hubUrl` med `withAutomaticReconnect([0, 2000, 5000, 10000, 30000])`,
eksponerer `state` (`connecting | connected | reconnecting | disconnected`) og `servers` (sortert på navn), lytter på
`ServerStatus(dto)` og kaller `SubscribeOverview` etter tilkobling og gjenoppkobling. Feiler første tilkobling, eller
gir gjenoppkoblingen opp, prøves en ny full tilkobling hvert 5. sekund til `stop()` kalles. Oversiktssiden kaller
`start()` ved init og `stop()` ved destroy.

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
