#!/usr/bin/env node
// Lasttest (IMPLEMENTERINGSPLAN steg 11.4): 100 falske agenter på agentens ekte WebSocket-klient
// (apps/glimt-agent/cmd/glimt-loadtest, kjørt i golang:1.25-containeren) og 10 nettleserklienter (Playwright) på
// oversikten mot en hub. Måler hubens RSS og CPU underveis og skriver en oppsummering. Mål: under 1 GB RSS, under én
// CPU-kjerne, ingen stream-drops.
//
//   node scripts/loadtest/run.mjs [--agents 100] [--browsers 10] [--duration 3m] [--hub http://localhost:5080]
//
// Bruker en hub som allerede svarer på --hub (f.eks. fra `npm run test:e2e`-serverne eller en staging-hub via
// GLIMT_LOADTEST_KEY); ellers startes mongo:8 i Docker, huben i e2e-modus (`dotnet run`) og den bygde web-appen
// (scripts/serve-web.mjs) her, og stoppes etterpå.
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../env.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const agents = Number(flag('--agents', 100));
const browsers = Number(flag('--browsers', 10));
const durationStr = flag('--duration', '3m');
const hubUrl = flag('--hub', process.env.GLIMT_HUB_URL ?? 'http://localhost:5080');
const webPort = Number(flag('--web-port', process.env.GLIMT_WEB_PORT ?? 4200));
const key = process.env.GLIMT_LOADTEST_KEY ?? 'gp_e2e';
const DEV_USER = { email: 'dev@glimtpanel.local', password: 'GlimtDev-2026!' };
const durationMs = parseDuration(durationStr);

function parseDuration(s) {
  const m = /^(\d+)(s|m)$/.exec(s);
  if (!m) throw new Error(`--duration må være som 90s eller 3m, fikk ${s}`);
  return Number(m[1]) * (m[2] === 'm' ? 60_000 : 1000);
}
function shq(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], cwd: repoRoot }).trim();
  } catch {
    return null;
  }
}
async function healthy(url) {
  try {
    const res = await fetch(`${url}/healthz`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
async function waitFor(url, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await healthy(url)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

const children = [];
let mongoName = null;
function cleanup() {
  for (const c of children) {
    try {
      process.kill(-c.pid, 'SIGTERM');
    } catch {
      // allerede borte
    }
  }
  if (mongoName) shq(`docker rm -f ${mongoName}`);
}
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

// 1. Hub (og web) – gjenbruk eller start.
let hubPid = null;
if (await healthy(hubUrl)) {
  console.log(`loadtest: bruker huben på ${hubUrl}`);
  hubPid = Number(shq(`lsof -nP -iTCP:${new URL(hubUrl).port} -sTCP:LISTEN -t | head -1`)) || null;
} else {
  mongoName = 'glimt-load-mongo';
  shq(`docker rm -f ${mongoName}`);
  execSync(`docker run -d --rm --name ${mongoName} -p 127.0.0.1:0:27017 mongo:8`, { stdio: 'ignore' });
  const mongoPort = shq(`docker port ${mongoName} 27017`).split(':').pop();
  const mongoUri = `mongodb://127.0.0.1:${mongoPort}`;
  console.log(`loadtest: mongo:8 på ${mongoUri}`);
  const hub = spawn('dotnet', ['run', '--project', 'apps/glimt-hub/src/Glimt.Hub'], {
    cwd: repoRoot,
    detached: true,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, GLIMT_ENV: 'e2e', GLIMT_HUB_URL: hubUrl, GLIMT_MONGO_URI: mongoUri, GLIMT_MONGO_DB: 'GlimtpanelLoad', GLIMT_JWT_SECRET: 'loadtest', GLIMT_DEV_ENROL_KEY: key, GLIMT_DEV_USER_EMAIL: DEV_USER.email, GLIMT_DEV_USER_PASSWORD: DEV_USER.password, GLIMT_WEB_PUBLIC_URL: `http://localhost:${webPort}`, GLIMT_BUFFER_PATH: fs.mkdtempSync(path.join(repoRoot, 'apps/glimt-hub/', 'loadtest-buffer-')) },
  });
  children.push(hub);
  if (!(await waitFor(hubUrl, 120_000))) {
    console.error('loadtest: huben svarte ikke innen 120 s');
    cleanup();
    process.exit(1);
  }
  hubPid = Number(shq(`lsof -nP -iTCP:${new URL(hubUrl).port} -sTCP:LISTEN -t | head -1`)) || hub.pid;
  console.log(`loadtest: hub oppe (pid ${hubPid})`);
}
if (!(await healthy(`http://localhost:${webPort}`).catch(() => null)) && browsers > 0) {
  if (!fs.existsSync(path.join(repoRoot, 'apps/glimt-web/dist/glimt-web/browser/index.html'))) {
    console.log('loadtest: bygger web (production)…');
    execSync('npm --workspace apps/glimt-web run build -- --configuration production', { cwd: repoRoot, stdio: 'inherit' });
  }
  const web = spawn('node', ['scripts/serve-web.mjs', '--port', String(webPort)], { cwd: repoRoot, detached: true, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, GLIMT_HUB_INTERNAL_URL: hubUrl, GLIMT_ENV: 'e2e' } });
  children.push(web);
  await new Promise((r) => setTimeout(r, 1500));
}

// 2. Agentene i Go-containeren mot huben på verten.
const hubWs = hubUrl.replace(/^http/, 'ws').replace('localhost', 'host.docker.internal').replace('127.0.0.1', 'host.docker.internal') + '/agent/ws';
const src = path.join(repoRoot, 'apps/glimt-agent');
const go = spawn('docker', ['run', '--rm', '-i', '--add-host', 'host.docker.internal:host-gateway', '-v', `${src}:/src`, '-w', '/src', '-v', 'glimt-go-cache:/go/pkg/mod', '-v', 'glimt-go-build:/root/.cache/go-build', '-e', 'CGO_ENABLED=0', 'golang:1.25', 'go', 'run', './cmd/glimt-loadtest', '-hub', hubWs, '-key', key, '-n', String(agents), '-duration', durationStr, '-report', '15s'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] });
let goOut = '';
go.stdout.on('data', (d) => (goOut += d));

// 3. Nettleserne på oversikten.
let browserResult = null;
if (browsers > 0) {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  const pages = [];
  const pageErrors = [];
  for (let i = 0; i < browsers; i++) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: `http://localhost:${webPort}` });
    const login = await context.request.post('/api/auth/login', { data: DEV_USER });
    if (!login.ok()) {
      console.error(`loadtest: innlogging feilet: ${login.status()} ${await login.text()}`);
      cleanup();
      process.exit(1);
    }
    await context.addInitScript(() => {
      try {
        localStorage.setItem('gp.hasSession', 'true');
        localStorage.setItem('gp.welcomeSeen', 'true');
      } catch {
        // ingen lagring
      }
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto('/');
    pages.push(page);
  }
  console.log(`loadtest: ${browsers} nettlesere på oversikten`);
  browserResult = { pages, pageErrors, browser };
}

// 4. Måling av huben mens det pågår.
const samples = [];
const sampler = setInterval(async () => {
  if (!hubPid) return;
  const ps = shq(`ps -o rss=,%cpu= -p ${hubPid}`);
  if (!ps) return;
  const [rssKb, cpu] = ps.trim().split(/\s+/).map(Number);
  const health = await healthy(hubUrl);
  samples.push({ t: Date.now(), rssMb: Math.round(rssKb / 1024), cpu, agents: health?.agentsConnected ?? null, points: health?.buffer?.points ?? null });
  console.log(`loadtest: hub rss=${Math.round(rssKb / 1024)} MB cpu=${cpu}% agentsConnected=${health?.agentsConnected ?? '?'}`);
}, 5000);

const goExit = await new Promise((resolve) => go.on('close', resolve));
clearInterval(sampler);

let cards = null;
if (browserResult) {
  cards = await browserResult.pages[0].locator('gp-server-card, gp-container-card').count();
  await browserResult.browser.close();
}
cleanup();

const agentSummary = goOut.trim().split('\n').filter((l) => l.startsWith('{')).pop();
const summary = {
  agents: agentSummary ? JSON.parse(agentSummary) : null,
  goExit,
  browsers: browserResult ? { count: browsers, cardsSeenByFirst: cards, pageErrors: browserResult.pageErrors } : null,
  hub: samples.length ? { samples: samples.length, maxRssMb: Math.max(...samples.map((s) => s.rssMb)), avgCpu: Number((samples.reduce((a, s) => a + s.cpu, 0) / samples.length).toFixed(1)), maxCpu: Math.max(...samples.map((s) => s.cpu)) } : null,
};
console.log(JSON.stringify(summary, null, 2));
const ok = goExit === 0 && (summary.hub ? summary.hub.maxRssMb < 1024 && summary.hub.avgCpu < 100 : true) && (!browserResult || browserResult.pageErrors.length === 0);
console.log(ok ? 'loadtest: OK' : 'loadtest: FEILET (se tallene over)');
process.exit(ok ? 0 : 1);
