# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Hva dette er

Glimtpanel: ett nettleservindu som viser hva alle Ubuntu-serverne dine gjør akkurat nå. Monorepo med npm workspaces:

| Del | Sti | Teknologi |
|---|---|---|
| glimt-agent | `apps/glimt-agent` | Go 1.25, statisk binær. Bygges og testes **kun i Docker** (Go trengs ikke lokalt). |
| glimt-hub | `apps/glimt-hub` | .NET 10 minimal API, SignalR, MongoDB.Driver, MessagePack. `TreatWarningsAsErrors`. |
| glimt-web | `apps/glimt-web` | Angular 22 (standalone, zoneless, OnPush, signals), ren CSS, AG Grid Community, Vitest. |
| glimt-site | `apps/glimt-site` | Astro-skall med blank forside. Utsatt av eier, ikke rør uten beskjed. |
| packages/protocol | JSON Schema for agent ↔ hub (v1) + eksempler. Kontrakten begge sider testes mot. |
| packages/design-tokens | `tokens.css` og Inter-fonter, delt av web og site. |
| e2e | Playwright i tre prosjekter: `desktop-chromium`, `mobile-webkit`, `mobile-chromium`. |
| infra | `infra/<app>/` | Dockerfile (med agentbinæren innebygd, startes bare når `GLIMT_TOKEN` er satt) og nginx-filer for Dokploy (hub, web, site), git-ignorerte `.env.dev`/`.env.prod` med verdiene per miljø, og `infra/glimt-agent/README.md` om agentutgivelser. |

Dokumentasjonen (`IMPLEMENTERINGSPLAN.md`, `FUNKSJONSBESKRIVELSE.md`, `DESIGN.md`, `VURDERING.md`, `MARKEDSANALYSE.md`, `design/`)
ligger **lokalt og er git-ignorert**. `IMPLEMENTERINGSPLAN.md` er fasit for faser og steg; kode og READMEs refererer til den
(«steg 2.6», «skjerm 3», «FB 6.6», «D 10.6»). Hver app har en README som er den levende beskrivelsen av hva som er bygget.
Oppdater den når du legger til eller endrer noe vesentlig.

## Kommandoer

Alt kjøres fra repo-roten. `npm install` først. Krav: Node 22+, .NET SDK 10, Docker Desktop.

```sh
npm run doctor                  # sjekker verktøyene
npm run dev                     # hub (dotnet watch, :5080) + agent-container + web (ng serve, :4200). Flagg: --no-agent --no-web --no-hub --site --plain-agent --sidecar
npm run dev:hub | dev:web | dev:agent | dev:site
npm run dev:stop                # stopper container og løpende prosesser
npm test                        # test:web + test:hub + test:agent
npm run lint                    # angular-eslint + dotnet format --verify-no-changes
npm run test:infra              # containertestene i infra/tests (node:test + Docker): imagene, agenten i imagene, installasjon
npm run build:images            # Docker-imagene slik Dokploy bygger dem (kontekst = repo-rot)
```

Enkelttester og per-app-verktøy:

```sh
# web (Vitest, jsdom)
npm --workspace apps/glimt-web test -- --watch=false --include src/app/core/live.store.spec.ts
npm --workspace apps/glimt-web test -- --watch=false --filter 'LiveStore'
npm --workspace apps/glimt-web run i18n:check      # en.json/no.json har samme nøkler, ingen ukjente t('…')

# hub (xUnit + WebApplicationFactory; Auth/Account/Servers/Access-testene trenger Docker for Testcontainers mongo:8)
dotnet test apps/glimt-hub/Glimt.Hub.slnx --filter "FullyQualifiedName~BufferTests"
GLIMT_SKIP_SLOW_TESTS=1 dotnet test apps/glimt-hub/Glimt.Hub.slnx
dotnet format apps/glimt-hub/Glimt.Hub.slnx        # fiks formatering før commit
dotnet run --project apps/glimt-hub/src/Glimt.Hub -- vapid-keys

# agent (alltid i golang:1.25-container; npm run test:agent kjører gofmt + go vet + go test ./...)
docker run --rm -v "$PWD/apps/glimt-agent":/src -w /src -v glimt-go-cache:/go/pkg/mod -v glimt-go-build:/root/.cache/go-build \
  -e CGO_ENABLED=0 golang:1.25 go test ./internal/collect/ -run TestDisk
npm run dev:agent -- --logs | --shell | --measure   # journal, bash eller systemd-cgtop i containeren
node scripts/agent-container.mjs --sidecar | --sidecar-check | --sidecar-snapshot | --sidecar-logs | --sidecar-stop   # containernode (fase 12)
docker exec glimt-agent-dev glimt-agent snapshot     # én snapshot-melding som JSON

# protokoll
npm --workspace packages/protocol test

# e2e (npx playwright install chromium webkit første gang)
npm run test:e2e
npm --workspace e2e test -- overview                          # filnavn-filter
npm --workspace e2e test -- --project desktop-chromium -g "tom oversikt"
npm --workspace e2e test -- components --update-snapshots     # etter designendringer
npm --workspace e2e run report
```

E2E gjenbruker kjørende servere fra `npm run dev`. Uten dem starter Playwright hub (`GLIMT_ENV=e2e`) og web selv og
spinner opp en `mongo:8`-container med tilfeldig port (se `e2e/playwright.config.ts` og `e2e/mongo.ts`). Er port 4200
opptatt av noe annet (`lsof -nP -iTCP:4200`), kjør med `GLIMT_WEB_PORT=4210`, ellers treffer testene feil server. En
gjenglemt hub på 5080 uten MongoDB stopper kjøringen med melding; `npm run dev:stop` rydder den.

## Miljø

- Alle nøkler har prefiks `GLIMT_` og er dokumentert i `example.env` (eneste env-fil som sjekkes inn).
- `.env` = Docker-containere lokalt, `.env.dev` = hub og web direkte på maskinen (her ligger ekte `GLIMT_MONGO_URI`,
  db `GlimtpanelDev`). Dokploy-verdiene ligger i `infra/<app>/.env.dev` (branch `opd`, `dev-*.glimtpanel.com`) og
  `infra/<app>/.env.prod` (branch `main`, `*.glimtpanel.com`); begge kjører `GLIMT_ENV=production`. `scripts/env.mjs` laster `.env` og deretter `.env.<profil>`;
  variabler som allerede finnes i miljøet vinner. Huben gjør det samme selv (`DotEnv.LoadIfNeeded`) utenom produksjon,
  så `dotnet run`/`dotnet test` virker fra et hvilket som helst skall.
- `GLIMT_ENV` er `development` | `e2e` | `production`. Utenom produksjon: dev-nøkkel `GLIMT_DEV_ENROL_KEY` godtas evig,
  dev-bruker seedes, `/api/dev/*` finnes, lesbar logg. `e2e` slår i tillegg på demomodus (16 falske servere),
  seedede tall, flyttbar klokke og `/api/e2e/*`.
- Web leser **aldri** miljø ved byggetid. `scripts/web-config.mjs` skriver `apps/glimt-web/public/config.json`
  (git-ignorert) som `ConfigService` henter ved oppstart; i containeren gjør `infra/glimt-web/40-glimt-config.sh` det samme.
- Huben starter og svarer på `/healthz` selv uten MongoDB (servere lever da bare i minnet); `/readyz` gir 503 uten.

## Arkitektur

```
glimt-agent ──WebSocket /agent/ws (JSON, packages/protocol)──► glimt-hub ◄──SignalR /hub/live + REST /api──► glimt-web
                                                                  │ MongoDB.Driver
                                                                  ▼
                                                     MongoDB: brukere, servere, nøkler, tilganger, varsler
```

Regler som aldri brytes (IMPLEMENTERINGSPLAN 4.1):

1. Agenten har ingen skrivekommandoer i protokollen. Den kan ikke endre noe på serveren.
2. Måledata går agent → hub → nettleser i minnet. **MongoDB ser aldri et måledatapunkt.**
3. Logger videresendes kun mens en loggvisning er åpen, og lagres ikke i huben.
4. 1 s-strømmen (`stream`) går bare når noen ser. 30 s-øyeblikksbildet (`snapshot`) går alltid og driver buffer og varsler.

**Hub.** `Program.cs` er liten: `GlimtOptions` fra miljø, så `Add*Feature()`/`Map*Feature()` per mappe under
`Features/` (Auth, Account, Access, Agents, Alerts, Buffer, Live, Servers, Demo, Health). Tverrgående ting i `Infrastructure/`
(Mongo, JWT, e-post bak `IEmailSender`, `IAccessService`, `IServerLifecycle` som kobler Servers/Account → Agents,
`RequireDatabase`-filter som gir 503). Alt sanntid er prosessminne: `AgentRegistry`/`AgentSession`, `ServerBuffer`
(ring 2 880 × 30 s per server, MessagePack til `GLIMT_BUFFER_PATH/buffer.bin` hvert 15. min og ved stopp),
`SubscriptionCounter` (0→1 abonnent sender `subscribe` til agenten, 1→0 `unsubscribe`), `LogRelay` (streamId bundet
til én SignalR-tilkobling). `AgentIngest` er ett inngangspunkt for alt agenten sender; demomodusens `FakeAgentService`
skriver rett inn der uten WebSocket. SignalR-projeksjonene er `Card` (< 600 byte, oversikten) og `Server` (alt for én
server). Varsler: `AlertEngine` (tilstand per server/regel/instans, evalueres på hvert `snapshot`, sveip hvert 10. s for
`server_down` og påminnelser) → `IAlertSink` (`LiveAlertSink` sender `Alert(event)` til gruppen `alerts:{userId}` som alle
tilkoblinger er med i; `NotificationDispatcher` → `IChannel`: push (egen RFC 8030/8291/8292-klient i `Alerts/Push`),
e-post via `IEmailSender`, webhook). Tilgang avgjøres alltid gjennom `IAccessService` (synlig = egne servere ∪ servere hos eiere som har gitt meg
tilgang med `all` eller taggoverlapp). Hemmeligheter (agent-token, engangsnøkler, oppfriskningstokens) lagres kun som hash.
Tidsavhengig kode bruker `TimeProvider` (testene bruker `FakeTimeProvider`/`ShiftableTimeProvider`).

**Web.** Nettleseren snakker same-origin: `proxy.conf.mjs` (ng serve) og nginx i containeren sender `/api` og `/hub`
til `GLIMT_HUB_INTERNAL_URL`, så ingen CORS. `core/` har kjernen: `ApiService` (fetch + Bearer + ett refresh-forsøk ved
401, ProblemDetails → `ApiError`), `SessionService` (JWT 15 min i minnet, oppfriskning via httpOnly-cookie),
`LiveService` (én HubConnection, refcountede abonnementer, `SetInterval` 1000/5000 styrt av `ActivityService`),
`LiveStore` (én signal per server + siste-time-ring som fylles av `Card`), `live.reducer.ts` (rene funksjoner).
Ruter i `app.routes.ts` er alle lazy; innloggede sider under `ShellComponent`, auth-sider under `AuthShellComponent`,
`/demo` har eget skall. `/dev/components` viser alle felleskomponenter i alle tilstander og fotograferes i e2e.
Sti-alias: `@core/*`, `@shared/*`, `@i18n/*`, `@features/*`.

**Agent.** `cmd/glimt-agent` (run, check, snapshot, stream, logs, uninstall) og `internal/` (collect fra /proc og
systemctl, docker via socket/proxy og cgroup v2, journal, logs-manager, ws-klient med backoff og sendekø, sched (testet
med `testing/synctest`), protocol som speiler skjemaet, health for helse-URL og TCP-sjekker). `--kind auto|server|container`:
containerprofilen (fase 12) leser `GLIMT_TOKEN` fra miljøet, måler cgroup eller summerer prosesser (`approx`), haler filer
fra `GLIMT_LOG_PATHS` og sender `bye` ved stopp; `Dockerfile.sidecar` er `FROM scratch` med uid 65532. Parsere testes mot fixtures i `internal/collect/testdata/`.
Dev-containeren (`Dockerfile.dev`) er Ubuntu 24.04 med systemd som PID 1, fordi macOS mangler /proc, journald og cgroup v2.

## Konvensjoner

- **Git:** kun `README.md` og denne filen av markdown-filer, og kun `example.env` av env-filer, sjekkes inn.
  `.gitignore` og `.githooks/pre-commit` (`git config core.hooksPath .githooks`) håndhever det. Hovedgren for PR-er
  er `dev`; arbeidsgren `opd`.
- **Språk:** dokumentasjon, READMEs, kodekommentarer og commit-meldinger er på norsk («Fase 4: oversikten med …»).
  Kode, identifikatorer og standardspråket i UI er engelsk. Ordboken `i18n/en.json` + `no.json` må ha identisk
  nøkkelsett; tekster med tall bygges av deler i malene (`{{ n }} {{ 'servers' | t }}`), ikke setningsmaler.
- **Angular:** standalone, `OnPush` (lint-feil ellers), signal-inputs, selektorprefiks `gp-`, ingen `any`, ingen
  `console.log` (`warn`/`error` er ok). Ren CSS med tokens fra `@glimt/design-tokens`; ingen Tailwind, Sass eller
  komponentbibliotek. `[style.--x]`-variabler i maler er tillatt. Felleskomponenter importeres fra `@shared/index`,
  unntatt `gp-data-grid` (direkte sti, så AG Grid havner i en lat chunk). Bevegelse: «data glir, dekor står stille»,
  alt av ved `prefers-reduced-motion`.
- **Mobil:** hver skjerm skal virke på 1440 px og 390 px. `e2e/helpers/mobile-rules.ts` håndhever ingen horisontal
  scroll og klikkflater ≥ 44×44 px (`data-touch-exempt` for bevisste unntak). E2E kjører alltid i alle tre prosjekter;
  skjermbilder ligger i `e2e/tests/*-snapshots/` og levende tall maskeres.
- **Protokollendringer** gjøres i `packages/protocol/agent-hub.schema.json` + `examples/` først; både
  `internal/protocol` (Go) og `Features/Agents/Protocol` (.NET) har tester mot eksemplene.
- **«Ferdig»** betyr: kjører lokalt med `npm run dev`, tester grønne, lint ren, skjermen sjekket i begge bredder.
