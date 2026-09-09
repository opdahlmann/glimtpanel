#!/usr/bin/env node
// Pre-commit-sjekk: kun README.md av markdown-filer og kun example.env av env-filer får sjekkes inn.
import { execSync } from 'node:child_process';
import path from 'node:path';

const staged = execSync('git diff --cached --name-only --diff-filter=ACMR', { encoding: 'utf8' })
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

const offending = [];
for (const file of staged) {
  const base = path.basename(file);
  if (base.toLowerCase().endsWith('.md') && base !== 'README.md') offending.push(`${file}  (markdown: kun README.md er tillatt)`);
  if (/^\.env(\..+)?$/.test(base)) offending.push(`${file}  (env-fil: kun example.env er tillatt)`);
}

if (offending.length) {
  console.error('\nCommit avvist av scripts/precommit.mjs:\n');
  for (const o of offending) console.error('  - ' + o);
  console.error('\nFjern filene fra staging (git restore --staged <fil>) og prøv igjen.\n');
  process.exit(1);
}
