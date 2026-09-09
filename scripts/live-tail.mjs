#!/usr/bin/env node
// Følger SignalR-strømmen fra huben i terminalen. Nyttig når web ikke kjører.
// Bruk: node scripts/live-tail.mjs [--hub http://localhost:5080] [--seconds 60]
//         --token <jwt> | --login e-post:passord | --dev-token e-post     (huben krever innlogging på /hub/live)
//         [--server <id>] [--interval 1000|5000] [--log kilde[:enhet-eller-container]] [--history cpu|mem|swap|disk:/|net:eth0|cont:<id>]
//         [--demo]   (henter et demotoken fra POST /api/demo/session)
// Eksempler:
//   node scripts/live-tail.mjs --dev-token dev@glimtpanel.local
//   node scripts/live-tail.mjs --login dev@glimtpanel.local:passord --server dev-ubuntu-dev --log journal:sshd.service --history cpu
import { createRequire } from 'node:module';
import { loadEnv } from './env.mjs';

const require = createRequire(import.meta.url);
const signalR = require('@microsoft/signalr');
const env = loadEnv();
const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const hub = opt('--hub', (env.GLIMT_HUB_URL ?? 'http://localhost:5080').replace('0.0.0.0', 'localhost'));
const seconds = Number(opt('--seconds', '0'));
const server = opt('--server', null);
const interval = opt('--interval', null);
const log = opt('--log', null);
const history = opt('--history', null);
const stamp = () => new Date().toISOString().slice(11, 19);

async function post(path, body) {
  const res = await fetch(`${hub}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function getToken() {
  if (opt('--token', null)) return opt('--token');
  if (has('--demo')) return (await post('/api/demo/session')).accessToken;
  const login = opt('--login', null);
  if (login) {
    const at = login.indexOf(':');
    return (await post('/api/auth/login', { email: login.slice(0, at), password: login.slice(at + 1) })).accessToken;
  }
  const email = opt('--dev-token', env.GLIMT_DEV_USER_EMAIL);
  if (email) return (await post('/api/dev/token', { email })).accessToken;
  throw new Error('gi --token, --login e-post:passord, --dev-token e-post eller --demo');
}

const token = await getToken();
const fmtBps = (b) => b == null ? '-' : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB/s` : `${(b / 1e3).toFixed(0)} kB/s`;
const conn = new signalR.HubConnectionBuilder().withUrl(`${hub}/hub/live`, { accessTokenFactory: () => token }).withAutomaticReconnect().build();
conn.on('ServerStatus', (s) => console.log(`${stamp()} ServerStatus ${s.id} name=${s.name} status=${s.status} connected=${s.connected} lastSeen=${s.lastSeenAt ?? '-'}`));
conn.on('Card', (c) => console.log(`${stamp()} Card ${c.id} status=${c.status} cpu=${c.cpu ?? '-'}% mem=${c.mem ?? '-'}% disk=${c.diskWorst ? `${c.diskWorst.path} ${c.diskWorst.pct}%` : '-'} net=${fmtBps(c.netRx)}/${fmtBps(c.netTx)} containers=${c.containersRunning}/${c.containersTotal} updates=${c.updates ?? '-'} reboot=${c.rebootRequired ?? '-'} failed=${c.failedServices} spark=${c.cpuLastHour.filter((v) => v != null).length}/120`));
conn.on('ServerAdded', (c) => console.log(`${stamp()} ServerAdded ${c.id} ${c.name}`));
conn.on('ServerRemoved', (id) => console.log(`${stamp()} ServerRemoved ${id}`));
conn.on('Server', (s) => {
  const top = (s.processes ?? []).slice(0, 3).map((p) => `${p.name}:${p.cpuPct}%`).join(' ');
  const conts = (s.containers ?? []).map((c) => `${c.name}(${c.state},${c.cpuPct ?? '-'}%)`).join(' ');
  console.log(`${stamp()} Server ${s.id} cpu=${s.host?.cpu?.total}% load=${(s.host?.load ?? []).join('/')} mem=${s.host?.mem?.used}/${s.host?.mem?.total} procs=${s.processTotals?.total ?? '-'} top=[${top}] containers=[${conts}] failed=${(s.services?.failed ?? []).join(',') || '-'} snapshotAt=${s.snapshotAt ?? '-'} streamAt=${s.streamAt ?? '-'}`);
});
conn.on('Log', (streamId, lines, dropped) => { for (const l of lines) console.log(`${stamp()} Log ${streamId.slice(0, 8)} ${new Date(l.ts).toISOString().slice(11, 19)} ${l.priority ?? ''} ${l.unit ?? l.container ?? ''}: ${l.message}`); if (dropped) console.log(`${stamp()} Log ${streamId.slice(0, 8)} dropped=${dropped}`); });
conn.on('LogEnded', (streamId, reason, message) => console.log(`${stamp()} LogEnded ${streamId.slice(0, 8)} reason=${reason} ${message ?? ''}`));
conn.onreconnecting(() => console.log(`${stamp()} reconnecting…`));
conn.onreconnected(() => { console.log(`${stamp()} reconnected`); subscribe(); });

async function subscribe() {
  await conn.invoke('SubscribeOverview');
  if (interval) await conn.invoke('SetInterval', Number(interval));
  if (server) {
    await conn.invoke('SubscribeServer', server);
    if (log) {
      const [source, target] = log.split(':');
      const req = { serverId: server, source, tail: 20 };
      if (target) req[source === 'container' ? 'container' : 'unit'] = target;
      const streamId = await conn.invoke('StartLog', req);
      console.log(`${stamp()} StartLog → ${streamId}`);
    }
  }
}

await conn.start();
console.log(`${stamp()} connected to ${hub}/hub/live`);
await subscribe();
if (history && server) {
  const res = await fetch(`${hub}/api/servers/${server}/history?metric=${encodeURIComponent(history)}&range=1h`, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.json();
  const values = body.values ?? body.rx ?? [];
  console.log(`${stamp()} history ${history} 1h: ${res.status} stepMs=${body.stepMs} from=${new Date(body.from).toISOString()} filled=${values.filter((v) => v != null).length}/${values.length} last=${JSON.stringify(values.slice(-6))}`);
}
if (seconds > 0) setTimeout(async () => { await conn.stop(); process.exit(0); }, seconds * 1000);
