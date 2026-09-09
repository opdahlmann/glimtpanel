#!/usr/bin/env node
// Bygger Docker-imagene lokalt slik Dokploy vil gjøre det (kontekst = repo-rot).
import { execSync } from 'node:child_process';
import { repoRoot } from './env.mjs';
const targets = [
  ['glimt-hub', 'apps/glimt-hub/Dockerfile'],
  ['glimt-web', 'apps/glimt-web/Dockerfile'],
  ['glimt-site', 'apps/glimt-site/Dockerfile'],
];
const only = process.argv.slice(2);
for (const [name, file] of targets) {
  if (only.length && !only.includes(name)) continue;
  console.log(`\n=== ${name} ===`);
  execSync(`docker build -f ${file} -t ${name}:local .`, { cwd: repoRoot, stdio: 'inherit' });
}
