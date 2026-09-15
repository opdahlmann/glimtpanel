# Glimtpanel

## Utviklingsbrukere i GlimtpanelDev

Kontoer som er opprettet i utviklingsdatabasen `GlimtpanelDev`. Passordene gjelder kun denne databasen. Tabellen ryddes av eier før beta.

| E-post | Passord | Rolle | Merknad |
|---|---|---|---|
| dev@glimtpanel.local | GlimtDev-2026! | eier | Seedes automatisk av huben når `GLIMT_ENV=development` (fra `GLIMT_DEV_USER_*` i `.env`) |

---

# Glimtpanel

Ett nettleservindu som viser hva alle Ubuntu-serverne dine gjør akkurat nå. En liten agent på hver server (og i hver
container du vil følge), ett dashboard for alle: CPU, minne, disk, nettverk, prosesser, containere, tjenester,
oppdateringer, sikkerhet og logger, live hvert sekund, med varsler på telefonen når noe går galt. Agenten kan bare lese.

![Oversikten i 1440 og 390 px](docs/overview.png)

## Legg til en server

Registrer deg, trykk «Add» i oversikten og lim inn kommandoen du får på serveren (Ubuntu 20.04–26.04, amd64/arm64):

```sh
curl -fsSL https://get.glimtpanel.com | sh -s -- --key gp_…
```

Skriptet laster ned binæren fra GitHub-utgivelsen, verifiserer SHA-256, legger den i `/usr/local/bin/glimt-agent`,
skriver en herdet systemd-enhet (`systemd-analyze security` under 3, egen systembruker, `ProtectSystem=strict`,
syscall-filter) og starter den. Serveren står i dashbordet innen 30 sekunder. Containere leses gjennom
[docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) med `POST=0` (standard) eller docker-gruppen
(`--docker simple`, root-ekvivalent, advares om). Fjern alt med `sudo glimt-agent uninstall`.

### Overvåke en container

En container (sidecar i Compose, eller binæren i ditt eget image) legges til med «Add container» i dashbordet, som gir et
token og denne snutten:

```yaml
services:
  app:
    image: your-app:latest
  glimt-agent:
    image: ghcr.io/opdahlmann/glimt-agent:latest
    pid: "service:app"
    network_mode: "service:app"
    read_only: true
    environment:
      GLIMT_HUB: wss://api.glimtpanel.com/agent/ws
      GLIMT_TOKEN: agt_…
      GLIMT_NODE_NAME: api-1
```

Se `apps/glimt-agent/README.md` («Containernoder») for valgfrie variabler og hva agenten ser inne i en container.
Noder kan samles i personlige **grupper** (⋯ på et kort → «Add to group…»); gruppevisningen viser hver gruppe som ett
kort med summene til medlemmene. `/demo` viser hele dashbordet uten innlogging, med falske servere.

## Målte tall

| Hva | Tall | Kilde |
|---|---|---|
| Agent i hvile, tilkoblet, `snapshot` hvert 30. s | 15 MB RSS, 0,08 % av én kjerne | `apps/glimt-agent/README.md` («Målt ressursbruk») |
| Agent, oppstart (første snapshot, vedlikehold, journal-tellere) | ≈ 1 s CPU | samme |
| Sidecar-image (`ghcr.io/opdahlmann/glimt-agent`) | under 15 MB, `FROM scratch` | CI-sjekk `build-images` |
| Hub med 100 agenter og 10 nettlesere på oversikten (`scripts/loadtest/run.mjs`) | 340 MB RSS på topp, 6,6 % av én kjerne i snitt (topp 23 %), 100/100 agenter tilkoblet hele tiden, 0 droppede `stream`, 3 min | målt 2026-09-15 på Apple Silicon, `dotnet run` |
| Lagring av 100 fulle 24-timersbuffere (288 000 punkter) | under 1 s | `BufferTests.A_hundred_full_buffers_are_saved_in_under_a_second` |
| Web, første last | 94 kB gzip initial bundle | `apps/glimt-web/README.md` (fase 9) |

## Regler som aldri brytes

1. Agenten har ingen skrivekommandoer i protokollen. Den kan ikke endre noe på serveren.
2. Måledata går agent → hub → nettleser i minnet. Databasen ser aldri et måledatapunkt.
3. Logger videresendes bare mens en loggvisning er åpen, og lagres aldri.
4. 1 s-strømmen går bare når noen ser på; 30 s-øyeblikksbildet driver buffer og varsler.

## Privacy

*Written for people who create an account. The full policy moves to glimtpanel.com when the website is built.*

- **What the agent sends:** CPU, memory, disk, network, process names and command lines of the top processes,
  container names and images, systemd unit states, pending updates, listening ports, logged-in users, failed SSH
  attempts and firewall counters. Nothing else, and it cannot change anything on the server (the protocol has no
  write commands; the source is open).
- **What is stored:** your account (e-mail, name, password hash), server names, tags, alert settings, access grants
  and groups in MongoDB. Measurements live only in the hub's memory: a 24-hour ring per server that is written to a
  local file every 15 minutes so it survives a restart. Nothing older than 24 hours exists anywhere.
- **Logs are never stored.** Log lines stream from the agent to your browser only while you have a log view open, and
  the hub keeps none of them.
- **Who sees what:** only you, and people you have explicitly given read access to. The demo account is read-only.
- **E-mail:** confirmation, password reset, invitations and the alerts you have turned on. No newsletters, no tracking
  pixels. Push notifications go through your browser's push service with an encrypted payload.
- **Delete:** «Settings › Data › Delete everything» removes the account, its servers, grants, groups and alert history
  at once; «Download everything» gives you the same data as JSON first. Agents you leave behind are told to stop.
- **Hosting:** Dokploy on a server in the EU; MongoDB on the same server; no third-party analytics.

Questions: post@kodetank.no.

## Prosjekter

- **glimt-agent** (`apps/glimt-agent`) – liten Go-binær på serveren som kun leser CPU, minne, disk, nettverk, prosesser, containere og logger, og sender dem til huben.
- **glimt-hub** (`apps/glimt-hub`) – .NET 10-tjeneste som håndterer innlogging, servere, tilganger, 24-timersminne og varsler, og videresender sanntidsstrømmen til dashbordet.
- **glimt-web** (`apps/glimt-web`) – Angular-dashbord (PWA) der brukeren ser alle servere, detaljer per server og varsler.
- **glimt-site** (`apps/glimt-site`) – nettsiden i Astro. Kun et skall i denne omgangen; utvikles senere.
- **packages/design-tokens** – delte designtokens og Inter-fonter. **packages/protocol** – JSON Schema for agent ↔ hub.
- **e2e** – Playwright-tester i tre prosjekter (desktop, mobil WebKit, mobil Chromium).

Hver mappe har en README som beskriver hva som er bygget og hvordan det testes.

## Komme i gang (utvikling)

Krav: Node 22+, .NET SDK 10, Docker Desktop (for agent-containeren). Go trengs ikke, agenten bygges i Docker.

```sh
git config core.hooksPath .githooks   # nekter commit av markdown (utenom README.md og CLAUDE.md) og .env-filer
npm install
cp example.env .env                   # standard for Docker-containere lokalt
cp example.env .env.dev               # hub og web direkte på maskinen; sett GLIMT_MONGO_URI
npm run doctor                        # sjekker verktøyene
npm run dev                           # hub (dotnet watch) + Ubuntu-container med agenten + web (ng serve)
```

`npm run dev` åpner dashbordet på http://localhost:4200, huben lytter på http://localhost:5080, og agent-containeren
`glimt-agent-dev` kobler seg til huben med `GLIMT_DEV_ENROL_KEY`. Flagg: `--no-agent`, `--no-web`, `--no-hub`, `--site`, `--plain-agent`, `--sidecar`
(starter i tillegg nginx-containeren `glimt-app-dev` med agenten som sidecar `glimt-sidecar-dev`, som containernoden
`sidecar-dev` på dev-kontoen via `GLIMT_DEV_CONTAINER_TOKEN`).

| Kommando | Gjør |
|---|---|
| `npm run dev:hub` / `dev:web` / `dev:agent` / `dev:site` | Starter én del |
| `npm run dev:stop` | Stopper agent-containeren og løpende prosesser |
| `npm test` | Unit-tester for web (Vitest), hub (xUnit) og agent (`go test` i Docker) |
| `npm run test:e2e` | Playwright (`GLIMT_E2E_BUILT=1` for bygget hub og web som i CI) |
| `npm run lint` | ESLint og `dotnet format` |
| `npm run build:images` | Bygger Docker-imagene slik Dokploy gjør det |
| `npm run dev:agent -- --logs` / `--shell` / `--measure` | Journal, shell eller ressursmåling i agent-containeren |
| `node scripts/agent-container.mjs --sidecar` / `--sidecar-logs` / `--sidecar-snapshot` / `--sidecar-stop` | Sidecar-containeren (fase 12) mot den lokale huben |
| `node scripts/loadtest/run.mjs` | Lasttest: 100 falske agenter + 10 nettlesere, måler huben |

CI (`.github/workflows/ci.yml`): lint, kontrakt, unit-tester, `npm audit`/`dotnet list package --vulnerable`/
`govulncheck`, Docker-imagene, hele e2e-suiten mot bygget hub og web, og agentutgivelse ved tag `agent/v*`.
`nightly.yml` kjører skjerm 4, 5 og 7 mot den ekte agenten i Ubuntu-containeren.

## Miljøfiler

Kun `example.env` sjekkes inn. `.env` er standard for Docker-containere lokalt, `.env.dev` overstyrer når hub og web kjører
direkte på maskinen, `.env.prod` limes inn i Dokploy. Alle nøkler har prefiks `GLIMT_` og er dokumentert i `example.env`.

## Regler for git

- Kun `README.md` og `CLAUDE.md` (instruksjoner til Claude Code) av markdown-filer sjekkes inn. Kun `example.env` av env-filer sjekkes inn. Håndheves av `.githooks/pre-commit`.
- Måledata lagres aldri i databasen. Agenten har ingen skrivekommandoer.

## Lisens

Avklares av eier før første publisering (anbefalt: MIT for agenten, AGPL-3.0 for hub og web). Ingen LICENSE-fil er lagt
inn ennå; til det er gjort er all rett forbeholdt.
