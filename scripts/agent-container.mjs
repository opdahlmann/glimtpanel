#!/usr/bin/env node
// Bygger og kjører Ubuntu-containeren med glimt-agent (systemd som PID 1) for lokal utvikling, og sidecaren
// for containernoder (fase 12): en nginx-app `glimt-app-dev` og agenten i `glimt-sidecar-dev` som deler pid- og
// nettverksnamespace med den (tilsvarer `pid`/`network_mode: service:app` i Compose).
// Bruk: node scripts/agent-container.mjs --start [--plain] | --stop | --build | --test | --shell | --logs | --measure
//       node scripts/agent-container.mjs --sidecar [--cgroupns-host] | --sidecar-stop | --sidecar-logs | --sidecar-snapshot | --sidecar-check
import { execSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { loadEnv, repoRoot } from './env.mjs';

const IMAGE = 'glimt-agent-dev';
const NAME = 'glimt-agent-dev';
const SIDECAR_IMAGE = 'glimt-agent-sidecar';
const APP_NAME = 'glimt-app-dev';
const SIDECAR_NAME = 'glimt-sidecar-dev';
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const env = loadEnv();

function sh(cmd, opts = {}) { return execSync(cmd, { stdio: 'inherit', cwd: repoRoot, ...opts }); }
function shq(cmd) { try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], cwd: repoRoot }).trim(); } catch { return null; } }

function dockerUp() {
  if (!shq('docker info --format "{{.ServerVersion}}"')) { console.error('Docker-daemonen kjører ikke. Start Docker Desktop.'); process.exit(2); }
}

function build() {
  dockerUp();
  sh(`docker build -f apps/glimt-agent/Dockerfile.dev -t ${IMAGE} .`);
}

function stop() {
  if (shq(`docker ps -aq -f name=^${NAME}$`)) sh(`docker rm -f ${NAME}`, { stdio: 'ignore' });
  sidecarStop();
}

function start() {
  dockerUp();
  build();
  stop();
  const plain = has('--plain');
  const envFlags = ['GLIMT_AGENT_HUB_WS', 'GLIMT_DEV_ENROL_KEY', 'GLIMT_AGENT_NAME', 'GLIMT_HEARTBEAT_SECONDS']
    .map((k) => `-e ${k}=${JSON.stringify(env[k] ?? '')}`).join(' ');
  const common = `--name ${NAME} --hostname ${env.GLIMT_AGENT_NAME ?? 'ubuntu-dev'} --add-host host.docker.internal:host-gateway ${envFlags} -v /var/run/docker.sock:/var/run/docker.sock:ro`;
  const cmd = plain
    ? `docker run -d ${common} ${IMAGE} /usr/local/bin/glimt-agent run`
    : `docker run -d ${common} --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock --tmpfs /tmp ${IMAGE}`;
  sh(cmd);
  console.log(`agent-container ${NAME} startet (${plain ? 'uten systemd' : 'med systemd'}). Logg: npm run dev:agent -- --logs`);
}

function test() {
  dockerUp();
  const src = path.join(repoRoot, 'apps/glimt-agent');
  sh(`docker run --rm -v ${JSON.stringify(src)}:/src -w /src -v glimt-go-cache:/go/pkg/mod -v glimt-go-build:/root/.cache/go-build -e CGO_ENABLED=0 golang:1.25 sh -c "gofmt -l . && go vet ./... && go test ./..."`);
}

// --- sidecar (steg 12.1 og 12.4) ---------------------------------------------------------------

function sidecarStop() {
  for (const name of [SIDECAR_NAME, APP_NAME]) {
    if (shq(`docker ps -aq -f name=^${name}$`)) sh(`docker rm -f ${name}`, { stdio: 'ignore' });
  }
}

/** nginx som «kundens app», med grenser så cgroup-tallene betyr noe (1,5 kjerner, 256 MB). */
function startApp() {
  if (shq(`docker ps -q -f name=^${APP_NAME}$`)) return;
  if (shq(`docker ps -aq -f name=^${APP_NAME}$`)) sh(`docker rm -f ${APP_NAME}`, { stdio: 'ignore' });
  sh(`docker run -d --name ${APP_NAME} --memory 256m --cpus 1.5 --add-host host.docker.internal:host-gateway nginx:1.27`);
}

/**
 * Sidecaren fra Dockerfile.sidecar mot den lokale huben, som containernoden `sidecar-dev` på dev-kontoen
 * (huben seeder den fra GLIMT_DEV_CONTAINER_TOKEN). `--cgroupns-host` gir agenten appens cgroup (ekte CPU-
 * og minnetall); standard er Dockers private cgroup-namespace, der agenten summerer prosessene (`approx`).
 */
function sidecar() {
  dockerUp();
  const token = env.GLIMT_DEV_CONTAINER_TOKEN;
  if (!token) { console.error('GLIMT_DEV_CONTAINER_TOKEN mangler i .env (se example.env).'); process.exit(2); }
  sh(`docker build -f apps/glimt-agent/Dockerfile.sidecar --build-arg VERSION=0.1.0-dev -t ${SIDECAR_IMAGE} .`);
  startApp();
  if (shq(`docker ps -aq -f name=^${SIDECAR_NAME}$`)) sh(`docker rm -f ${SIDECAR_NAME}`, { stdio: 'ignore' });
  const envFlags = Object.entries({
    GLIMT_HUB: env.GLIMT_AGENT_HUB_WS ?? 'ws://host.docker.internal:5080/agent/ws',
    GLIMT_TOKEN: token,
    GLIMT_NODE_NAME: 'sidecar-dev',
    GLIMT_HEALTH_URL: 'http://127.0.0.1:80/',
    GLIMT_CHECKS: 'hub=host.docker.internal:5080,nowhere=127.0.0.1:1',
    GLIMT_IMAGE: 'nginx:1.27',
    GLIMT_LOG_LEVEL: env.GLIMT_LOG_LEVEL ?? 'debug',
  }).map(([k, v]) => `-e ${k}=${JSON.stringify(v)}`).join(' ');
  const cgroupns = has('--cgroupns-host') ? '--cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:ro' : '';
  sh(`docker run -d --name ${SIDECAR_NAME} --pid=container:${APP_NAME} --network=container:${APP_NAME} --read-only --cap-drop ALL ${cgroupns} ${envFlags} ${SIDECAR_IMAGE}`);
  console.log(`sidecar ${SIDECAR_NAME} startet ved siden av ${APP_NAME} (${has('--cgroupns-host') ? 'appens cgroup' : 'privat cgroupns, approx'}). Logg: node scripts/agent-container.mjs --sidecar-logs`);
}

function measure() {
  dockerUp();
  sh(`docker exec ${NAME} bash -lc "systemd-cgtop -b -n 3 -r --depth=2 | head -20"`);
}

if (has('--build')) build();
else if (has('--stop')) { stop(); console.log('stoppet'); }
else if (has('--test')) test();
else if (has('--shell')) spawnSync('docker', ['exec', '-it', NAME, 'bash'], { stdio: 'inherit' });
else if (has('--logs')) spawnSync('docker', ['exec', NAME, 'journalctl', '-u', 'glimt-agent', '-f', '-n', '50'], { stdio: 'inherit' });
else if (has('--measure')) measure();
else if (has('--sidecar')) sidecar();
else if (has('--sidecar-stop')) { sidecarStop(); console.log('sidecar stoppet'); }
else if (has('--sidecar-logs')) spawnSync('docker', ['logs', '-f', '-n', '50', SIDECAR_NAME], { stdio: 'inherit' });
else if (has('--sidecar-snapshot')) spawnSync('docker', ['exec', SIDECAR_NAME, '/glimt-agent', 'snapshot', '--wait', '2s'], { stdio: 'inherit' });
else if (has('--sidecar-check')) spawnSync('docker', ['exec', SIDECAR_NAME, '/glimt-agent', 'check'], { stdio: 'inherit' });
else start();
