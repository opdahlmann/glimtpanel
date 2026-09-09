# Glimtpanel

## Utviklingsbrukere i GlimtpanelDev

Kontoer som er opprettet i utviklingsdatabasen `GlimtpanelDev`. Passordene gjelder kun denne databasen. Tabellen ryddes av eier før beta.

| E-post | Passord | Rolle | Merknad |
|---|---|---|---|
| dev@glimtpanel.local | GlimtDev-2026! | eier | Seedes automatisk av huben når `GLIMT_ENV=development` (fra `GLIMT_DEV_USER_*` i `.env`) |

---

Ett nettleservindu som viser hva alle serverne dine gjør akkurat nå. En liten agent på hver Ubuntu-server, ett dashboard for alle.

## Prosjekter

- **glimt-agent** (`apps/glimt-agent`) – liten Go-binær på serveren som kun leser CPU, minne, disk, nettverk, prosesser, containere og logger, og sender dem til huben.
- **glimt-hub** (`apps/glimt-hub`) – .NET 10-tjeneste som håndterer innlogging, servere, tilganger, 24-timersminne og varsler, og videresender sanntidsstrømmen til dashbordet.
- **glimt-web** (`apps/glimt-web`) – Angular-dashbord (PWA) der brukeren ser alle servere, detaljer per server og varsler.
- **glimt-site** (`apps/glimt-site`) – nettsiden i Astro. Kun et skall i denne omgangen; utvikles senere.
- **packages/design-tokens** – delte designtokens og Inter-fonter. **packages/protocol** – JSON Schema for agent ↔ hub.
- **e2e** – Playwright-tester i tre prosjekter (desktop, mobil WebKit, mobil Chromium).

## Komme i gang

Krav: Node 22+, .NET SDK 10, Docker Desktop (for agent-containeren). Go trengs ikke, agenten bygges i Docker.

```sh
git config core.hooksPath .githooks   # nekter commit av markdown (utenom README.md) og .env-filer
npm install
cp example.env .env                   # standard for Docker-containere lokalt
cp example.env .env.dev               # hub og web direkte på maskinen; sett GLIMT_MONGO_URI
npm run doctor                        # sjekker verktøyene
npm run dev                           # hub (dotnet watch) + Ubuntu-container med agenten + web (ng serve)
```

`npm run dev` åpner dashbordet på http://localhost:4200, huben lytter på http://localhost:5080, og agent-containeren
`glimt-agent-dev` kobler seg til huben med `GLIMT_DEV_ENROL_KEY`. Flagg: `--no-agent`, `--no-web`, `--no-hub`, `--site`, `--plain-agent`.

| Kommando | Gjør |
|---|---|
| `npm run dev:hub` / `dev:web` / `dev:agent` / `dev:site` | Starter én del |
| `npm run dev:stop` | Stopper agent-containeren og løpende prosesser |
| `npm test` | Unit-tester for web (Vitest), hub (xUnit) og agent (`go test` i Docker) |
| `npm run test:e2e` | Playwright |
| `npm run lint` | ESLint og `dotnet format` |
| `npm run build:images` | Bygger Docker-imagene slik Dokploy gjør det |
| `npm run dev:agent -- --logs` / `--shell` / `--measure` | Journal, shell eller ressursmåling i agent-containeren |

## Miljøfiler

Kun `example.env` sjekkes inn. `.env` er standard for Docker-containere lokalt, `.env.dev` overstyrer når hub og web kjører
direkte på maskinen, `.env.prod` limes inn i Dokploy. Alle nøkler har prefiks `GLIMT_` og er dokumentert i `example.env`.

## Regler for git

- Kun `README.md` av markdown-filer sjekkes inn. Kun `example.env` av env-filer sjekkes inn. Håndheves av `.githooks/pre-commit`.
- Måledata lagres aldri i databasen. Agenten har ingen skrivekommandoer.

## Lisens

Avklares før første publisering (anbefalt: MIT for agenten, AGPL-3.0 for hub og web).
