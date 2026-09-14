#!/usr/bin/env node
// `npm run dev`: starter hub (dotnet watch), agent-container (Ubuntu + systemd + glimt-agent) og web (ng serve).
// Flagg: --no-agent --no-web --no-hub --site --plain-agent --sidecar --stop
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import { loadEnv, requireKeys, repoRoot } from './env.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const env = loadEnv();
const children = [];
const colors = { hub: '\x1b[36m', web: '\x1b[35m', agent: '\x1b[33m', site: '\x1b[32m', dev: '\x1b[37m' };
const log = (who, msg) => console.log(`${colors[who] ?? ''}[${who}]\x1b[0m ${msg}`);

function run(who, cmd, cmdArgs, opts = {}) {
  // detached: hvert barn får egen prosessgruppe, så vi kan signalere hele treet (dotnet watch → dotnet run → Glimt.Hub).
  const child = spawn(cmd, cmdArgs, { cwd: repoRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true, ...opts });
  const prefix = (line) => log(who, line);
  child.stdout.on('data', (d) => d.toString().split(/\r?\n/).filter(Boolean).forEach(prefix));
  child.stderr.on('data', (d) => d.toString().split(/\r?\n/).filter(Boolean).forEach(prefix));
  child.on('exit', (code) => log(who, `avsluttet (${code})`));
  children.push(child);
  return child;
}

async function waitFor(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function dockerUp() { try { execSync('docker info', { stdio: 'ignore' }); return true; } catch { return false; } }

function signalGroup(child, signal) {
  try { process.kill(-child.pid, signal); } catch {}
  try { child.kill(signal); } catch {}
}

function killLeftovers() {
  // Prosesser fra en tidligere kjøring som ikke ble ryddet (f.eks. terminalen ble lukket).
  for (const pattern of ['dotnet watch --project apps/glimt-hub', 'dotnet-watch.dll', 'Glimt.Hub/bin/Debug', 'ng serve --port']) {
    try { execSync(`pkill -f ${JSON.stringify(pattern)}`, { stdio: 'ignore' }); } catch {}
  }
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('dev', 'stopper …');
  const alive = () => children.filter((c) => c.exitCode === null && c.signalCode === null);
  for (const c of alive()) signalGroup(c, 'SIGINT');
  const t0 = Date.now();
  while (alive().length && Date.now() - t0 < 6000) await new Promise((r) => setTimeout(r, 200));
  for (const c of alive()) { log('dev', `tvinger stopp av pid ${c.pid}`); signalGroup(c, 'SIGKILL'); }
  killLeftovers();
  if (!has('--no-agent')) { try { execSync('node scripts/agent-container.mjs --stop', { cwd: repoRoot, stdio: 'ignore' }); } catch {} }
  log('dev', 'alt stoppet');
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

if (has('--stop')) { killLeftovers(); try { execSync('node scripts/agent-container.mjs --stop', { cwd: repoRoot, stdio: 'inherit' }); } catch {} log('dev', 'alt stoppet'); }
else {
  requireKeys(env, ['GLIMT_MONGO_URI', 'GLIMT_MONGO_DB', 'GLIMT_JWT_SECRET']);
  const hubUrl = env.GLIMT_HUB_URL ?? 'http://localhost:5080';

  if (!has('--no-hub')) {
    log('dev', `starter hub på ${hubUrl}`);
    run('hub', 'dotnet', ['watch', '--project', 'apps/glimt-hub/src/Glimt.Hub', '--non-interactive'], { env: { ...process.env, DOTNET_WATCH_SUPPRESS_EMOJIS: '1' } });
    const ok = await waitFor(`${hubUrl.replace('0.0.0.0', 'localhost')}/healthz`, 90_000);
    log('dev', ok ? 'hub svarer på /healthz' : 'hub svarte ikke innen 90 s, fortsetter likevel');
  }

  if (!has('--no-agent')) {
    if (dockerUp()) {
      log('dev', 'bygger og starter agent-container');
      try { execSync(`node scripts/agent-container.mjs --start${has('--plain-agent') ? ' --plain' : ''}`, { cwd: repoRoot, stdio: 'inherit' }); }
      catch { log('agent', 'kunne ikke starte containeren (se over). Fortsetter uten agent.'); }
      if (has('--sidecar')) {
        log('dev', 'bygger og starter sidecar (containernode sidecar-dev)');
        try { execSync('node scripts/agent-container.mjs --sidecar', { cwd: repoRoot, stdio: 'inherit' }); }
        catch { log('agent', 'kunne ikke starte sidecaren (se over). Fortsetter uten.'); }
      }
    } else {
      log('agent', 'Docker-daemonen kjører ikke. Fortsetter uten agent (start Docker Desktop og kjør `npm run dev:agent`).');
    }
  }

  if (!has('--no-web')) {
    execSync('node scripts/web-config.mjs', { cwd: repoRoot, stdio: 'inherit' });
    log('dev', `starter web på http://localhost:${env.GLIMT_WEB_PORT ?? 4200}`);
    run('web', 'npm', ['--workspace', 'apps/glimt-web', 'run', 'start', '--', '--port', String(env.GLIMT_WEB_PORT ?? 4200)]);
  }

  if (has('--site')) {
    log('dev', 'starter site på http://localhost:4321');
    run('site', 'npm', ['--workspace', 'apps/glimt-site', 'run', 'dev']);
  }
  log('dev', 'Ctrl+C stopper alt.');
}
