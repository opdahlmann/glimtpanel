#!/usr/bin/env node
// Sjekker at verktøyene for `npm run dev` finnes. Grønt = klar.
import { execSync } from 'node:child_process';

function run(cmd) { try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } }
const rows = [];
function check(name, ok, detail, optional = false) { rows.push({ name, ok, detail, optional }); }

const node = process.versions.node;
check('Node ≥ 22', Number(node.split('.')[0]) >= 22, `v${node}`);
check('npm', !!run('npm --version'), run('npm --version'));
const dotnet = run('dotnet --version');
check('.NET SDK 10', !!dotnet && dotnet.startsWith('10.'), dotnet ?? 'mangler');
const docker = run('docker --version');
const dockerUp = !!run('docker info --format "{{.ServerVersion}}"');
check('Docker CLI', !!docker, docker ?? 'mangler');
check('Docker-daemon kjører', dockerUp, dockerUp ? run('docker info --format "{{.ServerVersion}} {{.OSType}}/{{.Architecture}}"') : 'start Docker Desktop');
check('Go (valgfritt, agenten bygges i Docker)', !!run('go version'), run('go version') ?? 'ikke installert', true);
check('Angular CLI (npx)', true, 'brukes via npx / workspace', true);
check('Playwright-nettlesere (valgfritt)', !!run('npx --no-install playwright --version'), run('npx --no-install playwright --version') ?? 'kjør: npx playwright install chromium webkit', true);

let bad = 0;
for (const r of rows) {
  const mark = r.ok ? '✓' : r.optional ? '·' : '✗';
  if (!r.ok && !r.optional) bad++;
  console.log(`${mark} ${r.name.padEnd(44)} ${r.detail ?? ''}`);
}
console.log(bad ? `\n${bad} påkrevd(e) verktøy mangler.` : '\nAlt påkrevd er på plass.');
process.exit(bad ? 1 : 0);
