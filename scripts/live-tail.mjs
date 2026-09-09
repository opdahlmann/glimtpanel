#!/usr/bin/env node
// Følger SignalR-strømmen fra huben i terminalen: skriver hver ServerStatus-melding. Nyttig når web ikke kjører.
// Bruk: node scripts/live-tail.mjs [--hub http://localhost:5080] [--seconds 60]
import { createRequire } from 'node:module';
import { loadEnv } from './env.mjs';

const require = createRequire(import.meta.url);
const signalR = require('@microsoft/signalr');
const env = loadEnv();
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const hub = opt('--hub', (env.GLIMT_HUB_URL ?? 'http://localhost:5080').replace('0.0.0.0', 'localhost'));
const seconds = Number(opt('--seconds', '0'));

const conn = new signalR.HubConnectionBuilder().withUrl(`${hub}/hub/live`).withAutomaticReconnect().build();
const stamp = () => new Date().toISOString().slice(11, 19);
conn.on('ServerStatus', (s) => console.log(`${stamp()} ServerStatus ${s.id} name=${s.name} status=${s.status} connected=${s.connected} lastSeen=${s.lastSeenAt ?? '-'}`));
conn.onreconnecting(() => console.log(`${stamp()} reconnecting…`));
conn.onreconnected(() => { console.log(`${stamp()} reconnected`); conn.invoke('SubscribeOverview'); });
await conn.start();
console.log(`${stamp()} connected to ${hub}/hub/live`);
await conn.invoke('SubscribeOverview');
if (seconds > 0) setTimeout(async () => { await conn.stop(); process.exit(0); }, seconds * 1000);
