# glimt-hub

Huben i Glimtpanel (.NET 10, minimal API). Tar imot agentene over WebSocket, holder agentregisteret i minnet,
sender sanntid til nettleseren over SignalR og bruker MongoDB til brukere, servere og nøkler. Måledata går
aldri innom databasen (IMPLEMENTERINGSPLAN kapittel 4).

Dette er «det gående skjelettet» fra steg 0.9, bygget i den formen som skal leve videre (steg 2.1, 2.5, 2.7):
`hello` → `welcome`, register, `ServerStatus` til oversikten, nede-deteksjon, dev-seed og helsesjekk.
Auth, buffer, varsler og projeksjoner kommer i fase 2 og 7.

## Kjøre

```sh
npm run dev:hub                                             # fra rot: laster .env/.env.dev og kjører dotnet watch
dotnet run --project apps/glimt-hub/src/Glimt.Hub           # direkte; leser .env og .env.dev selv (se under)
dotnet run --project apps/glimt-hub/src/Glimt.Hub -- vapid-keys   # skriver GLIMT_VAPID_PUBLIC/PRIVATE og avslutter
```

Huben leser bare miljøvariabler. Som en bekvemmelighet for utvikling: hvis `GLIMT_MONGO_URI` ikke er satt og
`GLIMT_ENV` ikke er `production`, finner den repo-roten (mappen med `example.env`) og laster `.env` og deretter
`.env.dev` (siste vinner, variabler som allerede finnes i miljøet vinner alltid). Det er samme regel som
`scripts/env.mjs`, så `dotnet run` og `dotnet test` virker fra et hvilket som helst skall.

Huben starter og svarer på `/healthz` selv om MongoDB ikke kan nås. Da logges en advarsel, `mongo` i helsesjekken
er `unavailable`, dev-brukeren seedes ikke og servere lagres bare i minnet. Tilkoblingen prøves på nytt hvert 30. sekund.

## Teste og bygge

```sh
dotnet test apps/glimt-hub/Glimt.Hub.slnx                          # xUnit, trenger ikke MongoDB
dotnet build apps/glimt-hub/Glimt.Hub.slnx -warnaserror
dotnet format apps/glimt-hub/Glimt.Hub.slnx --verify-no-changes    # kjøres i CI (lint)
docker build -f apps/glimt-hub/Dockerfile -t glimt-hub:local .     # fra repo-rot
```

Testene starter huben i prosessen med `WebApplicationFactory` og en uoppnåelig Mongo-adresse. De dekker
`/healthz`, agent-WebSocket (innrullering med dev-nøkkel, gjenoppkobling med token, avvist nøkkel/token,
snapshot, rammegrense), SignalR (`SubscribeOverview` → `ServerStatus`), at alle eksemplene i
`packages/protocol/examples/` deserialiseres til riktig record, `PasswordHasher`, `DotEnv`, `GlimtOptions`
og `vapid-keys`.

Docker-imaget kjører som bruker `app` på port 8080 med `GLIMT_HUB_URL=http://0.0.0.0:8080`, volum `/data`
(buffer i `/data/buffer`) og `HEALTHCHECK` mot `/healthz`.

## Miljøvariabler

Alle har prefiks `GLIMT_` og er beskrevet i `example.env`. Huben bruker:

| Nøkkel | Påkrevd | Standard | Bruk |
|---|---|---|---|
| `GLIMT_MONGO_URI`, `GLIMT_MONGO_DB` | ja | – | MongoDB |
| `GLIMT_JWT_SECRET` | ja | – | Signering av tilgangstoken (steg 2.2) |
| `GLIMT_ENV` | | `development` | `development`, `e2e` eller `production`. Utenom produksjon: dev-nøkkel godtas, dev-bruker seedes, CORS for web, lesbar logg. I produksjon: JSON-logg |
| `GLIMT_HUB_URL` | | `http://localhost:5080` | Adressen Kestrel lytter på |
| `GLIMT_HEARTBEAT_SECONDS` | | `30` | `ping` til agenten når det er stille, og `snapshotInterval` i `welcome` |
| `GLIMT_DOWN_AFTER_SECONDS` | | `120` | Frakoblet server settes til `down` etter så mange sekunder |
| `GLIMT_DEV_ENROL_KEY` | | – | Evig innrulleringsnøkkel (kun `development`/`e2e`). Gir serverId `dev-<hostname>` |
| `GLIMT_DEV_USER_EMAIL`, `GLIMT_DEV_USER_PASSWORD` | | – | Utviklerkonto som seedes i `users` (kun `development`/`e2e`) |
| `GLIMT_WEB_PUBLIC_URL` | | – | CORS-opprinnelse for SignalR utenom produksjon (web proxyer `/hub` uansett) |
| `GLIMT_HUB_PUBLIC_URL`, `GLIMT_INSTALL_URL`, `GLIMT_DOCS_URL`, `GLIMT_AGENT_VERSION` | | – | Installasjonsskript og lenker (steg 1.11) |
| `GLIMT_BUFFER_PATH` | | – | 24-timersbufferen (steg 2.6) |
| `GLIMT_DEMO_MODE` | | `false` | Demomodus (steg 2.10) |
| `GLIMT_APPMAIL_URL`, `GLIMT_APPMAIL_API_KEY`, `GLIMT_MAIL_FROM` | | – | E-post (steg 7.2) |
| `GLIMT_VAPID_PUBLIC`, `GLIMT_VAPID_PRIVATE`, `GLIMT_VAPID_SUBJECT` | | – | Web Push (steg 7.2) |

Mangler en påkrevd nøkkel, stopper huben med en melding som lister dem, før noe annet starter.

## Endepunkter

| Sti | Hva |
|---|---|
| `GET /healthz` | `{ status, version, env, mongo: "ok" \| "unavailable", agentsConnected, uptimeSec }` |
| `GET /install` | Installasjonsskript for agenten (plassholder til steg 1.11), `text/plain` |
| `WS /agent/ws` | Agentprotokollen v1 (`packages/protocol/agent-hub.schema.json`): første melding må være `hello` innen 10 s, maks 1 MB per ramme, tekstrammer |
| `SignalR /hub/live` | `SubscribeOverview()` / `UnsubscribeOverview()`; huben sender `ServerStatus(dto)` med `{ id, name, hostname, status, lastSeenAt, connected, agentVersion, os, arch, cores, ramBytes }`. Anonym til steg 2.7 |

Agentflyt: `hello` med `enrolKey` (dev-nøkkelen nå, engangsnøkler fra `enrolKeys` i steg 2.4) gir `welcome` med et
nytt token `agt_…`; bare SHA-256-hashen lagres. `hello` med kjent `token` gir `welcome` uten token. Ellers `authFailed`
med `invalidKey` eller `invalidToken` og lukking. `pong`, `snapshot` og `stream` oppdaterer «sist sett»; de to siste
lagres rått på sesjonen til buffer og projeksjoner kommer.

## Struktur

```
Glimt.Hub.slnx, Directory.Build.props, Dockerfile
src/Glimt.Hub/
  Program.cs                 # liten: options, logging, features
  Infrastructure/            # GlimtOptions, DotEnv, MongoContext, LoggingSetup, PasswordHasher, VapidKeys
  Features/Health/           # /healthz
  Features/Agents/           # /agent/ws: Protocol/ (records + JSON), AgentConnection, AgentRegistry, AgentAuthenticator, DownDetector
  Features/Live/             # SignalR LiveHub, ServerStatusDto, CORS
  Features/Servers/          # servers/users-dokumenter, MongoServerStore, MongoIndexes, DevSeeder, /install
tests/Glimt.Hub.Tests/       # xUnit + WebApplicationFactory
```
