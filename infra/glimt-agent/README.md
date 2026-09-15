# glimt-agent: publisere en ny versjon

Agenten rulles ikke ut med Dokploy. En utgivelse er en git-tag `agent/vX.Y.Z`; CI bygger og publiserer resten.
Byggefilene ligger hos agenten: `apps/glimt-agent/Dockerfile.build` (binærene) og `apps/glimt-agent/Dockerfile.sidecar`
(imaget). Jobben heter `release-agent` i `.github/workflows/ci.yml`.

## Hva en utgivelse består av

| Del | Hvor | Brukes av |
|---|---|---|
| `glimt-agent-linux-amd64`, `glimt-agent-linux-arm64`, `SHA256SUMS` | GitHub Release `agent/vX.Y.Z` | `install.sh` på servere, som verifiserer sjekksummen |
| `ghcr.io/opdahlmann/glimt-agent:X.Y.Z` og `:latest` (amd64 og arm64) | GitHub Container Registry | sidecar i Compose og `COPY --from` i egne images |
| `GLIMT_AGENT_VERSION` | miljøet til glimt-hub (`infra/glimt-hub/.env.dev` og `.env.prod`) | `/install`, som laster ned denne versjonen |

Versjonsnummeret kommer fra taggen og bakes inn i binæren; `glimt-agent version` viser det.

## Slik publiserer du

1. Kjør agenttestene lokalt og merge endringen til `main`. Vent til CI er grønn.

   ```sh
   npm run test:agent
   ```

2. Sett taggen på commiten i `main` og push den.

   ```sh
   git tag agent/v0.2.0 origin/main
   git push origin agent/v0.2.0
   ```

3. Følg kjøringen for taggen under Actions. `release-agent` starter etter `test-agent` og `build-images`, og hoppes over
   hvis en av dem feiler. Feiler selve release-steget med en 500 fra GitHub, velg «Re-run failed jobs».

4. Sjekk at alt kan hentes uten innlogging.

   ```sh
   curl -sfL -o /dev/null -w '%{http_code}\n' https://github.com/opdahlmann/glimtpanel/releases/download/agent/v0.2.0/SHA256SUMS
   docker run --rm --entrypoint /glimt-agent ghcr.io/opdahlmann/glimt-agent:0.2.0 version
   ```

5. Prøv den i dev. Sett `GLIMT_AGENT_VERSION=0.2.0` i `infra/glimt-hub/.env.dev` og i Environment på Dokploy-appen
   `glimt-hub-dev`, og velg «Redeploy». Installer på en testserver med kommandoen fra `dev-app.glimtpanel.com`.

6. Gjør det samme for produksjon: `infra/glimt-hub/.env.prod` og `glimt-hub-prod`, så «Redeploy».

7. Hub, web og site har agenten innebygd fra `ghcr.io/opdahlmann/glimt-agent:latest`. Velg **Rebuild** (ikke Redeploy)
   på de seks Dokploy-appene, dev først, så imagene bygges med den nye binæren. Ingen kodeendring trengs.

## Servere og containere som allerede kjører agenten

Agenten oppdaterer seg ikke selv. På en server kjører du installkommandoen på nytt uten `--key`. Tokenet beholdes, så
serveren beholder historikken sin. Gi samme `--docker` som ved første installasjon, ellers blir det `proxy`.

```sh
curl -fsSL https://get.glimtpanel.com/install | sudo sh -s -- --docker proxy
```

`--version X.Y.Z` installerer en bestemt versjon i stedet for den huben peker på.

- **Binær i eget image:** bygg appens image på nytt. `COPY --from=ghcr.io/opdahlmann/glimt-agent:latest` henter den nye
  versjonen; en fast tag (`:0.2.0`) må byttes for hånd.
- **Sidecar i Compose:** `docker compose pull glimt-agent && docker compose up -d glimt-agent`.

## Når noe går galt

- **Ingen release ble laget** (en test eller et bygg feilet før `release-agent`). Fiks feilen, flytt taggen og push den
  på nytt:

  ```sh
  git tag -d agent/v0.2.0 && git push origin :refs/tags/agent/v0.2.0
  git tag agent/v0.2.0 origin/main && git push origin agent/v0.2.0
  ```

- **Releasen er ute, men har en feil.** Flytt aldri en tag som allerede er publisert: servere kan ha lastet ned filene,
  og imaget med samme tag finnes. Publiser en ny patchversjon i stedet.

## Bare installskriptet er endret

`apps/glimt-agent/install/install.sh` bakes inn i hubens image og serveres på `/install`. En endring der trenger ingen
agentutgivelse: rull ut huben på nytt, dev først.

## Ikke lag andre GitHub Releases

`install.sh --version latest` bruker GitHubs «latest release». Publiseres en annen release i repoet, for eksempel
`v1.0.0` for appen, blir den «latest» og har ingen agentbinærer. Huben setter alltid `GLIMT_AGENT_VERSION`, så `/install`
er upåvirket, men manuelle installasjoner med `latest` ville feilet. Merk andre releaser som pre-release, eller la være.
