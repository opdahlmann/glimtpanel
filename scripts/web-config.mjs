#!/usr/bin/env node
// Lager apps/glimt-web/public/config.json fra miljøvariabler (samme som docker-entrypoint.sh gjør i containeren).
// `buildConfig` brukes også av scripts/serve-web.mjs, som serverer /config.json fra minnet.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, repoRoot } from './env.mjs';

export function buildConfig(env) {
  return {
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = path.join(repoRoot, 'apps/glimt-web/public/config.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(buildConfig(loadEnv()), null, 2) + '\n');
  console.log(`skrev ${path.relative(repoRoot, out)}`);
}
