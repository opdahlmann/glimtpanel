# glimt-agent

Glimtpanel-agenten: én statisk Go-binær som leser CPU, minne, disk, nettverk, prosesser, containere og logger fra en
Ubuntu-server og sender dem til huben over én WebSocket. **Den kan ikke endre noe på serveren.** Løftet er teknisk:
agenten kjører som systembrukeren `glimt-agent` med `ProtectSystem=strict`, den har ingen skrivekommandoer i protokollen, og
Docker leses anbefalt gjennom en socket-proxy med `POST=0`.

Status: fase 1 er levert. Agenten sender `hello`, tar imot `welcome`, svarer `pong` på `ping`, lagrer og roterer
token, sender `snapshot` hvert hjerteslag (vert, containere, tjenester, vedlikehold, sikkerhet) og `stream` ved
abonnement (vert, container-statistikk, toppprosesser), og strømmer logger fra journald, webserverlogger og Docker på
`logStart`/`logStop`. Innsamlingen fra `/proc` og `systemctl` ligger i `internal/collect`; Docker, journal, loggstrømmer
og tidsplan beskrives under.

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
| `glimt-agent check` | Skriver ut hva maskinen tilbyr: valgt profil (`kind`) med begrunnelse, OS, `/proc`, systemd, journald med tellere (sshd-feil, ufw, fail2ban), webserverlogger, Docker-socket/-proxy med forhandlet API-versjon og antall containere, needrestart, ufw, fail2ban, state-dir og token. I en container: container-id, cgroup-katalog, grenser, prosess-synlighet, nettverk, helse-URL, sjekker, loggstier, image og token |
| `glimt-agent snapshot [--wait 1s]` | Skriver én komplett `snapshot`-melding som pen JSON og avslutter. Trenger ingen hub. Måler to ganger med `--wait` mellom, slik at ratene (CPU, disk, nett, container-CPU) er ekte |
| `glimt-agent stream [--wait 1s] [--top 40]` | Skriver én `stream`-melding (vert, container-statistikk, toppprosesser) |
| `glimt-agent logs --source journal\|auth\|kernel\|packages\|web\|firewall\|container\|file [--unit X] [--container Y] [--path P] [--priority err\|warn\|info] [--tail 20] [--since 1h] [--follow]` | Skriver linjer fra en loggkilde gjennom samme strømbehandler som huben bruker. Uten `--follow` stopper den når halen er skrevet. Avslutter med kode 1 og `stream ended: <reason>` når kilden er utilgjengelig |
| `glimt-agent version` | Versjon, OS/arkitektur og Go-versjon |
| `sudo glimt-agent uninstall [--dry-run]` | Stopper og deaktiverer enheten, fjerner enhet, drop-ins, `/etc/glimt-agent`, `/var/lib/glimt-agent` og binæren, skriver hva som ble fjernet |

`check`, `snapshot`, `stream` og `logs` leser `/etc/glimt-agent/env` bak miljøet, så `--docker` følger installasjonen.
`snapshot` og `stream` bruker `sched.Scheduler` direkte (`Prime` → vent → `Snapshot`/`Stream`), altså nøyaktig samme kode
som sender til huben.

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
| `--kind` | `GLIMT_KIND` | `auto` | `auto`, `server` eller `container`. `auto` velger `container` når `/.dockerenv` eller `/run/.containerenv` finnes, `/proc/1/cgroup` nevner docker/kubepods/containerd/libpod/ecs, eller en plattformvariabel er satt (`KUBERNETES_SERVICE_HOST`, `K_SERVICE`, `ECS_CONTAINER_METADATA_URI*`, `RAILWAY_ENVIRONMENT`, `RENDER`, `GLIMT_TOKEN`) |

Containerprofilen (`--kind container`) leser i tillegg (ingen `--key`, ingen innrullering):

| Miljø | Betydning |
|---|---|
| `GLIMT_TOKEN` | Langtlevende nodetoken fra «Add container» i dashbordet (`POST /api/servers`). Leses ved hver oppstart; `--state-dir` brukes bare hvis katalogen finnes (valgfritt volum) |
| `GLIMT_NODE_NAME` | Navnet i `hello` (standard containerens hostname). Alias for `GLIMT_AGENT_NAME` |
| `GLIMT_HEALTH_URL` | `GET` hvert 30. s med 3 s timeout, uten å følge omdirigeringer; 2xx = ok. Resultatet i `snapshot.health` |
| `GLIMT_CHECKS` | `db=postgres:5432,cache=redis:6379`: TCP-connect til hvert mål hvert 30. s med 2 s timeout → `snapshot.checks[]` |
| `GLIMT_LOG_PATHS` | Kommaseparerte filer eller kataloger som `logStart` med `source: file` får hale (`tail -F`-semantikk med rotasjonsdeteksjon). Andre stier avvises med `unavailable` |
| `GLIMT_IMAGE` | Vises som imaget i `hello.image` (huben finner det også fra vertsagenten når containeren er lenket) |

Oppførsel som er verdt å vite:

- **Innrullering.** Uten token sendes `hello` med `enrolKey`; `welcome.token` lagres i state-dir. Neste tilkobling
  bruker tokenet. `rotate` skriver nytt token atomisk.
- **Gjenoppkobling.** Eksponentiell backoff 1 s → 60 s pluss 0–10 s tilfeldig tillegg. Nullstilles etter `welcome`.
- **`authFailed`.** Agenten logger «run `sudo glimt-agent uninstall` if this server was removed» og venter 1 time før
  nytt forsøk. Ved `invalidToken`/`serverRemoved` og en konfigurert nøkkel forkastes tokenet, slik at neste forsøk
  innrullerer på nytt (nyttig i utvikling med den evige dev-nøkkelen).
- **Sendekø.** 64 meldinger. Når køen er full droppes `stream` og `log`, aldri `snapshot`, `logEnd` eller `pong`;
  antall droppede logges hvert minutt.
- **`logStart` før `welcome`** besvares med `logEnd` (`error`, «logStart before welcome»).
- **Rammer.** Maks 1 MB inn. Ingen trafikk fra huben på 2 minutter (huben pinger hvert 30. sekund) gir ny tilkobling.
- **systemd.** `Type=notify`: agenten sender `READY=1` straks (den er «oppe» også mens den venter på huben) og
  `STOPPING=1` ved stopp, uten cgo.

## Containernoder (fase 12)

Agenten kan kjøre **inne i** en container, som en sidecar ved siden av appen eller som binær i appens eget image, og
rapporterer da containeren som en egen node (`hello.kind: container`). Profilen slår av alt som forutsetter en server
(systemd, journald, apt, Docker, innlogginger, brannmur) og rapporterer det innsiden ser: CPU og minne fra cgroupen
når den er den riktige, ellers en sum over synlige prosesser merket `approx`; rot (overlay, vist som `/`) og volumer fra
`mountinfo`; grensesnitt; prosesser i det delte pid-namespacet; lyttende porter; helsesjekk og TCP-sjekker; filer i
`GLIMT_LOG_PATHS`. Ved SIGTERM/SIGINT sendes `bye {reason: shutdown}` (maks 1 s) før socketen lukkes, så huben viser
noden som *sleeping* i stedet for nede.

### Sidecar i Compose

```yaml
services:
  app:
    image: your-app:latest
  glimt-agent:
    image: ghcr.io/opdahlmann/glimt-agent:latest
    pid: "service:app"            # appens prosesser og porter
    network_mode: "service:app"   # appens nettverk; GLIMT_HEALTH_URL peker på 127.0.0.1
    read_only: true
    restart: unless-stopped
    environment:
      GLIMT_HUB: wss://hub.example.com/agent/ws
      GLIMT_TOKEN: agt_…            # fra «Add container» i dashbordet
      GLIMT_NODE_NAME: api-1
      # GLIMT_HEALTH_URL: http://127.0.0.1:8080/healthz
      # GLIMT_CHECKS: db=postgres:5432,cache=redis:6379
      # GLIMT_LOG_PATHS: /var/log/app   # monter appens loggvolum inn i sidecaren også
```

Med Dockers standard (privat cgroup-namespace) ser sidecaren *sin egen* cgroup, ikke appens; CPU og minne summeres da
over prosessene og merkes `approx`. Legg `cgroup: host` på sidecar-tjenesten (og monter `/sys/fs/cgroup` read-only)
for ekte cgroup-tall. Stdout-loggen kommer fra vertsagenten når samme eier har en (huben lenker på container-id).

### Binær i eget image (Cloud Run, Fargate, Railway, Render …)

```Dockerfile
COPY --from=ghcr.io/opdahlmann/glimt-agent:latest /glimt-agent /usr/local/bin/glimt-agent
ENV GLIMT_HUB=wss://hub.example.com/agent/ws GLIMT_NODE_NAME=api-1
# GLIMT_TOKEN settes som hemmelighet på plattformen, ikke i imaget
ENTRYPOINT ["/bin/sh", "-c", "glimt-agent run & exec \"$0\" \"$@\""]
CMD ["your-app"]
```

Her deler agenten cgroup med appen og får riktige tall. På gVisor (Cloud Run) mangler cgroup-filene og `/proc` er
begrenset: agenten starter likevel, melder `capabilities` ærlig og summerer prosessene (`approx`). Stdout-logger finnes
ikke uten en vertsagent; bruk `GLIMT_LOG_PATHS`.

### Hva agenten ser inne i en container

Målt i steg 12.1 med dagens binær som sidecar ved siden av `nginx:1.27` (`--memory 256m --cpus 1.5`) på Docker
Desktop, med `--pid=container:app --network=container:app`, som uid 65532:

| Kilde | Privat cgroupns (Docker-standard) | `--cgroupns=host` | Uten delt pid-namespace | Profilen |
|---|---|---|---|---|
| `/proc/stat`, `/proc/meminfo` | Leses, men viser **verten** | Verten | Verten | Brukes ikke til CPU/minne; `meminfo` gir total når grense mangler |
| `/sys/fs/cgroup/{cpu.stat,memory.current,memory.max,cpu.max}` | Sidecarens egen cgroup, ikke appens | Appens cgroup lesbar under `/sys/fs/cgroup/docker/<id>` (sti fra `/proc/1/cgroup`) | Egen cgroup | Brukes bare når den lesbare cgroupen er containeren som måles (binær i imaget, eller cgroupns host); ellers fallback |
| `/proc/1/cgroup` | `0::/../<64-hex id>` → container-id, sti ikke nåbar | `0::/docker/<id>` | Egen `0::/` | `containerId` = første 12 tegn; ellers fra `/proc/self/cgroup`, ellers hostname |
| `/proc/self/mountinfo` | Leses (overlay-rot + volumer) | Samme | Samme | `mounts`: rot vises som `/` uten enhet, pseudo-filsystemer og `/proc`, `/sys`, `/dev` filtreres |
| `/proc/net/dev`, `/proc/net/tcp*` | Appens nettverk | Samme | Eget nettverk (tomt) | `ifaces` og `listeningPorts` |
| `/proc/<pid>` for appens prosesser | Lesbart (`stat`, `status`, `cmdline`); `fd` avvises som uid 65532 | Samme | Kun egne prosesser | Prosesser og prosess-summer; porter uten eierprosess |
| `journalctl`, Docker-socket, `systemctl`, `apt` | Finnes ikke | – | – | Utelatt: ingen `services`, `maintenance`, `loggedIn`, `sshFailed`, `firewall` |

Fallback-summen for minne er anonymt minne (`RssAnon` + `RssShmem`) summert over synlige prosesser pluss fildelte
sider talt én gang (største `RssFile`); `VmRSS` summert ville telt hvert delt bibliotek én gang per worker (nginx med
12 workere: 44 MiB mot cgroupens 10 MiB; anslaget gir 27 MiB). Agentens egen prosess holdes utenfor. Sidecaren selv
bruker ≈ 7 MB RSS i hvile.

```sh
npm run dev -- --sidecar                              # nginx + sidecar som noden sidecar-dev (GLIMT_DEV_CONTAINER_TOKEN)
node scripts/agent-container.mjs --sidecar --cgroupns-host   # appens cgroup i stedet for approx
node scripts/agent-container.mjs --sidecar-check | --sidecar-snapshot | --sidecar-logs | --sidecar-stop
docker build -f apps/glimt-agent/Dockerfile.sidecar -t glimt-agent-sidecar .   # FROM scratch, ~7 MB, USER 65532
```

## Tidsplan (`internal/sched`)

| Tikker | Intervall | Innhold |
|---|---|---|
| snapshot | `welcome.snapshotInterval` (30 s), første straks etter `welcome` | `host`, `containers` (liste + statistikk), `services`, `maintenance` (cachet), `security` (med journal-tellere) |
| stream | `subscribe.intervalMs` (1 s / 5 s), kun mellom `subscribe` og `unsubscribe`/frakobling | `host`, container-statistikk, `subscribe.topProcs` prosesser (standard 40) og totaler |
| vedlikehold | `welcome.maintenanceInterval` (10 min), første ved start | `System.Maintenance()` (oppdateringer, reboot, needrestart-cache) og `journal.Counter.Refresh()` (sshd/ufw/fail2ban siste 24 t) |

- **Én måling deles.** Vert og container-statistikk måles én gang og gjenbrukes av en `snapshot` og en `stream` som
  faller sammen (yngre enn 1 s, eller halve stream-intervallet). CPU-prosent er alltid delta mot forrige måling.
- **Docker-hendelser.** `/events` (kun container-hendelser) holdes åpen hele tiden; hver hendelse ugyldiggjør
  inspect-cachen for containeren, og etter 2 s ro sendes en ekstra `snapshot` med ny liste.
- **Feiltoleranse.** Hver samler (host, docker list, docker stats, services, security, processes, maintenance,
  journal counts) får 10 s per kall. Feiler den, logges det én gang per time per samler (`collector failed; section
  omitted`), seksjonen utelates og resten av meldingen sendes likevel.
- **Cache over gjenoppkobling.** Vedlikeholdsseksjonen og journal-tellerne bor i objekter som lever like lenge som
  prosessen; en ny tilkobling innen intervallet kjører ikke `apt-get` og `journalctl` på nytt.
- **Tid i testene.** `sched_test.go` kjører hver test i en `testing/synctest`-boble (Go 1.25): `time.Sleep` flytter
  boblens klokke og `synctest.Wait()` lar planleggeren tikke ferdig, så kadens, debounce og gjenbruk testes på
  millisekunder uten egen klokke-abstraksjon.

## Docker (`internal/docker`)

Tre tilgangsmåter, valgt med `--docker` / `GLIMT_AGENT_DOCKER`:

| Modus | Hva agenten gjør |
|---|---|
| `none` | Ingen containere. `hello.dockerMode = none` |
| `socket` | Snakker med `/var/run/docker.sock`. Krever at tjenesten er i `docker`-gruppen (`install.sh --docker simple` legger drop-in `SupplementaryGroups=docker`). Gruppen er root-ekvivalent |
| `proxy` (anbefalt) | Snakker med `tecnativa/docker-socket-proxy` på `--proxy-url` (standard `tcp://127.0.0.1:2375`). Proxyen trenger `CONTAINERS=1 IMAGES=1 EVENTS=1 INFO=1 POST=0`; `/version`, `/_ping`, `/containers/*` (inkl. `json`, `stats`, `logs`), `/images/*/json` og `/events` er alt som brukes |

Er daemonen ikke tilgjengelig ved start, logges en advarsel, `hello` sier `none`, og agenten prøver videre; når
listen lykkes, rapporterer neste `hello` riktig modus.

- **API-versjon** forhandles én gang via `GET /version` og settes i stien (`/v1.47/...`). Minimum er 1.41 (Docker
  20.10); eldre daemoner avvises med tydelig feil (`check` viser versjonen).
- **Liste** (`/containers/json?all=1`): id (12 tegn), navn uten `/`, image, `imageCreated` fra `/images/{id}/json`
  (cachet per image-id), state (`exited`/`removing` → `stopped`), `health` fra inspect (`none` når containeren ikke
  kjører), `restartCount`, `startedAt`, porter som `80→8080` (`/udp` for UDP, IPv4/IPv6-duplikater fjernes), mounts
  som `kilde → mål` (navngitte volumer med navn), `compose` fra `com.docker.compose.project`. Inspect cachet per
  container i 5 min og ugyldiggjøres av hendelser.
- **Statistikk** leses fra cgroup v2-filer, ikke fra `stats`-API-et: `cpu.stat usage_usec`-delta → `cpuPct` (100 % =
  én kjerne), `memory.current` minus `inactive_file` → `memBytes`, `memory.max` (ellers `HostConfig.Memory`, ellers
  vertens RAM) → `memLimit`. Stien prøves i rekkefølgen `/sys/fs/cgroup/system.slice/docker-<id>.scope`,
  `/sys/fs/cgroup/docker/<id>`, så `HostConfig.CgroupParent`. Nettverk summeres over alle grensesnitt unntatt `lo` i
  `/proc/<pid>/net/dev` for containerens hovedprosess.
- **Fallback.** Når `/proc/<pid>` ikke kan leses (annet pid-namespace, som i dev-containeren) hentes nettverk fra
  `GET /containers/{id}/stats?stream=false&one-shot=true`, høyst hvert 5. sekund per container; mangler også
  cgroup-katalogen, dekker samme kall CPU og minne. Mellom kallene gjentas forrige rate.
- **Logger** (`/containers/{id}/logs?follow=1&stdout=1&stderr=1&timestamps=1&tail=N&since=S`): 8-bytes rammehoder
  demultiplekses med delvise linjer per strøm; TTY-containere (inspect `Config.Tty`) kommer rå. Tidsstempelet foran
  hver linje blir `ts`; `container` er navnet; `priority` settes ikke for containere. Container kan oppgis som full id,
  kort id eller navn.

## Loggkilder (`internal/journal`, `internal/logs`)

`logStart.source` rutes slik:

| source | Kilde | Filter |
|---|---|---|
| `journal` | `journalctl -o json --no-pager -n <tail> -f` | ingen |
| `auth` | journalctl | `_COMM=sshd _COMM=sudo _COMM=su + SYSLOG_IDENTIFIER=systemd-logind + SYSLOG_IDENTIFIER=sshd` |
| `kernel` | journalctl | `-k` |
| `packages` | journalctl | `_COMM=apt _COMM=apt-get _COMM=dpkg _COMM=unattended-upgrade + SYSLOG_IDENTIFIER=unattended-upgrades` |
| `firewall` | to journalctl-prosesser | `-k -g UFW` og `_COMM=fail2ban-server`, hver med halve `tail` |
| `web` | tail av filer | `/var/log/nginx/{access,error}.log`, `/var/log/apache2/{access,error}.log` – de som kan leses (gruppe `adm`) |
| `container` | Docker | se over |
| `file` | reservert | `logEnd` med `unavailable` |

journalctl-syntaks: alternativer på samme felt OR-es automatisk, `+` OR-er hele ledd på tvers av felt, og flagg som
`-k`, `-u` og `-p` AND-es med leddene. `-g` gjelder hele utdataen, derfor er `firewall` to prosesser som flettes inn i
samme strøm. `auth` matcher også `SYSLOG_IDENTIFIER=sshd` (ikke bare `_COMM=sshd`) slik at linjer skrevet med
`logger -t sshd` – som støy-tjenesten i dev-containeren – vises. `--unit` blir `-u <unit>`, `priority` blir `-p 0..3`
(`err`), `-p 4..4` (`warn`), `-p 5..7` (`info`), `sinceMs` blir `--since=@<sek>`.

Hver JSON-linje parses til `ts` (`__REALTIME_TIMESTAMP` µs → ms), `priority` (`PRIORITY` ≤ 3 → `err`, 4 → `warn`,
ellers `info`), `unit` (`_SYSTEMD_UNIT` uten `.service`, ellers `SYSLOG_IDENTIFIER`, ellers `_COMM`) og `message`
(streng eller byte-array, som journald bruker for ikke-UTF-8). Prosessene startes i egen prosessgruppe med
`LC_ALL=C`; når strømmen stoppes får gruppen SIGTERM, etter 2 s SIGKILL, og prosessen reapes. Mangler `journalctl`
svarer strømmen `logEnd` med `unavailable`.

`web`-kilden leser de siste `tail` linjene fra slutten av filen og poller hvert 250 ms; nytt inode på stien
(logrotate) eller kortere fil (trunkering) gir ny åpning. `unit` er `nginx/access` osv.

**Strømbehandleren** (`internal/logs.Manager`, én per tilkobling) holder maks 8 samtidige strømmer (niende får
`logEnd` `error` «too many streams»), samler linjer i batcher hvert 100 ms med maks 200 linjer per `log`-melding,
holder inntil 1000 linjer per strøm mellom batcher og teller de eldste som droppes i `dropped`. `tail` uten verdi
betyr 200. Strømmen avsluttes med `logEnd`: `eof` (kilden tom, f.eks. stoppet container), `stopped` (`logStop`,
frakobling, avslutning), `unavailable` (journalctl/filer/Docker mangler, `file`) eller `error` (melding i `message`).
Samme `streamId` en gang til erstatter den gamle strømmen. Alle strømmer stoppes når tilkoblingen ryker.

**Journal-tellerne** (`journal.Counter`, brukt av sikkerhetsseksjonen) kjører hvert 10. minutt og ved start:

| Teller | Kommando |
|---|---|
| sshd-feil siste time / døgn og tre siste forsøk | `journalctl -o json -q --since=-24h _SYSTEMD_UNIT=ssh.service _SYSTEMD_UNIT=sshd.service + SYSLOG_IDENTIFIER=sshd`, linjer som matcher `Failed password\|Invalid user\|authentication failure`; bruker og adresse fra `for [invalid user ]X from Y` / `Invalid user X from Y` |
| ufw-blokkeringer | `journalctl -o cat -q --since=-24h -k -g "UFW BLOCK"` (antall linjer) |
| fail2ban-utestengelser | `journalctl -o cat -q --since=-24h -u fail2ban -g " Ban "` |

Matchen på `SYSLOG_IDENTIFIER=sshd` er bevisst: ekte sshd har både `_COMM=sshd` og `SYSLOG_IDENTIFIER=sshd`, mens
`logger -t sshd` bare setter identifikatoren. Dermed telles både ekte innbruddsforsøk og støy-linjen i
dev-containeren.

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

`Type=notify`, `User=glimt-agent` (fast systembruker), `StateDirectory=glimt-agent` (gir `STATE_DIRECTORY=/var/lib/glimt-agent`),
`SupplementaryGroups=systemd-journal adm`, `ProtectSystem=strict`, `ProtectHome=yes`, `NoNewPrivileges=yes`,
`PrivateTmp=yes`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK`, `CapabilityBoundingSet=CAP_SYS_PTRACE`
og `AmbientCapabilities=CAP_SYS_PTRACE` (for å se hvilken prosess som eier en port), `MemoryMax=64M`, `Restart=always`,
`RestartSec=5`, pluss `UMask`, `ProtectKernel*`, `ProtectClock`, `ProtectHostname`, `PrivateDevices`,
`RestrictNamespaces`, `RestrictRealtime`, `RestrictSUIDSGID`, `LockPersonality` og `SystemCallArchitectures=native`.
Steg 11.2 la til `RemoveIPC`, `ProtectControlGroups=yes` (`/sys/fs/cgroup` skrivebeskyttet; agenten leser bare),
`MemoryDenyWriteExecute`, `SystemCallFilter=@system-service` minus `@privileged @resources @obsolete @mount @swap
@reboot @raw-io @module @debug @cpu-emulation @clock` og `SystemCallErrorNumber=EPERM` (Go-kjøretiden prøver
`setrlimit` ved oppstart og tåler EPERM; uten det ville filteret gitt SIGSYS). `ptrace`-syscallet er filtrert bort;
`CAP_SYS_PTRACE` trengs bare for å lese `/proc/<pid>/` til andre brukere. `systemd-analyze security glimt-agent`
gir **1,8** i dev-containeren (målt 2026-09-15; kravet er under 3). `ProtectProc` og `ProcSubset` settes bevisst ikke:
agenten må lese hele `/proc`. En test sikrer at enheten innebygd i `install.sh` er identisk med filen; `shellcheck`
(`koalaman/shellcheck:stable`) er rent på `install.sh`.

## Dev-container (`Dockerfile.dev`)

`npm run dev:agent` (eller `node scripts/agent-container.mjs --start`) bygger `glimt-agent-dev` fra repo-roten og
starter `ubuntu:24.04` med systemd som PID 1 (`--privileged --cgroupns=host`, Docker-socketen montert read-only).
Ved bygg kjøres `install.sh --local --docker simple` (uten systemd; enheten aktiveres for oppstart). Bildet har
`openssh-server` (port 22 lytter, `PermitRootLogin no`, `PasswordAuthentication no`; ingen skal logge inn, men
sikkerhetsseksjonen får en ekte port og journalen ekte `sshd`-linjer) og `libnss-systemd`. Ved oppstart:

| Enhet | Gjør |
|---|---|
| `glimt-dev-env.service` (oneshot, før agenten) | Leser `GLIMT_AGENT_HUB_WS`, `GLIMT_DEV_ENROL_KEY`, `GLIMT_AGENT_NAME`, `GLIMT_HEARTBEAT_SECONDS`, `GLIMT_LOG_LEVEL` (standard `debug` her) fra `/proc/1/environ` og skriver `/etc/glimt-agent/env` med `GLIMT_AGENT_DOCKER=socket` og `GLIMT_KIND=server` (containeren spiller en server; auto-deteksjonen ville ellers sett `/.dockerenv` og krevd `GLIMT_TOKEN`). Docker Desktop monterer socketen som `root:root 660`, så skriptet gir tjenesten socketens gruppe via drop-in (`SupplementaryGroups=root`) og kjører `daemon-reload` før agenten starter |
| `glimt-agent.service` | Agenten, akkurat som på en ekte server |
| `ssh.service` | sshd på port 22 |
| `noise.service` | Hvert 60. sekund: fem journallinjer (én tagget `sshd` med «Failed password …») og 3 s CPU med `sha256sum /dev/zero` |
| `noise-fail.service` (ikke aktivert) | `systemctl start noise-fail` gir en feilet enhet på kommando |

```sh
npm run dev:agent -- --logs      # journalctl -u glimt-agent -f
npm run dev:agent -- --shell     # bash i containeren
npm run dev:agent -- --measure   # systemd-cgtop
node scripts/agent-container.mjs --start --plain   # uten systemd: kjører `glimt-agent run` direkte, se `docker logs`
node scripts/agent-container.mjs --stop

docker exec glimt-agent-dev glimt-agent snapshot                       # som root
docker exec glimt-agent-dev glimt-agent logs --source auth --tail 5
docker exec glimt-agent-dev glimt-agent logs --source container --container <navn> --tail 3
```

Begrensninger i dev-containeren: den har eget pid-namespace, så container-nettverk hentes via `stats`-API-et
(fallbacken over).

**Løst:** enheten bruker en fast systembruker i stedet for `DynamicUser` (se «Kjente begrensninger»).

## Protokoll

`internal/protocol` speiler `packages/protocol/agent-hub.schema.json` med camelCase-JSON-tagger for alle
meldingstyper. `Decode` leser `type` og fyller riktig struct (ukjente felt ignoreres), `Encode` sørger for at `type`
(og `hello.v`) er satt og at `type` kommer først. Testen kjører alle eksemplene i `packages/protocol/examples/` gjennom
`Decode` → `Encode` og krever semantisk lik JSON.

## Struktur

```
cmd/glimt-agent/      main.go (run, flagg/miljø), deps.go (kobling av samlere), check.go, snapshot.go (snapshot/stream),
                      logscmd.go (logs), uninstall.go
internal/protocol/    meldingsstructer, Decode/Encode
internal/state/       token i state-dir, 0600, atomisk
internal/sysinfo/     hostname, /etc/os-release, uname, arch, kjerner, RAM, boot-tid, kind-deteksjon og container-id
internal/collect/     /proc, /sys, systemctl, apt, needrestart → host, prosesser, tjenester, vedlikehold, sikkerhet;
                      container.go/cgroup.go: containerprofilen (cgroup v2 eller prosess-summer)
internal/health/      GET GLIMT_HEALTH_URL og TCP-sjekker fra GLIMT_CHECKS
internal/docker/      Engine API-klient (socket/proxy), liste/inspect, cgroup v2-statistikk, hendelser, logg-demux
internal/journal/     journalctl-strømmer, tail av webserverlogger, sikkerhetstellere
internal/logs/        strømbehandler: ruting, batching, grenser, logEnd
internal/ws/          klient, sendekø, backoff, ping/pong, rotate, subscribe, logStart/logStop
internal/sched/       snapshot-, stream- og vedlikeholdstikkere, klokke, vedlikeholdscache
internal/sdnotify/    READY=1 / STOPPING=1 over NOTIFY_SOCKET
install/              install.sh, glimt-agent.service
dev/                  filer til Dockerfile.dev
Dockerfile.build      kryss-kompilering + SHA256SUMS
Dockerfile.dev        Ubuntu 24.04 + systemd + sshd + agent
Dockerfile.sidecar    FROM scratch + CA-sertifikater + binæren, USER 65532, ENTRYPOINT run (ghcr.io/opdahlmann/glimt-agent)
```

## Kjente begrensninger

- **Tjenester krever fast bruker.** `systemctl` virker ikke under `DynamicUser=yes` (dbus avviser dynamiske uid-er), så enheten kjører som systembrukeren `glimt-agent` som `install.sh` oppretter (`useradd --system`, ingen hjemmekatalog, ingen innlogging). `uninstall` fjerner brukeren.
- **Eierprosess på lyttende porter** krever at agenten kan lese `/proc/<pid>/fd` for andre brukeres prosesser. Enheten gir `CAP_SYS_PTRACE` som ambient-kapabilitet, men i dev-containeren på Docker Desktop avvises lesingen likevel (`Permission denied` selv med `CapEff` satt). Portene vises da uten prosessnavn. Verifiseres på en ekte Ubuntu-server i fase 11; uten kapabiliteten viser dashbordet porten uten prosess.
- **`MemoryMax=192M`** dekker også `apt-get -s dist-upgrade` som kjøres hvert 10. minutt når `updates-available` mangler. Den gamle grensen på 64 M ble nådd i containeren.

## Lasttest (`cmd/glimt-loadtest`, steg 11.4)

`node scripts/loadtest/run.mjs [--agents 100] [--browsers 10] [--duration 3m] [--hub http://localhost:5080]` kjører
N falske agenter på den ekte WebSocket-klienten (`internal/ws`) i `golang:1.25`-containeren: hver melder seg inn med
dev-nøkkelen som `load-001`…, sender `snapshot` i hubens intervall, `stream` når huben abonnerer (dropp telles når
sendekøen er full) og syntetiske logglinjer på `logStart`. Samtidig åpner Playwright N nettlesere på oversikten, og
skriptet måler hubens RSS og CPU hvert 5. sekund (`ps`) og leser `/healthz`. Finnes ingen hub på `--hub`, startes
`mongo:8`, huben i e2e-modus og den bygde web-appen, og alt stoppes etterpå. Avslutter med 1 hvis noen agent ikke fikk
`welcome`, noe ble droppet, huben brukte over 1 GB RSS eller over én kjerne i snitt, eller en nettleser fikk sidefeil.
Resultatet fra 2026-09-15 står i rot-README («Målte tall»). Første kjøring avslørte at huben bare pinget agenter som var stille, så en strømmende agent aldri fikk trafikk fra huben og lukket forbindelsen hvert 2. minutt (100 gjenoppkoblinger på 3 min); rettet i `AgentConnection` (ping etter hubens egen stillhet, med test). Server GC ga 1,2 GB RSS; med workstation GC (`Glimt.Hub.csproj`) er toppen 340 MB.

## Målt ressursbruk

Målt 2026-09-09 i dev-containeren (Docker Desktop, arm64, 12 kjerner) med `node scripts/agent-container.mjs --measure`
(`systemd-cgtop`) og `systemctl show glimt-agent -p CPUUsageNSec -p MemoryCurrent` før og etter et tidsvindu.
Skjelett-huben sender ennå ikke `subscribe`, så «én abonnent» og «abonnent + logg» er ikke målt.

| Tilstand | RSS (`ps`) | cgroup-minne | CPU | Merknad |
|---|---|---|---|---|
| Hvile uten hub (kun gjenoppkoblingsforsøk) | 14,1 MB | 10,8 MB | 0,007 % | vindu 200 s, 8 gjenoppkoblingsforsøk (backoff 1–60 s) |
| Tilkoblet, ingen abonnent (`snapshot` hvert 30 s, 10 containere, journal-tellere) | 15,1 MB | 10,4 MB | 0,084 % | vindu 179 s uten vedlikeholdstikk; `systemd-cgtop` viser 10,8 MB for `glimt-agent.service` |
| Vedlikeholdstikk (hvert 10. min) | – | topp 64 MB (cgroup, inkl. `apt-get -s dist-upgrade` sidecache) | ≈1 s CPU per kjøring (+0,17 % i snitt) | kjøres bare når `/var/lib/update-notifier/updates-available` mangler |
| Én abonnent (stream 1 s) | – | – | – | måles når huben sender `subscribe` |
| Én abonnent + loggstrøm | – | – | – | måles når huben sender `subscribe` |

Oppstart (første liste av containere, første snapshot, vedlikehold og journal-tellere) kostet ≈1 s CPU. Merk at
`MemoryMax=64M` i enheten gjelder hele cgroupen, altså også `apt-get`-simuleringen; toppen traff grensen i
dev-containeren uten at noe ble drept (sidecache ble frigjort), men på en server med store pakkelister bør dette
følges med på.
