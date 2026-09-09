#!/usr/bin/env node
// Bygger og kjører Ubuntu-containeren med glimt-agent (systemd som PID 1) for lokal utvikling.
// Bruk: node scripts/agent-container.mjs --start [--plain] | --stop | --build | --test | --shell | --logs | --measure
import { execSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { loadEnv, repoRoot } from './env.mjs';

const IMAGE = 'glimt-agent-dev';
const NAME = 'glimt-agent-dev';
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
else start();
