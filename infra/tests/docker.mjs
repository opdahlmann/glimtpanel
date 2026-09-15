// Hjelpere for containertestene i infra/tests: docker-CLI, ett nettverk per testfil med korte aliaser (hub, web,
// mongo …), porter publisert på tilfeldige 127.0.0.1-porter og opprydding. Ingen avhengigheter utover Node.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Kjører docker og returnerer stdout; kaster med stderr ved feil. */
export function docker(args, { input } = {}) {
  const r = tryDocker(args, { input });
  if (r.status !== 0) throw new Error(`docker ${args.join(' ')} → ${r.status}\n${r.stderr}${r.stdout}`);
  return r.stdout.trim();
}

/** Som docker(), men feil er et resultat, ikke et unntak. */
export function tryDocker(args, { input } = {}) {
  return spawnSync('docker', args, { cwd: repoRoot, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
}

/** Bygger infra/glimt-<app>/Dockerfile som glimt-<app>:local. I CI er imagene bygget av jobben (GLIMT_TEST_PREBUILT=1). */
export function buildImage(app) {
  const tag = `glimt-${app}:local`;
  if (process.env.GLIMT_TEST_PREBUILT === '1') docker(['image', 'inspect', tag]);
  else docker(['build', '--load', '-q', '-f', `infra/glimt-${app}/Dockerfile`, '-t', tag, '.']);
  return tag;
}

/** Et sett containere på eget nettverk. stop() fjerner alt, også når testen feilet. */
export class Stack {
  constructor(label) {
    this.prefix = `glimt-test-${label}-${randomBytes(3).toString('hex')}`;
    this.containers = [];
    docker(['network', 'create', this.prefix]);
  }

  /** Starter en container med nettverksalias `alias`; `port` publiseres og gir `url`. */
  run(alias, image, { env = {}, envFile, port, args = [], cmd = [] } = {}) {
    const name = `${this.prefix}-${alias}`;
    const a = ['run', '-d', '--name', name, '--network', this.prefix, '--network-alias', alias];
    if (envFile) a.push('--env-file', envFile);
    for (const [k, v] of Object.entries(env)) a.push('-e', `${k}=${v}`);
    if (port) a.push('-p', `127.0.0.1::${port}`);
    docker([...a, ...args, image, ...cmd]);
    this.containers.push(name);
    const c = { name, alias };
    if (port) c.url = `http://127.0.0.1:${docker(['port', name, `${port}/tcp`]).split('\n')[0].split(':').pop()}`;
    return c;
  }

  remove(c) {
    tryDocker(['rm', '-fv', c.name]);
    this.containers = this.containers.filter((n) => n !== c.name);
  }

  stop() {
    for (const name of this.containers) tryDocker(['rm', '-fv', name]);
    tryDocker(['network', 'rm', this.prefix]);
  }
}

export const logs = (c) => {
  const r = tryDocker(['logs', c.name]);
  return r.stdout + r.stderr;
};

/** `sh -c` i containeren; returnerer { status, out }. */
export function exec(c, script) {
  const r = tryDocker(['exec', c.name, 'sh', '-c', script]);
  return { status: r.status, out: (r.stdout + r.stderr).trim() };
}

export const inspect = (c, format) => docker(['inspect', '-f', format, c.name]);

/** Venter til fn() gir en sann verdi, og returnerer den. Kaster med siste feil etter timeout. */
export async function waitFor(what, fn, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(500);
  }
  throw new Error(`timeout (${timeoutMs} ms): ${what}${last ? ` – ${last.message}` : ''}`);
}

/** fetch med timeout; body lest som tekst. */
export async function http(url, { method = 'GET', headers = {}, json } = {}) {
  const res = await fetch(url, {
    method,
    headers: json ? { 'content-type': 'application/json', ...headers } : headers,
    body: json ? JSON.stringify(json) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) };
}

/** Mongo i stacken, klar til bruk (huben seeder bare når databasen svarer ved oppstart). */
export async function startMongo(stack) {
  const mongo = stack.run('mongo', 'mongo:8');
  await waitFor('mongo ping', () => exec(mongo, 'mongosh --quiet --eval "db.runCommand({ping:1}).ok"').out === '1', 60_000);
  return mongo;
}

/** Leser en env-fil slik docker --env-file gjør: KEY=VALUE per linje, kommentarlinjer og tomme linjer hoppes over. */
export function readEnvFile(file) {
  const values = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i > 0) values[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return values;
}

/**
 * Env-filen som faktisk rulles ut (infra/glimt-<app>/.env.<env>, git-ignorert) når den finnes lokalt, ellers en
 * midlertidig fil med `fallback`. Slik tester CI oppsettet og en lokal kjøring i tillegg de ekte verdiene.
 */
export function envFileFor(app, env, fallback) {
  const real = path.join(repoRoot, 'infra', `glimt-${app}`, `.env.${env}`);
  if (fs.existsSync(real)) return { path: real, values: readEnvFile(real), real: true };
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glimt-env-')), `.env.${env}`);
  fs.writeFileSync(tmp, Object.entries(fallback).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  return { path: tmp, values: { ...fallback }, real: false };
}

/** Hubens agent-URL for en offentlig adresse, som ContainerSnippets.AgentWsUrl. */
export const agentWsUrl = (publicUrl) => publicUrl.replace(/\/+$/, '').replace(/^https:/, 'wss:').replace(/^http:/, 'ws:') + '/agent/ws';

/** Docker-helsesjekken hvert 2. s i stedet for hvert 30. s; kommandoen er fortsatt imagets egen. */
export const FAST_HEALTH = ['--health-interval', '2s', '--health-start-period', '20s'];
