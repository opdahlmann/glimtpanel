# glimt-hub

Huben i Glimtpanel (.NET 10, minimal API). Tar imot agentene over WebSocket, holder agentregisteret i minnet,
sender sanntid til nettleseren over SignalR og bruker MongoDB til brukere, servere og nøkler. Måledata går
aldri innom databasen (IMPLEMENTERINGSPLAN kapittel 4).

Dette er «det gående skjelettet» fra steg 0.9, bygget i den formen som skal leve videre (steg 2.1, 2.5, 2.7):
`hello` → `welcome`, register, `ServerStatus` til oversikten, nede-deteksjon, dev-seed og helsesjekk.
Fase 2 del A er på plass: auth (steg 2.2), konto og plasser (2.3), servere og nøkler (2.4), tilganger (2.8),
Ubuntu-støtte, eksport og sletting (2.9). Del B også: agentregister med engangsnøkler, rotasjon og loggrelé (2.5),
ringbuffer med historikk og lagring (2.6), SignalR-projeksjonene `Card`/`Server` med MessagePack (2.7) og demo-/e2e-modus
(2.10). Fase 7 gir varselmotoren, kanalene (egen Web Push, e-post, webhook), daglig oppsummering og endepunktene for
varsler og varselinnstillinger (steg 7.1–7.2), se «Varsler» under.

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
dotnet test apps/glimt-hub/Glimt.Hub.slnx                          # xUnit; Auth/Account/Servers/Access-testene trenger Docker (Testcontainers)
dotnet build apps/glimt-hub/Glimt.Hub.slnx -warnaserror
dotnet format apps/glimt-hub/Glimt.Hub.slnx --verify-no-changes    # kjøres i CI (lint)
docker build -f infra/glimt-hub/Dockerfile -t glimt-hub:local .     # fra repo-rot
```

Testene starter huben i prosessen med `WebApplicationFactory`. De uten database bruker en uoppnåelig Mongo-adresse
og dekker `/healthz`, agent-WebSocket (innrullering med dev-nøkkel, gjenoppkobling med token, avvist nøkkel/token,
snapshot, rammegrense), rotasjon og sletting via `IServerLifecycle` (`AgentsLifecycleTests`, med `FakeTimeProvider`),
SignalR (`LiveHubTests`, `LiveProjectionTests`: `Card`/`Server` fra en falsk agent over JSON og MessagePack, abonnentteller,
`SetInterval`, loggrelé begge veier, 403 for fremmed server), bufferen (`BufferTests`: sirkulær skriving, 1h/24h med hull,
nedsampling, MessagePack-rundtur, fil-lagring i en temp-mappe, `/history`-endepunktet og en minnetest for 1 000 fulle
buffere som hoppes over når `CI` eller `GLIMT_SKIP_SLOW_TESTS` er satt), demomodus (`DemoModeTests`: 16 kort på under 2 s,
demotoken, `/api/e2e/*`), at alle eksemplene i `packages/protocol/examples/` deserialiseres til riktig record,
`PasswordHasher`, `DotEnv`, `GlimtOptions` og `vapid-keys`. Testfabrikken kjører med `GLIMT_ENV=e2e`, så demomodus
(16 falske servere) er på i alle testhuber. `AuthTests`, `AccountTests`, `ServersTests` og `AccessTests` kjører mot én delt MongoDB-container
(`MongoTestServer`, `mongo:8`) med egen database per testklasse (`TestHub`); e-postsenderen og `IServerLifecycle`
er byttet ut med opptakere, og `TestUsers.RegisterAndConfirmAsync` registrerer og bekrefter brukere gjennom endepunktene.

Docker-imaget (`infra/glimt-hub/Dockerfile`) kjører som bruker `app` på port 8080 med `GLIMT_HUB_URL=http://0.0.0.0:8080`, volum `/data`
(buffer i `/data/buffer`) og `HEALTHCHECK` mot `/healthz`.

## Miljøvariabler

Alle har prefiks `GLIMT_` og er beskrevet i `example.env`. Huben bruker:

| Nøkkel | Påkrevd | Standard | Bruk |
|---|---|---|---|
| `GLIMT_MONGO_URI`, `GLIMT_MONGO_DB` | ja | – | MongoDB |
| `GLIMT_JWT_SECRET` | ja | – | Signering av tilgangstoken (15 min, HS256 med SHA-256 av hemmeligheten) |
| `GLIMT_ENV` | | `development` | `development`, `e2e` eller `production`. Utenom produksjon: dev-nøkkel godtas, dev-bruker seedes, CORS for web, lesbar logg. I produksjon: JSON-logg |
| `GLIMT_HUB_URL` | | `http://localhost:5080` | Adressen Kestrel lytter på |
| `GLIMT_HEARTBEAT_SECONDS` | | `30` | `ping` til agenten når det er stille, og `snapshotInterval` i `welcome` |
| `GLIMT_DOWN_AFTER_SECONDS` | | `120` | Frakoblet server settes til `down` etter så mange sekunder |
| `GLIMT_DEV_ENROL_KEY` | | – | Evig innrulleringsnøkkel (kun `development`/`e2e`). Gir serverId `dev-<hostname>` |
| `GLIMT_DEV_USER_EMAIL`, `GLIMT_DEV_USER_PASSWORD` | | – | Utviklerkonto som seedes i `users` (kun `development`/`e2e`). Kan logge inn med passordet, og eier servere uten `ownerId` (dev-nøkkelen) |
| `GLIMT_WEB_PUBLIC_URL` | | – | Lenker i e-post (`/confirm`, `/reset`, `/access/accept`) og CORS-opprinnelse for SignalR utenom produksjon |
| `GLIMT_HUB_PUBLIC_URL`, `GLIMT_INSTALL_URL`, `GLIMT_DOCS_URL`, `GLIMT_AGENT_VERSION` | | – | Installasjonsskript og lenker; `GLIMT_INSTALL_URL` (standard `GLIMT_HUB_PUBLIC_URL/install`) brukes i kommandoen fra `POST /api/servers/enrol-key` |
| `GLIMT_AGENT_IMAGE` | | `ghcr.io/opdahlmann/glimt-agent:latest` | Sidecar-imaget i snuttene fra `POST /api/servers` |
| `GLIMT_DEV_CONTAINER_TOKEN` | | – | Utenom produksjon: containernoden `sidecar-dev` på dev-kontoen får hashen av dette tokenet (`npm run dev -- --sidecar`) |
| `GLIMT_BUFFER_PATH` | | – | Mappe for `buffer.bin` (24-timersbufferen). Tom = ingen lagring, bufferen lever bare i minnet |
| `GLIMT_UNLIMITED_EMAILS` | | – | Kommaseparerte e-postadresser som alltid har planen `unlimited`: ingen plasser telles og ingen pris i `GET /api/subscription`. Legges på ved lesing i `UserStore`, lagres aldri; fjernes adressen, er kontoen tilbake på lagret plan ved neste omstart |
| `GLIMT_DEMO_MODE` | | `false` | Demomodus: 16 falske servere på demokontoen og `POST /api/demo/session`. Alltid på når `GLIMT_ENV=e2e` |
| `GLIMT_APPMAIL_URL`, `GLIMT_APPMAIL_API_KEY`, `GLIMT_MAIL_FROM` | | – | E-post via appmail. Tom URL = `ConsoleEmailSender` (e-posten med lenken logges) |
| `GLIMT_VAPID_PUBLIC`, `GLIMT_VAPID_PRIVATE`, `GLIMT_VAPID_SUBJECT` | | – | Web Push (steg 7.2): P-256-paret fra `vapid-keys` (base64url, rå 65-byte punkt og 32-byte skalar) og `mailto:`-adressen i VAPID-tokenet. Tomme = push av, med en advarsel ved oppstart; alt annet virker |

Mangler en påkrevd nøkkel, stopper huben med en melding som lister dem, før noe annet starter.

## Endepunkter

| Sti | Hva |
|---|---|
| `POST /api/client-errors` | – | `{ message?, stack?, url?, userAgent?, version? }` fra nettleserens globale feilhåndterer (steg 9.5): logges som advarsel (avkortet), lagres ikke, 204. Egen policy `errors` (20/min per adresse) |
| `GET /readyz` | `ready` (200) med database, 503 uten. Helsesjekk for Dokploy/swarm. |
| `GET /healthz` | `{ status, version, env, mongo: "ok" \| "unavailable", agentsConnected, uptimeSec, demoMode, buffer: { servers, points, lastSavedAt } }` (`agentsConnected` teller ekte agenter, ikke demoservere) |
| `GET /install` | Agentens `install.sh` (bakt inn fra `apps/glimt-agent/install/`) med denne hubens `wss://…/agent/ws` og `GLIMT_AGENT_VERSION` som standard, `text/plain`, cache 1 t. `get.glimtpanel.com` peker hit (steg 11.3) |
| `WS /agent/ws` | Agentprotokollen v1 (`packages/protocol/agent-hub.schema.json`): første melding må være `hello` innen 10 s, maks 1 MB per ramme, tekstrammer. Se «Sanntid» under |
| `SignalR /hub/live` | JWT (`access_token` i spørrestrengen eller Bearer). Metoder og klientkall i «Sanntid» under |
| `GET /api/servers/{id}/snapshot` | Bearer + lesetilgang. Siste `snapshot` flettet med siste `stream` som `Server`-projeksjonen. 404 ukjent server, 204 før noe er mottatt |
| `GET /api/servers/{id}/history?metric=&range=1h\|24h` | Bearer + lesetilgang. `metric` = `cpu`, `mem`, `swap`, `disk:<sti>`, `net:<grensesnitt>`, `cont:<container-id>` (CPU %) eller `cont:<container-id>:mem` (minne % av grensen). Svar `{ metric, range, stepMs, from, to, values[] }` (`net:` gir `rx[]`/`tx[]` i stedet for `values`); `null` der bufferen mangler punkt |
| `POST /api/demo/session` | Kun i demomodus: `{ accessToken (1 t), expiresAt, user }` for `demo@glimtpanel.com` (leser). 404 ellers |
| `POST /api/dev/token` | Kun `development`/`e2e`: `{ email }` → samme form, for en eksisterende bruker (brukes av `scripts/live-tail.mjs --dev-token`) |
| `POST /api/e2e/{disconnect-server\|reconnect-server\|fail-service\|advance}` | Kun `GLIMT_ENV=e2e`: `{ serverId?, unit?, seconds? }` styrer de falske serverne; `advance` flytter hubens klokke og kjører nede-deteksjonen og varselsveipet; `disconnect-server` med `seconds` bakdaterer «sist sett» og kjører de samme sveipene, så «Server down» utløses uten å flytte klokken for alle andre |
| `POST /api/e2e/connect-fake-container`, `sleep-node`, `fail-health` | Kun `GLIMT_ENV=e2e` (steg 12.5): `{ token }` kobler en falsk agent til containernoden fra `POST /api/servers` med `kind: container` (404 ukjent token); `{ serverId }` lar noden si `bye` (→ `sleeping`); `{ serverId, ok? }` lar helsesjekken svare 503 (eller 200 igjen) fra neste `snapshot` |
| `POST /api/e2e/enrol-fake-agent` | Kun `GLIMT_ENV=e2e`: `{ key, hostname? }` – en falsk agent bruker en ekte engangsnøkkel fra `POST /api/servers/enrol-key` (én gang; 404 ukjent/utløpt/brukt, 409 navnet finnes) og starter som ny server (`demo-<hostname>`, standard `web-03`, 2 kjerner, 4 GB, uten historikk) eid av nøkkelens eier. Eieren får `ServerAdded` (skjerm 3) |
| `GET /api/e2e/agent-streams` | Kun `GLIMT_ENV=e2e`: `{ total, byServer: { serverId: antall } }` åpne loggstrømmer i `LogRelay` (fase 6: «ingen strøm står igjen etter at siden forlates») |
| `POST /api/e2e/ensure-user` | Kun `GLIMT_ENV=e2e`: `{ email, password?, readerOf? }` – bekreftet testkonto (standardpassord `GlimtE2E-2026!`, idempotent). `readerOf: "all"` gir akseptert lesetilgang til demoserverne (skjerm 18); uten gir en eier uten servere (skjerm 3) |

### REST under `/api` (fase 2 del A)

Alle svar er JSON i camelCase; feil er `ProblemDetails` (400 `errors` per felt fra validering, ellers `title` og evt. `code`).
Endepunkter som trenger MongoDB svarer 503 når databasen ikke kan nås. «Bearer» = `Authorization: Bearer <accessToken>`.
Rate limiting: `auth`-policyen (10/min per IP i produksjon) på register/confirm/resend/login/forgot/reset, `api` (300/min per bruker) på resten.

| Endepunkt | Krever | Hva |
|---|---|---|
| `POST /api/auth/register` | – | `{ email, password, name }`. Passord ≥ 10 tegn og ikke på listen over vanlige passord; navn 1–80 tegn. 201 med brukeren, 409 `emailTaken`. Sender bekreftelsesmail med `GLIMT_WEB_PUBLIC_URL/confirm?token=…` (24 t). De 100 første kontoene får `earlyAdopter: true` (teller `counters/_id: "users"`). Ventende tilganger til e-posten kobles til kontoen |
| `POST /api/auth/confirm` | – | `{ token }` → samme svar som login (brukeren lander innlogget). 400 `invalidToken` |
| `POST /api/auth/resend-confirmation` | – | `{ email }` → alltid 204 |
| `POST /api/auth/login` | – | `{ email, password }` → `{ accessToken, expiresAt, user: { id, email, name, timezone, language, plan, earlyAdopter, emailConfirmed } }` + cookie `glimt_refresh` (httpOnly, Secure på https, SameSite=Lax, Path `/api/auth`, 30 dager). 401 ved feil, 403 `emailNotConfirmed` |
| `POST /api/auth/refresh` | cookie | Roterer oppfriskningstokenet (det gamle trekkes tilbake) og gir nytt `accessToken`. Bruk av et rotert token trekker tilbake alle brukerens tokens. 401 når det mangler, er trukket tilbake eller utløpt |
| `POST /api/auth/logout` | cookie | Trekker tilbake tokenet og sletter cookien. 204 |
| `POST /api/auth/logout-all` | Bearer | Trekker tilbake alle brukerens oppfriskningstokens. 204 |
| `POST /api/auth/forgot` | – | `{ email }` → alltid 204; sender `GLIMT_WEB_PUBLIC_URL/reset?token=…` (1 t) når kontoen finnes |
| `POST /api/auth/reset` | – | `{ token, password }` → nytt passord, alle oppfriskningstokens trekkes tilbake. 204 |
| `POST /api/auth/password` | Bearer | `{ currentPassword, newPassword }` → 204; andre enheter logges ut |
| `GET /api/auth/me`, `GET /api/account` | Bearer | Brukeren over pluss `ownsServers` (bool) og `readerOf` (antall aksepterte tilganger mottatt) |
| `PATCH /api/account` | Bearer | `{ name?, timezone?, language? }` (IANA-tidssone, `en`/`no`) → samme som `GET /api/account` |
| `PUT /api/account/email` | Bearer | `{ email, password }` (steg 8.2) → 202 `{ pendingEmail }`: den **nye** adressen får en bekreftelseslenke (`/confirm?token=`, formål `email-change`, 24 t); adressen byttes først når `POST /api/auth/confirm` kjøres med det tokenet (409 `emailTaken` om noen har tatt den i mellomtiden). 400 ved feil passord, ugyldig eller uendret e-post, 409 når adressen finnes |
| `GET /api/subscription` | Bearer | `{ slotsUsed, slotsFree: 2, slotsBeta, plan, plannedPricePerSlotUsd: 12, discountPct (50 for earlyAdopter), wouldCostUsd, wouldCostWithDiscountUsd, noticeDays: 60 }`. Beta har ingen grense; modellen bare teller |
| `GET /api/account/export` | Bearer | Vedlegg `glimtpanel-export.json`: `user` (uten hash), `servers` (med tagger og `kind`, uten token-hash), `accessGrants` {`given`, `received`}, `groups`, `alertSettings`, `alerts`, `pushSubscriptions` (kun endpoint/device) |
| `DELETE /api/account` | Bearer | `{ password }` → sletter servere (agentene får beskjed via `IServerLifecycle`), nøkler, tilganger begge veier, tokens, varselinnstillinger, push-abonnementer og brukeren. 204 |
| `GET /api/alerts?state=active\|resolved\|all` | Bearer | Varsler på serverne brukeren ser, nyeste først, maks 200: `{ alerts: [ { id, serverId, serverName, rule, key, severity, state, detail, firedAt, resolvedAt, lastReminderAt, silenced, notifiedVia } ], active, resolved }`. `silenced` = serveren er stille eller dempet akkurat nå |
| `POST /api/alerts/silence` | eier | `{ serverId, until: "1h" \| "tomorrow" \| "monday" }` → `{ serverId, silencedUntil }`. «tomorrow» og «monday» er 08:00 i brukerens tidssone (mandag = neste uke når det er mandag) |
| `GET /api/alert-settings` | Bearer | Kontoen: `{ rules: [ { id, severity, thresholdUnit, defaultThreshold, defaultDurationSec, enabled, threshold, durationSec, overridden } ], channels: { push, email, webhookUrl, webhookSecret, pushConfigured }, digest: { enabled, time }, pushDevices: [ { id, device, createdAt } ], email }` |
| `PUT /api/alert-settings` | Bearer | `{ rules: { <rule>: { enabled?, threshold?, durationSec? } } }` – hele kartet erstattes; terskel 1–100 % (disk, minne, prosessor) eller heltall 1–1000 (container), varighet 30 s–24 t. 400 per regel ved feil |
| `PUT /api/channels` | Bearer | `{ push?, email?, webhookUrl? ("" fjerner), digest?: { enabled, time "HH:mm" }, rotateWebhookSecret? }` → samme svar som `GET /api/alert-settings` |
| `POST /api/channels/webhook-test` | Bearer | Ett signert testkall til den lagrede URL-en: `{ ok, status }` |
| `GET/PUT /api/servers/{id}/alert-settings` | eier | `{ serverId, serverName, useAccountDefaults, muted, silencedUntil, rules[] }` (`defaultThreshold` er kontoens verdi, `overridden` markerer serverens); `PUT { useAccountDefaults?, muted?, clearSilence?, rules? }` – `rules` er hele overstyringen (`servers.alertOverrides`), `useAccountDefaults: true` tømmer den |
| `POST /api/push-subscriptions` | Bearer | `{ endpoint (https), keys: { p256dh, auth }, device }` → 201 `{ id, device, createdAt }`; samme `endpoint` erstatter (unik indeks) |
| `DELETE /api/push-subscriptions` | Bearer | `{ endpoint }` → 204 |
| `POST /api/servers` | Bearer, bekreftet e-post | `{ kind: "container", name }` oppretter en containernode med én gang (steg 12.5) og svarer `{ id, name, kind, token, hubUrl, agentImage, compose, dockerfile }`. Tokenet `agt_…` vises **én gang**; bare hashen lagres. Noden er `down` uten `lastSeenAt` til første `hello`. `kind: "server"` gir 400 (servere innrulleres med nøkkel). `hubUrl` er `GLIMT_HUB_PUBLIC_URL` som `ws(s)://…/agent/ws`, `agentImage` er `GLIMT_AGENT_IMAGE` (standard `ghcr.io/opdahlmann/glimt-agent:latest`) |
| `POST /api/servers/enrol-key` | Bearer, bekreftet e-post | `{ dockerMode: "proxy" \| "simple" \| "none" }` → `{ key: "gp_…" (22 base62-tegn), command, expiresAt (+1 t), dockerMode }`. Kun hashen lagres i `enrolKeys`; agentens `hello` bruker den én gang |
| `GET /api/servers` | Bearer | Noder brukeren eier eller har lesetilgang til: `{ id, name, hostname, tags, status, lastSeenAt, role: "owner" \| "reader", ownerEmail?, os, kernel, arch, cores, ramBytes, dockerMode, createdAt, supportUntil, eol, kind: "server" \| "container", image?, containerId? }`. `status` er `up`, `down` eller `sleeping` (containernode som sa `bye`). `supportUntil`/`eol` fra Ubuntu-tabellen (20.04 → 2025-05-31, 22.04 → 2027-04-30, 24.04 → 2029-04-30, 26.04 → 2031-04-30), ellers `null`/`false`. Status og «sist sett» kommer fra registeret når serveren er kjent der |
| `GET /api/servers/{id}` | Bearer | Samme form; 403 uten tilgang |
| `PATCH /api/servers/{id}` | eier | `{ name? (1–64), tags? (≤ 10 av `^[a-z0-9-]{1,24}$`, små bokstaver, uten duplikater) }` |
| `DELETE /api/servers/{id}` | eier | Fjerner dokumentet, kaller `IServerLifecycle.ServerRemovedAsync`, svarer `{ uninstallCommand, kind, hint }`: servere får avinstalleringskommandoen, containernoder `uninstallCommand: null` og `hint: "remove the sidecar from your compose file"` |
| `POST /api/servers/{id}/rotate-key` | eier | Nytt token `agt_…`. Servere: `previousTokenHash` gjelder i 10 min, tokenet går til agenten over socketen (`IServerLifecycle.TokenRotatedAsync`), aldri til nettleseren, 204. Containernoder: agenten leser miljøet ved oppstart, så svaret er `200 { token, oldTokenValidUntil }` og det gamle tokenet gjelder i 24 t |
| `POST /api/access` | Bearer | `{ email, scope: "all" \| ["tag", …] }`. Finnes kontoen: `accepted` straks + e-post «du har fått lesetilgang»; ellers `pending` + invitasjon med `GLIMT_WEB_PUBLIC_URL/access/accept?token=…`. 409 når e-posten allerede har tilgang |
| `GET /api/access` | Bearer | Tilganger gitt av meg: `[ { id, email, scope, status, createdAt, initials } ]` |
| `DELETE /api/access/{id}` | eier av tilgangen | 204 |
| `POST /api/access/accept` | Bearer | `{ token }` → kobler tilgangen til kontoen (e-posten må stemme, ellers 403 `emailMismatch`) |

Tilgangskontrollen er samlet i `IAccessService` (`MongoAccessService`): synlig = egne servere ∪ servere hos eiere som har gitt
meg tilgang (`all`, eller `server.tags ∩ scope ≠ ∅`). Servere uten `ownerId` (rullet inn med dev-nøkkelen) tilhører
ingen, bortsett fra utenfor produksjon der dev-brukeren (`GLIMT_DEV_USER_EMAIL`) ser og eier dem. Uten database utenfor
produksjon regnes registeret i minnet som eierløse servere, så skjelettet virker uten Mongo.

### E-post

`IEmailSender` har to implementasjoner: `ConsoleEmailSender` (tom `GLIMT_APPMAIL_URL`; logger e-posten med lenken) og
`AppmailEmailSender`. Kontrakten mot appmail er **ikke avklart ennå** (IMPLEMENTERINGSPLAN 1.4); adapteren er skrevet mot
denne antagelsen og merket `TODO(appmail)` i koden:

```
POST {GLIMT_APPMAIL_URL}
Authorization: Bearer {GLIMT_APPMAIL_API_KEY}
Content-Type: application/json

{ "to": "...", "from": "{GLIMT_MAIL_FROM}", "subject": "...", "text": "...", "html": "..." }
```

Alle 2xx regnes som godtatt. 10 s tidsavbrudd; feil logges som `error` og gir `false` tilbake, aldri et unntak inn i
forespørselen. Malene (`EmailTemplates`: bekreftelse, tilbakestilling, invitasjon, «du har fått lesetilgang») bygges i
huben som tekst + enkel HTML på engelsk og norsk etter brukerens språk.

### Sanntid: agenter, buffer, SignalR og demo (fase 2 del B)

**Agenter (`Features/Agents`).** `hello` med `enrolKey` gir `welcome` med et nytt token `agt_…`; bare SHA-256-hashen
lagres. Dev-nøkkelen (`GLIMT_DEV_ENROL_KEY`, kun utenfor produksjon) gir `dev-<hostname>` med dev-brukeren som eier når
MongoDB er tilgjengelig; alle andre nøkler går gjennom `IEnrolKeyStore.TryConsumeAsync` (engangsnøkler fra
`POST /api/servers/enrol-key`) og gir en ny server med tilfeldig 12-tegns id, eierens id fra nøkkelen og `ServerAdded` til
eieren. Ukjent, utløpt eller brukt nøkkel gir `authFailed invalidKey`. `hello` med `token` gir `welcome` uten token; etter
`POST /api/servers/{id}/rotate-key` sender huben `rotate { token }` til agenten og godtar det gamle tokenet i 10 minutter
(`AgentSession.PreviousTokenHash`; etter en omstart av huben finnes bare det nye tokenet i `servers`). `DELETE` gir
`authFailed serverRemoved` og sesjonen, bufferen og loggstrømmene forsvinner. En ny tilkobling for samme server erstatter den
forrige (den gamle lukkes). Alt agenten sender går gjennom `AgentIngest`: `snapshot` (hvert 30. s) lagres typet på sesjonen,
gir ett punkt i ringbufferen og `Card`/`Server` til abonnentene; `stream` (1 eller 5 s) oppdaterer sesjonen og `Server`
(+ `Card`, høyst én per sekund per server); begge oppdaterer «sist sett». Ugyldige eller ukjente meldinger logges høyst én
gang per minutt per agent og lukker aldri forbindelsen (rammer over 1 MB gjør det). `DownDetector` setter `down` når en
frakoblet server ikke er sett på `GLIMT_DOWN_AFTER_SECONDS` og lagrer `lastSeenAt`/`status` i `servers` hvert minutt.
`SubscriptionCounter` teller nettleserabonnenter per server (serverside og oversikt): 0→1 sender `subscribe { intervalMs:
laveste blant abonnentene, topProcs: 40 }`, endret minimum sender `subscribe` igjen, 1→0 sender `unsubscribe`, og en agent
som kobler til igjen får `subscribe` på nytt når noen ser på. `LogRelay` gir hver loggstrøm en `streamId` (GUID) knyttet til
én SignalR-tilkobling: `logStart`/`logStop` til agenten, `log`/`logEnd` bare tilbake til den tilkoblingen; grenser 4 strømmer
per tilkobling og 8 per agent (`LogEnded` med `error` «too many streams»); en nettleser som forsvinner stopper sine strømmer,
en agent som forsvinner avslutter sine med `unavailable`.

**Buffer (`Features/Buffer`).** Én `ServerBuffer` per server: ring på 2 880 punkter (30 s × 24 t) à ca. 1 kB med `ts`,
cpu, mem (brukt %), swap (%), disk-% per montering, rx/tx byte/s per grensesnitt og cpu/mem-% per container. De dynamiske
delene er `float[]` indeksert gjennom tabeller per server (montering, grensesnitt, container-id) som bare vokser; en id som
kommer tilbake beholder plassen, og et punkt uten verdi for en plass er `NaN` → `null` i svaret. `snapshot.ts` mer enn 5
minutter fra hubens klokke erstattes av hubens tid. Historikk: `1h` = 120 bøtter à 30 s (råpunktene), `24h` = 288 bøtter à
5 min; prosentmetrikker tar maks per bøtte, byte/s gjennomsnitt; tom bøtte er `null`. Kortets `cpuLastHour`/`memLastHour` er
den samme 1h-spørringen avrundet til hele prosent (én byte hver i MessagePack). `BufferPersistence` skriver alle bufferne som
MessagePack til `GLIMT_BUFFER_PATH/buffer.bin` (via `.tmp` + rename, mappen opprettes) hvert 15. minutt og ved
`ApplicationStopping`, og leser filen ved oppstart (punkter eldre enn 24 t forkastes, ukjent versjon eller ødelagt fil gir
advarsel og tom start). Tom `GLIMT_BUFFER_PATH` = ingen lagring.

**SignalR (`Features/Live`).** `/hub/live` krever JWT; `Context.UserIdentifier` er bruker-id. JSON er standard, MessagePack
forhandles av klienter som legger til protokollen (merk: MessagePack bruker DTO-enes egenskapsnavn slik de er, JSON camelCase).
Klient → hub: `SubscribeOverview()` (gruppe `user:{id}`, sender `ServerStatus` + `Card` for alle synlige servere fra
`IAccessService.VisibleServerIdsAsync`), `UnsubscribeOverview()`, `SubscribeServer(id)` (`HubException("forbidden")` uten
tilgang; gruppe `server:{id}`, sender `Server` straks), `UnsubscribeServer(id)`, `SetInterval(1000|5000)` (ellers
`HubException`), `StartLog({ serverId, source, unit?, container?, priority?, sinceMs?, tail? }) → streamId`,
`StopLog(streamId)`. Hub → klient: `ServerStatus(dto)` (tilkobling, frakobling, nede), `Card(dto)` (under 600 byte i
MessagePack: `id, name, hostname, tags, status, connected, lastSeenAt, os, versionId, arch, cores, ramBytes, cpu, mem,
diskWorst { path, pct }, netRx, netTx, containersRunning, containersTotal, containersBad, updates, securityUpdates,
rebootRequired, failedServices, activeAlerts, alertSeverity (verste: critical/warning/info), cpuLastHour[120], memLastHour[120]`), `Server(dto)` (`id, name,
hostname, tags, status, connected, lastSeenAt, agentVersion, os, kernel, arch, cores, ramBytes, dockerMode, bootTime,
uptimeSec, host { cpu, load, mem, mounts[], ifaces[] }, processes[], processTotals, containers[], services, maintenance,
security, snapshotAt, streamAt` – nyeste `host` vinner, containere fra `snapshot` med cpu/mem/nett/state fra `stream`;
sendes fullt på hvert `stream` og `snapshot`, TODO: bare snapshot-delene som er nye), `Log(streamId, lines[], dropped?)`,
`LogEnded(streamId, reason, message?)`, `ServerAdded(card)`, `ServerRemoved(id)`, `Alert(event)` (`{ kind: fired|resolved|reminder,
alert: <rad som i GET /api/alerts>, activeOnServer, worstSeverity }`, til `alerts:{id}`-gruppen alle tilkoblinger er med i). `Card`, `ServerStatus`, `ServerAdded` og
`ServerRemoved` går til `user:{id}` for alle med tilgang (`IAccessService.UserIdsWithAccessAsync`, mellomlagret 30 s, pluss
eieren, dev-brukeren for eierløse servere utenfor produksjon og alle oversiktsabonnenter som ser serveren).
`scripts/live-tail.mjs` viser alt dette i terminalen (`--dev-token`, `--login`, `--token` eller `--demo`; `--server`, `--log`,
`--history`).

**Demo og e2e (`Features/Demo`).** `GLIMT_DEMO_MODE=true` eller `GLIMT_ENV=e2e` starter `FakeAgentService`: de 16 serverne
fra designets `glimtData.js` (navn, tagger, kjerner, RAM, Ubuntu-versjon, monteringer, containere og feilene: `api-prod`
høy CPU, `db-prod` omstart kreves, `worker-01` feilet `cron-sync.service`, `acme-app` med `acme-worker` i omstartsløkke,
`nordic-db` nede siden 03:12 lokal tid, `backup` på 20.04; `media` er «pauset» i designet men holdes oppe til pause finnes)
som `demo-<navn>`, eid av `demo@glimtpanel.com` (opprettes i `users` uten passord når MongoDB er der; i e2e eier
dev-brukeren dem når den finnes, og demokontoen får da en godtatt lesetilgang (`all`) og sin egen kopi av de to gruppene
med id-suffiks `-demo`, så `/demo` viser det samme). Demokontoen er skrivebeskyttet (steg 10.1): `DemoReadOnly` er en
middleware som svarer 403 «The demo account is read-only» på alt annet enn GET under `/api` når tokenets e-post er
demokontoens, og `NotificationDispatcher` hopper over den (ingen push, e-post eller webhook). I produksjon må
`GLIMT_DEMO_MODE=true` for at `/demo` i web skal virke. De skriver `stream` hvert sekund og `snapshot` hvert 30. sekund rett inn i `AgentIngest`
uten WebSocket, fyller bufferen med 24 timers syntetisk historikk ved start, og loggstrømmer svarer med linjer fra
`LOGT`/`CLOGT`-tabellene (ca. én per sekund). I e2e er tallene seedet (samme hver kjøring), klokken er en
`ShiftableTimeProvider` (`POST /api/e2e/advance { seconds }` flytter den og kjører `DownDetector.SweepAsync`), og
`disconnect-server`/`reconnect-server`/`fail-service` `{ serverId?, unit? }` endrer de falske serverne, `enrol-fake-agent
{ key, hostname? }` lar en falsk agent bruke en ekte engangsnøkkel (fase 4: «Legg til server»-flyten ende til ende) og
`ensure-user { email, password?, readerOf? }` lager testkontoene til skjerm 3 og 18 (`Features/Demo/E2eUsers.cs`).
Demoserverne bruker binære enheter (GiB/MiB), så «8 GB» i designet vises som 8 GB i web. Merk: JWT-ene
valideres mot den ekte klokken, så et token utstedt etter en stor `advance` er «ikke gyldig ennå» til sanntid tar igjen
(30 s slingringsmonn) – logg inn før du flytter klokken.

### Containernoder (fase 12)

En node har `kind` (`server` for alt fra før, `container` for agenter som kjører inne i en container). Containernoder
opprettes i dashbordet (`POST /api/servers`) med et langtlevende token; `hello` med `token` og `kind: container`
oppdaterer `hostname`, `containerId`, `capabilities` og `image` på noden, og `enrolKey` avvises med
`authFailed containerNeedsToken`. `bye { reason: shutdown }` (agenten ved SIGTERM) gir `status: sleeping` med
`ServerStatus` til abonnentene: `DownDetector` og `server_down` lar en sovende node være, neste `hello` gir `up` igjen.
Brå frakobling uten `bye` gir `down` som før. `AgentSession` husker `hello`-tidspunktene siste 24 t; `Card` og `Server`
for containernoder får `restarts24h`/`restarts10m` fra dem. `Card` får `kind`, `health` (`ok`/`fail`/`none`), `approx`,
`onHost`, `image`, `restarts24h`, `memLimit` og `ports`; `Server` får `kind`, `containerId`, `capabilities`, `image`,
`health`, `checks`, `approx`, `restarts24h`, `restarts10m`, `hostServer`, `hostContainer` og (for verter) `linkedNodes`.
`slotsUsed` og eksporten teller begge typer (eksporten har `kind`). Utenom produksjon seeder `DevSeeder` noden
`sidecar-dev` (`dev-sidecar`) på dev-kontoen med hashen av `GLIMT_DEV_CONTAINER_TOKEN`, så `npm run dev -- --sidecar`
alltid har en node.

**Lenking (`NodeLinker`, steg 12.6).** Når en vertsagents `snapshot` inneholder en container hvis id begynner med en
containernodes `containerId` **hos samme eier**, lenkes de i minnet: noden får `hostServer { serverId, name }` og
`hostContainer` (image, imageCreated, state, restartCount, memLimit …) fra verten, verten får `linkedNodes`
(container-id → node-id) så containerraden kan lenke til noden. Lenken forsvinner når verten ikke lenger lister
containeren. `StartLog` med `source: container` på en lenket node åpnes på **verten** med containerens id (svarene
rutes tilbake til nettleseren som vanlig); uten lenke svarer huben `LogEnded(unavailable, "stdout logs need the host
agent")`. `source: file` med `path` går til noden selv.

**Varsler (steg 12.7).** `svc_failed` og `reboot` evalueres aldri for containernoder. `cont_restart` betyr for en node
`restarts10m > 3` (terskel/vindu fra regelen) eller at verten ser containeren som `exited`/`restarting`.
`disk_full` gjelder volumene, `mem_pressure` regnes mot `memory.max` når agenten rapporterer den som total. Ny regel
`health_failed` (advarsel, nr. 8): `snapshot.health.ok` usann i 2 min (fire øyeblikksbilder) → «GET /healthz · 503 ·
1 240 ms», løses ved første ok. `server_down` utløses ikke mens status er `sleeping`.

### Grupper (fase 13)

`Features/Groups`, samlingen `groups`: personlige, navngitte samlinger av noder (`ownerId`, `name` 1–40 tegn,
`memberIds[]`, `order`). `GET /api/groups` (egne, i `order`), `POST { name, memberIds? }` (201), `PATCH /api/groups/{id}
{ name?, memberIds?, order? }`, `DELETE`. Grenser: 50 grupper per bruker, 100 medlemmer per gruppe; en node kan stå i
flere. Medlemmer valideres mot `IAccessService.CanReadAsync` ved skriving (400 med node-id); ved lesing filtreres
medlemmer brukeren ikke lenger ser bort uten at dokumentet endres. En slettet node fjernes fra alle grupper i
`DELETE /api/servers/{id}`; sletting av konto sletter gruppene; eksporten har `groups`. Andres grupper gir 403,
demokontoen får 403 på alle skriv. Ingen SignalR-meldinger: gruppekortet regnes i nettleseren fra `Card`-ene.
Demomodus seeder «Acme» (`web-02`, `acme-backend`, `acme-frontend`, `db-prod`) og «Edge» (`edge-worker`, `worker-01`)
med faste id-er `demo-acme`/`demo-edge` på eieren av demoserverne.

### Varsler (fase 7)

**Motoren (`Features/Alerts`).** `AlertEngine` er en singleton med tilstand per (server, regel, instans): `ok` → `pending`
(betingelsen er sann, varigheten ikke nådd) → `firing` → `ok`. Instansen er monteringen (`disk_full`), containernavnet
(`cont_restart`) eller enheten (`svc_failed`); vertsreglene har tom instans. `AgentIngest` kaller
`AlertEngine.SnapshotAsync` etter hvert `snapshot` (30 s); `RuleEvaluator` er rene funksjoner over ett øyeblikksbilde og gir
observasjonene som er sanne nå, og alt som ikke lenger observeres løses. Varigheter måles i tid siden første sanne
øyeblikksbilde (`mem_pressure` 95 % i 5 min, `cpu_sat` 95 % i 15 min: utløses på øyeblikksbildet som kommer ≥ varigheten
etter det første). `cont_restart` bruker `ContainerTracker` per server: stoppet etter å ha kjørt, `restarting`, eller
`restartCount` økt med mer enn 3 innenfor 10 minutter (vinduet er `durationSec`, ikke en ventetid). `server_down` og
påminnelsene (24 t etter forrige melding, ikke for info) evalueres i `SweepAsync` hvert 10. sekund (`AlertEngineService`,
også fra `POST /api/e2e/advance` og `disconnect-server` med `seconds`); en agent som kobler til igjen løser `server_down`
straks (`ServerUpAsync`). Reglene og standardene står i `AlertRules`; `AlertConfigProvider` slår sammen
standard ← kontoens `alertSettings.rules` ← serverens `alertOverrides` og legger til `silencedUntil`/`alertsMuted` (cache
1 min, ugyldiggjøres av endepunktene). Stille, dempet og avslått regel stopper varsling, ikke tilstandssporing: hendelsen
merkes `Quiet`, vises i listen, sendes ikke. Alt persisteres i `alerts` (`IAlertStore`, no-op uten MongoDB); ved oppstart
gjenopprettes `firing`-dokumentene, og det som ikke lenger gjelder løses på første øyeblikksbilde. `ActiveAlertCounts`
gir kortet `activeAlerts` og `alertSeverity` (verste). Hendelsene går til `IAlertSink`-ene: `LiveAlertSink` (Live) sender
`Alert(event)` til `alerts:{userId}`-gruppen som hver SignalR-tilkobling blir med i ved tilkobling (uansett side), fulgt
av et nytt `Card`; `NotificationDispatcher` velger kanaler.

**Kanaler (`Features/Alerts/Channels`).** Mottakere er alle med tilgang til serveren. Push går til hver av dem som har
push på (alle enheter i `pushSubscriptions`); e-post og webhook kun til eieren. `server_down` og `disk_full` e-postes alltid
til eieren; de andre reglene når e-post er på. Info-varsler (`reboot`) sendes ikke, de venter på oppsummeringen. Alle
kanaler er `IChannel` og kaster aldri inn i motoren; `notifiedVia` på varselet får kanalene som gikk ut ved utløsing.
E-post går gjennom `IEmailSender` (`AlertEmailTemplates`: utløst, løst, påminnelse, oppsummering på engelsk og norsk,
tidspunkt i mottakerens tidssone) – Brevo-koblingen kommer som en `IEmailSender` bak samme grensesnitt, ingenting annet
endres. Webhook: `POST` JSON `{ event, server: { id, name }, rule, severity, detail, at, url }` med
`X-Glimtpanel-Signature: sha256=<hex HMAC-SHA256 av kroppen med kontoens webhookSecret>`, 5 s tidsavbrudd, tre forsøk
(1 s, 10 s, 60 s) i bakgrunnen. `DigestService` går hvert minutt: brukere der lokal tid er `digest.time` (standard 08:00)
får info-varslene siste døgn og alt som fortsatt står på serverne de ser, én gang per lokal dato (`lastDigestDate`),
ingen e-post når begge er tomme.

**Web Push (`Features/Alerts/Push`), egen implementasjon uten bibliotek.** `VapidKeyPair` importerer nøklene fra env;
`VapidToken` signerer JWT `{ typ: JWT, alg: ES256 }` med `aud` (endepunktets opprinnelse), `exp` (nå + 12 t) og `sub`
(`GLIMT_VAPID_SUBJECT`), mellomlagret per `aud` i en time, som `Authorization: vapid t=<jwt>, k=<offentlig nøkkel>`.
`WebPushEncryptor` er RFC 8291 med `aes128gcm`: engangs P-256-nøkkel per melding, ECDH mot abonnentens `p256dh`,
HKDF-SHA256 med `auth` som salt og info `"WebPush: info\0" ‖ ua_public ‖ as_public` → IKM, tilfeldig 16-byte salt → CEK
og nonce, AES-128-GCM over `nyttelast ‖ 0x02`, rammehode `salt ‖ rs=4096 ‖ idlen=65 ‖ as_public`; nøkkel og salt kan
injiseres, så testvektoren i RFC 8291 vedlegg A kjøres bit for bit. `WebPushClient` sender `POST` med
`Content-Encoding: aes128gcm`, `TTL: 86400`, `Urgency: high` (kritisk) eller `normal`, `Topic: <serverId>-<rule>` (en
påminnelse erstatter forrige melding); 2xx levert, 404/410 sletter abonnementet, 413 logges, 429/5xx prøves én gang til
etter 30 s, 400/401/403 logges som VAPID-feil med `aud`. Nyttelasten er `{ title: "web-02 · Disk almost full", body:
"/ · 92 %", url: "/servers/<id>#disk", tag: "<serverId>:<rule>" }` under 3 kB.

**Tester.** `AlertEngineTests` kjører hver regel med `FakeTimeProvider` og lagre i minnet (utløser etter riktig varighet
og ikke før, løser, påminnelse etter 24 t, stille og dempet, kontoterskel og serveroverstyring, avslått regel,
container-vindu, gjenoppretting etter omstart, glem server). `WebPushTests`: RFC 8291 vedlegg A, VAPID verifisert med den
offentlige nøkkelen, svarkodene og opprydding av døde abonnementer. `AlertChannelTests`: kanalvalg, quiet/info hoppes over,
webhook-signatur og forsøk, oppsummeringstidspunkt i to tidssoner, maler, `SilenceUntil`. `AlertsTests` (MongoDB): hele
veien fra demoserverne til listen, kortet, `Alert`-hendelsen og kanalene (falske `IChannel`), og alle endepunktene.

## Herding (steg 11.2)

- **Kropp og dybde.** `RequestLimits`: ingen REST-kropp over 1 MB (413 fra `UseBodyLimit` på deklarert lengde og fra
  Kestrel for chunked), JSON-dybde 32 i minimal API, SignalR og agentprotokollen (400 ved dypere). Agentens
  WebSocket-rammer har egen grense (1 MiB) i `AgentSocket`.
- **CORS** er av i produksjon; nettleseren går same-origin gjennom nginx. Utenom produksjon åpnes bare
  `GLIMT_WEB_PUBLIC_URL` (ng serve på en annen port). `/agent/ws` og `/install` er ikke CORS-relevante (WebSocket og
  `curl`).
- **Tilgang.** Alle endepunkter som navngir en server eller gruppe går gjennom `IAccessService` før noe annet.
  `AccessArchitectureTests` leser rutetabellen og kaller hvert `/api/servers/{id}…`- og `/api/groups/{id}…`-endepunkt
  som en fremmed bruker: svaret skal være 403 eller 404, aldri 2xx og aldri en valideringsfeil (som ville avslørt
  gyldige spørringer før tilgangen er sjekket). Testen fant og rettet `history`, som validerte `metric` først.
- **Demokontoen** er skrivebeskyttet (`DemoReadOnly`, se «Demo og e2e»).
- **Bak proxy.** `UseForwardedHeaders` først i kjeden: `X-Forwarded-Proto` gir `IsHttps` (Secure på oppfriskningskaken)
  og `X-Forwarded-For` gir klientens adresse (hastighetsbegrensning, logg). Alle proxyer stoles på og hele kjeden
  leses, siden porten aldri publiseres direkte; Traefik fjerner selv X-Forwarded-hoder fra klienter.
- **Keepalive.** Agenten lukker en forbindelse uten innkommende trafikk på 2 minutter. Huben pinger derfor hvert
  `GLIMT_HEARTBEAT_SECONDS` når *den selv* har vært stille (`_lastSent`), ikke når agenten har vært det – lasttesten i
  steg 11.4 fant at strømmende agenter ellers koblet opp på nytt hvert 2. minutt.
  `AgentWebSocketTests.Hub_pings_a_streaming_agent_after_its_own_silence` holder det slik.
- **Minne.** Workstation GC (`ServerGarbageCollection=false`): 100 agenter og 10 nettlesere gir 340 MB RSS på topp
  mot 1,2 GB med server-GC.
- **Hemmeligheter i logg.** Agenttoken, engangsnøkler, oppfriskningstokens og passord logges aldri; loggene nevner
  server-id, bruker-e-post og feilmeldinger fra MongoDB. `dotnet list package --vulnerable` kjøres i CI (jobben `audit`).
- **Rotasjon av `GLIMT_JWT_SECRET`.** Tilgangstokenene (15 min) signeres med hemmeligheten; oppfriskningstokenene ligger
  som hash i `refreshTokens` og er uavhengige av den. Bytt verdien i Dokploy og rull ut huben: alle åpne faner får
  401 ved neste kall, `ApiService` oppfrisker stille med cookien og brukeren merker ingenting. Agentene er upåvirket
  (egne tokens). Gjør det samme om hemmeligheten mistenkes lekket; ingen dobbel nøkkel er nødvendig siden vinduet er
  15 minutter.

## Struktur

```
Glimt.Hub.slnx, Directory.Build.props   (Dockerfile: infra/glimt-hub/Dockerfile)
src/Glimt.Hub/
  Program.cs                 # liten: options, logging, features
  Infrastructure/            # GlimtOptions, DotEnv, MongoContext, RequireDatabase (503-filter), UbuntuSupport, LoggingSetup, PasswordHasher, RateLimiting, VapidKeys
  Infrastructure/Auth/       # JwtTokens, CurrentUser
  Infrastructure/Email/      # IEmailSender, ConsoleEmailSender, AppmailEmailSender, EmailTemplates
  Infrastructure/Access/     # IAccessService
  Infrastructure/Servers/    # IServerLifecycle (Servers/Account → Agents)
  Features/Health/           # /healthz (mongo, agenter, demoMode, buffer)
  Features/Auth/             # /api/auth: UserStore, RefreshTokenStore, EmailTokenStore, AuthSessions (cookie + JWT), Passwords, Validation
  Features/Account/          # /api/account, /api/subscription: Subscription, AccountExport (eksport + kaskade)
  Features/Access/           # /api/access: AccessGrantDocument/Store, MongoAccessService
  Features/Agents/           # /agent/ws: Protocol/ (records + JSON), AgentConnection (IAgentLink), AgentRegistry, AgentSession, AgentAuthenticator,
                             #   AgentIngest, SubscriptionCounter, LogRelay, AgentLifecycle (IServerLifecycle), DownDetector, Projections (Card/Server), UserDirectory, /api/servers/{id}/snapshot
  Features/Alerts/           # /api/alerts, /api/alert-settings, /api/channels, /api/servers/{id}/alert-settings, /api/push-subscriptions: AlertRules, AlertEngine (+ AlertEngineService),
                             #   RuleEvaluator (+ ContainerTracker), AlertConfigProvider, ActiveAlertCounts, AlertDocuments, IAlertStore (Mongo), AlertDtos;
                             #   Channels/ (IChannel, PushChannel, EmailChannel + AlertEmailTemplates, WebhookChannel, NotificationDispatcher, DigestService, AlertTexts);
                             #   Push/ (VapidKeyPair, VapidToken, WebPushEncryptor, WebPushClient)
  Features/Buffer/           # ServerBuffer (ring 2 880 × Point), BufferStore, HistoryQuery, BufferFile (MessagePack), BufferPersistence, /api/servers/{id}/history
  Features/Live/             # SignalR LiveHub (JWT, MessagePack), ILiveClient, LiveConnections, LivePublisher (ILivePublisher + ILogReceiver), LiveAlertSink, ServerStatusDto, CORS
  Features/Demo/             # FakeAgentService + FakeServer + DemoData (glimtData.js), ShiftableTimeProvider, /api/demo/session, /api/dev/token, /api/e2e/*
  Features/Servers/          # /api/servers: servers/users-dokumenter, MongoServerStore, MongoEnrolKeyStore, ServerDtos, MongoIndexes, DevSeeder, /install
tests/Glimt.Hub.Tests/       # xUnit + WebApplicationFactory
```
