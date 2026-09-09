# glimt-agent

Glimtpanel-agenten: én statisk Go-binær som leser CPU, minne, disk, nettverk, prosesser, containere og logger fra en
Ubuntu-server og sender dem til huben over én WebSocket. **Den kan ikke endre noe på serveren.** Løftet er teknisk:
agenten kjører som `DynamicUser=yes` med `ProtectSystem=strict`, den har ingen skrivekommandoer i protokollen, og
Docker leses anbefalt gjennom en socket-proxy med `POST=0`.

Status: gående skjelett (plan steg 0.9) med kjernen fra steg 1.1 og installasjonen fra 0.6/1.11. Agenten sender
`hello`, tar imot `welcome`, svarer `pong` på `ping`, lagrer og roterer token, sender `snapshot` hvert hjerteslag
og `stream` ved abonnement (foreløpig kun CPU/minne/last/oppetid), og svarer `logEnd` med `unavailable` på
`logStart`. Disk, nettverk, prosesser, Docker, systemd, sikkerhet og logger kommer i steg 1.2–1.9.

## Bygg og test (Docker, Go trengs ikke på maskinen)

```sh
# gofmt, go vet, go test, go build – alt i golang:1.25 med cachede moduler
docker run --rm -v "$PWD/apps/glimt-agent":/src -w /src \
  -v glimt-go-cache:/go/pkg/mod -v glimt-go-build:/root/.cache/go-build -e CGO_ENABLED=0 \
  golang:1.25 sh -c "gofmt -l . && go vet ./... && go test ./... && go build ./..."

# eller fra rot:
npm run test:agent

# shellcheck på installasjonsskriptet
docker run --rm -v "$PWD/apps/glimt-agent/install":/s koalaman/shellcheck:stable /s/install.sh

# utgivelsesartefakter (linux/amd64 + linux/arm64 + SHA256SUMS) til apps/glimt-agent/out/
docker build -f apps/glimt-agent/Dockerfile.build --build-arg VERSION=0.1.0 \
  --output type=local,dest=apps/glimt-agent/out .
```

Alle kommandoer kjøres fra repo-roten (byggkonteksten er roten). Modulen er
`github.com/opdahlmann/glimtpanel/apps/glimt-agent`, Go 1.25, avhengigheter kun `github.com/coder/websocket` og
`golang.org/x/sys`. Binæren bygges med `CGO_ENABLED=0 -ldflags "-s -w -X main.version=…"` og er rundt 6 MB.

## Kommandoer

| Kommando | Gjør |
|---|---|
| `glimt-agent run` (standard) | Kobler til huben og rapporterer til den stoppes (SIGTERM/SIGINT gir ren avslutning) |
| `glimt-agent check` | Skriver ut hva maskinen tilbyr: OS, `/proc`, systemd, journald, Docker-socket/-proxy, needrestart, ufw, fail2ban, state-dir og token |
| `glimt-agent version` | Versjon, OS/arkitektur og Go-versjon |
| `sudo glimt-agent uninstall [--dry-run]` | Stopper og deaktiverer enheten, fjerner enhet, drop-ins, `/etc/glimt-agent`, `/var/lib/glimt-agent` og binæren, skriver hva som ble fjernet |

## Flagg og miljøvariabler

Flagg vinner over miljø. Under systemd leses miljøet fra `/etc/glimt-agent/env` (`EnvironmentFile=`).

| Flagg | Miljø | Standard | Betydning |
|---|---|---|---|
| `--hub` | `GLIMT_HUB` (alias `GLIMT_AGENT_HUB_WS`) | – (påkrevd) | WebSocket-URL, `ws://` eller `wss://` |
| `--key` | `GLIMT_AGENT_KEY` (alias `GLIMT_DEV_ENROL_KEY`) | – | Innrulleringsnøkkel `gp_…`. Brukes kun til et token er lagret |
| `--name` | `GLIMT_AGENT_NAME` | maskinens hostname | Navnet som rapporteres i `hello` |
| `--docker` | `GLIMT_AGENT_DOCKER` | `none` | `none`, `socket` eller `proxy` |
| `--proxy-url` | `GLIMT_AGENT_PROXY_URL` | `tcp://127.0.0.1:2375` | Adresse til docker-socket-proxy |
| `--state-dir` | `STATE_DIRECTORY` | `/var/lib/glimt-agent` | Her ligger `token` (0600, skrives atomisk) |
| `--heartbeat` | `GLIMT_HEARTBEAT_SECONDS` | `30` | Snapshot-intervall til huben sier noe annet i `welcome.snapshotInterval` |
| `--log-level` | `GLIMT_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. Logg går til stderr som `level=… msg=…` (journald-vennlig) |

Oppførsel som er verdt å vite:

- **Innrullering.** Uten token sendes `hello` med `enrolKey`; `welcome.token` lagres i state-dir. Neste tilkobling
  bruker tokenet. `rotate` skriver nytt token atomisk.
- **Gjenoppkobling.** Eksponentiell backoff 1 s → 60 s pluss 0–10 s tilfeldig tillegg. Nullstilles etter `welcome`.
- **`authFailed`.** Agenten logger «run `sudo glimt-agent uninstall` if this server was removed» og venter 1 time før
  nytt forsøk. Ved `invalidToken`/`serverRemoved` og en konfigurert nøkkel forkastes tokenet, slik at neste forsøk
  innrullerer på nytt (nyttig i utvikling med den evige dev-nøkkelen).
- **Sendekø.** 64 meldinger. Når køen er full droppes `stream`, aldri `snapshot`; antall droppede logges hvert minutt.
- **Rammer.** Maks 1 MB inn. Ingen trafikk fra huben på 2 minutter (huben pinger hvert 30. sekund) gir ny tilkobling.
- **systemd.** `Type=notify`: agenten sender `READY=1` straks (den er «oppe» også mens den venter på huben) og
  `STOPPING=1` ved stopp, uten cgo.

## Installasjon på en server

```sh
curl -fsSL https://get.glimtpanel.com/install | sudo sh -s -- --key gp_xxx
```

`install/install.sh` er POSIX `sh`, ligger i sin helhet i `main()` som kalles på siste linje (avkuttet nedlasting
kjører ingenting), krever root (kjører seg selv med `sudo` når det er en fil), finner `amd64`/`arm64`, laster
`glimt-agent-linux-<arch>` og `SHA256SUMS` fra GitHub Release `agent/vX.Y.Z` i `opdahlmann/glimtpanel`, verifiserer
med `sha256sum -c`, legger binæren i `/usr/local/bin/glimt-agent`, skriver `/etc/glimt-agent/env` (0600) og enheten,
`systemctl daemon-reload` + `enable` + `restart`. Skriptet er idempotent; reinstallasjon uten `--key` beholder forrige
nøkkel eller det lagrede tokenet.

| Valg | Betydning |
|---|---|
| `--hub URL` | Standard `wss://api.glimtpanel.com/agent/ws` |
| `--docker proxy` (standard) | Skriver ut `docker run`-kommandoen for `tecnativa/docker-socket-proxy` (`CONTAINERS=1 IMAGES=1 EVENTS=1 INFO=1 POST=0`, bundet til `127.0.0.1:2375`) |
| `--docker simple` | Legger drop-in `SupplementaryGroups=docker` og advarer om at docker-gruppen er root-ekvivalent |
| `--docker none` | Ingen containere |
| `--version X.Y.Z` | Standard `$GLIMT_AGENT_VERSION` eller `latest` |
| `--local` | Bruker binæren som allerede ligger i `/usr/local/bin/glimt-agent` (Dockerfile.dev og CI) |
| `--uninstall` | Samme som `glimt-agent uninstall` |

Skriptet avslutter alltid med setningen: *Glimtpanel agent reads CPU, memory, disk, network, processes, containers
and logs. It cannot change anything on this server.*

### systemd-enheten (`install/glimt-agent.service`)

`Type=notify`, `DynamicUser=yes`, `StateDirectory=glimt-agent` (gir `STATE_DIRECTORY=/var/lib/glimt-agent`),
`SupplementaryGroups=systemd-journal adm`, `ProtectSystem=strict`, `ProtectHome=yes`, `NoNewPrivileges=yes`,
`PrivateTmp=yes`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK`, `CapabilityBoundingSet=CAP_SYS_PTRACE`
og `AmbientCapabilities=CAP_SYS_PTRACE` (for å se hvilken prosess som eier en port), `MemoryMax=64M`, `Restart=always`,
`RestartSec=5`, pluss `UMask`, `ProtectKernel*`, `ProtectClock`, `ProtectHostname`, `PrivateDevices`,
`RestrictNamespaces`, `RestrictRealtime`, `RestrictSUIDSGID`, `LockPersonality` og `SystemCallArchitectures=native`.
`ProtectProc`, `ProcSubset` og `ProtectControlGroups` settes bevisst ikke: agenten må lese `/proc` og
`/sys/fs/cgroup`. En test sikrer at enheten innebygd i `install.sh` er identisk med filen.

## Dev-container (`Dockerfile.dev`)

`npm run dev:agent` (eller `node scripts/agent-container.mjs --start`) bygger `glimt-agent-dev` fra repo-roten og
starter `ubuntu:24.04` med systemd som PID 1 (`--privileged --cgroupns=host`, Docker-socketen montert read-only).
Ved bygg kjøres `install.sh --local` (uten systemd; enheten aktiveres for oppstart). Ved oppstart:

| Enhet | Gjør |
|---|---|
| `glimt-dev-env.service` (oneshot, før agenten) | Leser `GLIMT_AGENT_HUB_WS`, `GLIMT_DEV_ENROL_KEY`, `GLIMT_AGENT_NAME`, `GLIMT_HEARTBEAT_SECONDS` fra `/proc/1/environ` og skriver `/etc/glimt-agent/env` med `GLIMT_AGENT_DOCKER=socket` |
| `glimt-agent.service` | Agenten, akkurat som på en ekte server |
| `noise.service` | Hvert 60. sekund: fem journallinjer (én tagget `sshd` med «Failed password …») og 3 s CPU med `sha256sum /dev/zero` |
| `noise-fail.service` (ikke aktivert) | `systemctl start noise-fail` gir en feilet enhet på kommando |

```sh
npm run dev:agent -- --logs      # journalctl -u glimt-agent -f
npm run dev:agent -- --shell     # bash i containeren
npm run dev:agent -- --measure   # systemd-cgtop
node scripts/agent-container.mjs --start --plain   # uten systemd: kjører `glimt-agent run` direkte, se `docker logs`
node scripts/agent-container.mjs --stop
```

Filene ligger i `dev/`: `glimt-dev-env.sh`, `glimt-dev-env.service`, `glimt-noise.sh`, `noise.service`,
`noise-fail.service`.

## Protokoll

`internal/protocol` speiler `packages/protocol/agent-hub.schema.json` med camelCase-JSON-tagger for alle
meldingstyper. `Decode` leser `type` og fyller riktig struct (ukjente felt ignoreres), `Encode` sørger for at `type`
(og `hello.v`) er satt og at `type` kommer først. Testen kjører alle eksemplene i `packages/protocol/examples/` gjennom
`Decode` → `Encode` og krever semantisk lik JSON.

## Struktur

```
cmd/glimt-agent/      main.go (run, flagg/miljø), check.go, uninstall.go
internal/protocol/    meldingsstructer, Decode/Encode
internal/state/       token i state-dir, 0600, atomisk
internal/sysinfo/     hostname, /etc/os-release, uname, arch, kjerner, RAM, boot-tid
internal/collect/     /proc/stat, /proc/meminfo, /proc/loadavg, /proc/uptime → protocol.Host
internal/ws/          klient, sendekø, backoff, ping/pong, rotate, subscribe
internal/sched/       snapshot-, stream- og vedlikeholdstikkere
internal/sdnotify/    READY=1 / STOPPING=1 over NOTIFY_SOCKET
internal/docker/      /_ping mot socket eller proxy (brukes av check)
install/              install.sh, glimt-agent.service
dev/                  filer til Dockerfile.dev
Dockerfile.build      kryss-kompilering + SHA256SUMS
Dockerfile.dev        Ubuntu 24.04 + systemd + agent
```

## Ressursbruk

Måles i steg 1.12 med `npm run dev:agent -- --measure` (`systemd-cgtop`) i tre tilstander. Mål: under 15 MB RSS og
0,1 % CPU i hvile, under 20 MB og 1 % med én abonnent.

| Tilstand | RSS | CPU | Merknad |
|---|---|---|---|
| Hvile (ingen abonnenter) | ~10 MB (foreløpig, `ps` i dev-containeren, ikke tilkoblet hub) | 0,0 % | fylles inn i 1.12 |
| Én abonnent (stream 1 s) | – | – | fylles inn i 1.12 |
| Én abonnent + loggstrøm | – | – | fylles inn i 1.12 |
