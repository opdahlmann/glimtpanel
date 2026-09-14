#!/usr/bin/env node
// Lager PWA-ikonene i public/icons/ fra logoen (samme SVG som gp-logo og favicon.svg): icon-192/512 (any),
// icon-maskable-192/512 (logoen på 80 % med mørk bakgrunn, så maskering ikke kutter buene) og apple-touch-icon (180).
// Bruker Playwrights Chromium (finnes i e2e-workspacet). Kjøres med `npm --workspace apps/glimt-web run icons`
// etter en logoendring; bildene sjekkes inn.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, '..', '..', 'e2e', 'package.json'));
const { chromium } = require('playwright');

const logo = fs.readFileSync(path.join(root, 'public/favicon.svg'), 'utf8');
const outDir = path.join(root, 'public/icons');
fs.mkdirSync(outDir, { recursive: true });

function page(size, scale, background) {
  const inner = Math.round(size * scale);
  const offset = Math.round((size - inner) / 2);
  return `<!doctype html><html><body style="margin:0;width:${size}px;height:${size}px;background:${background};overflow:hidden">
    <div style="position:absolute;left:${offset}px;top:${offset}px;width:${inner}px;height:${inner}px">${logo.replace('<svg ', `<svg style="width:${inner}px;height:${inner}px" `)}</div>
  </body></html>`;
}

const jobs = [
  ['icon-192.png', 192, 1, 'transparent'],
  ['icon-512.png', 512, 1, 'transparent'],
  ['icon-maskable-192.png', 192, 0.8, '#23252b'],
  ['icon-maskable-512.png', 512, 0.8, '#23252b'],
  ['apple-touch-icon.png', 180, 1, '#23252b'],
];

const browser = await chromium.launch();
try {
  for (const [file, size, scale, background] of jobs) {
    const p = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await p.setContent(page(size, scale, background));
    await p.screenshot({ path: path.join(outDir, file), omitBackground: background === 'transparent', clip: { x: 0, y: 0, width: size, height: size } });
    await p.close();
    console.log(`skrev public/icons/${file}`);
  }
} finally {
  await browser.close();
}
