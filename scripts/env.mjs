#!/usr/bin/env node
// Laster .env og deretter .env.<profil> (standard dev). Verdier som allerede finnes i miljøet vinner.
// Bruk: node scripts/env.mjs [--profile dev|prod] [--print] [--require KEY,KEY] -- <kommando> [args]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out[key] = value;
  }
  return out;
}

export function loadEnv({ profile = process.env.GLIMT_PROFILE || 'dev', apply = true } = {}) {
  const files = [path.join(repoRoot, '.env'), path.join(repoRoot, `.env.${profile}`)];
  const merged = {};
  for (const f of files) Object.assign(merged, parseEnvFile(f));
  if (apply) for (const [k, v] of Object.entries(merged)) if (process.env[k] === undefined) process.env[k] = v;
  return { ...merged, ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('GLIMT_'))) };
}

export function isDummy(value) {
  return /USER:PASSWORD@HOST|CHANGE-ME|FYLL INN/.test(value ?? '');
}

// Stopper når en nøkkel mangler helt. Dummy-verdier gir bare en tydelig advarsel: huben starter uten database.
export function requireKeys(env, keys) {
  const missing = keys.filter((k) => !env[k]);
  const dummy = keys.filter((k) => env[k] && isDummy(env[k]));
  if (dummy.length) {
    console.warn(`\n⚠ Dummy-verdi i .env / .env.<profil>: ${dummy.join(', ')}. Sett ekte verdi i .env.dev (huben starter, men uten database).\n`);
  }
  if (missing.length) {
    console.error(`\nMangler i .env / .env.<profil>: ${missing.join(', ')}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let profile = 'dev';
  let print = false;
  let required = [];
  let cmd = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--profile') profile = args[++i];
    else if (args[i] === '--print') print = true;
    else if (args[i] === '--require') required = args[++i].split(',');
    else if (args[i] === '--') { cmd = args.slice(i + 1); break; }
  }
  const env = loadEnv({ profile });
  if (required.length) requireKeys(env, required);
  if (print) {
    for (const [k, v] of Object.entries(env).sort()) console.log(`${k}=${/SECRET|PASSWORD|PRIVATE|API_KEY|MONGO_URI/.test(k) && v ? '***' : v}`);
  }
  if (cmd.length) {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' });
    child.on('exit', (code) => process.exit(code ?? 1));
  }
}
