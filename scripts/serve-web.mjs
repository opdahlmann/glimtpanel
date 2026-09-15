#!/usr/bin/env node
// Serverer den bygde web-appen (apps/glimt-web/dist/glimt-web/browser) slik nginx gjør det i containeren, for e2e mot
// bygget web (IMPLEMENTERINGSPLAN steg 11.1): SPA-fallback, /config.json fra miljøet, /api og /hub (inkl. WebSocket)
// proxyet til GLIMT_HUB_INTERNAL_URL, samme cache-regler og de samme sikkerhetshodene som nginx
// (infra/glimt-web/security-headers.conf leses her, så én CSP gjelder begge steder).
// Bruk: node scripts/serve-web.mjs [--port 4200] [--dist <mappe>]
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { buildConfig } from './web-config.mjs';
import { loadEnv, repoRoot } from './env.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const env = loadEnv();
const port = Number(flag('--port', env.GLIMT_WEB_PORT ?? 4200));
const dist = path.resolve(repoRoot, flag('--dist', 'apps/glimt-web/dist/glimt-web/browser'));
const hub = new URL(env.GLIMT_HUB_INTERNAL_URL ?? 'http://localhost:5080');
const config = Buffer.from(JSON.stringify(buildConfig(env), null, 2) + '\n');

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error(`serve-web: fant ikke ${dist}/index.html – bygg først: npm --workspace apps/glimt-web run build -- --configuration production`);
  process.exit(2);
}

/** `add_header Navn "verdi" always;` → [Navn, verdi], samme fil som nginx bruker. */
export function parseSecurityHeaders(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*add_header\s+(\S+)\s+"((?:[^"\\]|\\.)*)"\s+always\s*;/);
    if (m) out.push([m[1], m[2]]);
  }
  return out;
}
const securityHeaders = parseSecurityHeaders(path.join(repoRoot, 'infra/glimt-web/security-headers.conf'));

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json' };

function withSecurity(res) {
  for (const [name, value] of securityHeaders) res.setHeader(name, value);
}

function proxy(req, res) {
  const upstream = http.request({ hostname: hub.hostname, port: hub.port || 80, path: req.url, method: req.method, headers: { ...req.headers, host: req.headers.host ?? hub.host, 'x-forwarded-proto': 'http', 'x-forwarded-for': req.socket.remoteAddress ?? '' } }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`hub unavailable: ${err.message}`);
  });
  req.pipe(upstream);
}

function serveFile(res, file, cache) {
  const ext = path.extname(file).toLowerCase();
  res.setHeader('content-type', types[ext] ?? 'application/octet-stream');
  res.setHeader('cache-control', cache);
  withSecurity(res);
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/hub/')) return proxy(req, res);
  if (url.pathname === '/config.json') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...Object.fromEntries(securityHeaders) });
    return res.end(config);
  }
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.join(dist, rel);
  if (rel && file.startsWith(dist) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    const immutable = /\.(js|css|woff2)$/.test(rel) || rel.startsWith('media/');
    return serveFile(res, file, immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
  }
  return serveFile(res, path.join(dist, 'index.html'), 'no-cache');
});

// WebSocket (SignalR /hub/live): videresend oppgraderingen og koble strømmene sammen.
server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(Number(hub.port || 80), hub.hostname, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(req.headers)) lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  const drop = () => socket.destroy();
  upstream.on('error', drop);
  socket.on('error', () => upstream.destroy());
});

server.listen(port, '127.0.0.1', () => console.log(`serve-web: ${dist} på http://localhost:${port}, /api og /hub → ${hub.origin}`));
