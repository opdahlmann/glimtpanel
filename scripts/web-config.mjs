#!/usr/bin/env node
// Lager apps/glimt-web/public/config.json fra miljøvariabler (samme som docker-entrypoint.sh gjør i containeren).
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, repoRoot } from './env.mjs';

const env = loadEnv();
const config = {
  env: env.GLIMT_ENV ?? 'development',
  apiUrl: '/api',
  hubUrl: '/hub/live',
  hubPublicUrl: env.GLIMT_HUB_PUBLIC_URL ?? 'http://localhost:5080',
  installUrl: env.GLIMT_INSTALL_URL ?? 'http://localhost:5080/install',
  docsUrl: env.GLIMT_DOCS_URL ?? 'https://github.com/opdahlmann/glimtpanel#readme',
  vapidPublic: env.GLIMT_VAPID_PUBLIC ?? '',
  defaultLang: env.GLIMT_DEFAULT_LANG ?? 'en',
  featureFlags: (env.GLIMT_FEATURE_FLAGS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
};
const out = path.join(repoRoot, 'apps/glimt-web/public/config.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(config, null, 2) + '\n');
console.log(`skrev ${path.relative(repoRoot, out)}`);
