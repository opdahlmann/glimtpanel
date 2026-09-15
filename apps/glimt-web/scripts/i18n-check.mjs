#!/usr/bin/env node
// Sjekker ordboken (IMPLEMENTERINGSPLAN 6.5 / steg 3.2): en.json og no.json har identisk nøkkelsett, ingen tomme
// tekster, og hver `t('key')`, `'key' | t`, `setKey('key')` i src/app/**/*.{ts,html} finnes i ordboken.
// Kjøres med `npm --workspace apps/glimt-web run i18n:check` (og i CI). Avslutter med kode 1 ved feil.
// Ubrukte nøkler er også feil: en nøkkel må stå i anførselstegn et sted i src/app (typede literaler som
// `labelKey: 'servers'` teller), unntatt `d_*`/`r_*` som alerts.model.ts bygger dynamisk.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const i18nDir = path.join(root, 'src/app/i18n');
const en = JSON.parse(fs.readFileSync(path.join(i18nDir, 'en.json'), 'utf8'));
const no = JSON.parse(fs.readFileSync(path.join(i18nDir, 'no.json'), 'utf8'));

const problems = [];
const enKeys = new Set(Object.keys(en));
const noKeys = new Set(Object.keys(no));
for (const k of enKeys) if (!noKeys.has(k)) problems.push(`no.json mangler nøkkelen "${k}"`);
for (const k of noKeys) if (!enKeys.has(k)) problems.push(`en.json mangler nøkkelen "${k}"`);
for (const [file, dict] of [['en.json', en], ['no.json', no]]) {
  for (const [k, v] of Object.entries(dict)) {
    if (typeof v !== 'string' || v.trim() === '') problems.push(`${file}: "${k}" er tom eller ikke en streng`);
  }
}

// Bruk i kode og maler. Ordboksnøkler er [A-Za-z0-9_]. Mønstre: t('key'), 'key' | t, setKey('key').
const patterns = [
  /\bt\(\s*'([A-Za-z0-9_]+)'\s*\)/g,
  /\bt\(\s*"([A-Za-z0-9_]+)"\s*\)/g,
  /'([A-Za-z0-9_]+)'\s*\|\s*t\b/g,
  /"([A-Za-z0-9_]+)"\s*\|\s*t\b/g,
  /\bsetKey\(\s*'([A-Za-z0-9_]+)'\s*\)/g,
];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (/\.(ts|html)$/.test(entry.name) && !entry.name.endsWith('.spec.ts')) yield p;
  }
}

let used = 0;
const unknown = new Map();
let all = '';
for (const file of walk(path.join(root, 'src/app'))) {
  const text = fs.readFileSync(file, 'utf8');
  all += text;
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      used++;
      const key = m[1];
      if (!enKeys.has(key)) {
        const line = text.slice(0, m.index).split('\n').length;
        const rel = path.relative(root, file);
        if (!unknown.has(key)) unknown.set(key, []);
        unknown.get(key).push(`${rel}:${line}`);
      }
    }
  }
}
for (const [key, where] of unknown) problems.push(`ukjent nøkkel "${key}" i ${where.join(', ')}`);
for (const key of enKeys) {
  if (/^(d|r)_/.test(key)) continue;
  if (!new RegExp(`['"\`]${key}['"\`]`).test(all)) problems.push(`ubrukt nøkkel "${key}" (fjern den fra en.json og no.json)`);
}

if (problems.length) {
  console.error(`i18n-check: ${problems.length} problem(er)`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`i18n-check: ok (${enKeys.size} nøkler, ${used} bruk i src/app)`);
