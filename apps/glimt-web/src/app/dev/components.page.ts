import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { ColDef } from 'ag-grid-community';
import {
  BadgeComponent,
  BarComponent,
  ButtonComponent,
  ChartComponent,
  ChartEvent,
  ChipComponent,
  InputComponent,
  LiveDotComponent,
  LogLine,
  LogViewComponent,
  LogoComponent,
  ModalComponent,
  PanelComponent,
  RingComponent,
  RowComponent,
  SegmentComponent,
  SegmentOption,
  SelectComponent,
  SparklineComponent,
  ToastHostComponent,
  ToastService,
  ToggleComponent,
  formatDurationClock,
  thr,
} from '@shared/index';
import { DataGridComponent } from '@shared/data-grid/data-grid.component';

interface Proc {
  pid: number;
  name: string;
  user: string;
  cpu: number;
  mem: number;
  time: number;
  cmd: string;
}
interface Port {
  port: number;
  proc: string;
  proto: string;
  isNew: boolean;
}

/** Deterministisk «tilfeldig» serie slik at skjermbildene er stabile. */
function synth(n: number, base: number, amp: number, gapAt?: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    const v = base + amp * Math.sin((i / n) * Math.PI * 2 - 1.2) + 4 * Math.sin(i * 1.7) + 2 * Math.cos(i * 0.37);
    out.push(gapAt !== undefined && i >= gapAt && i < gapAt + Math.max(3, Math.round(n / 24)) ? null : Math.max(1, Math.min(99, v)));
  }
  return out;
}

/** Alle felleskomponentene i alle tilstander (IMPLEMENTERINGSPLAN steg 3.5). Kun i utvikling. Tekstene er engelske literaler. */
@Component({
  selector: 'gp-components-page',
  imports: [
    FormsModule,
    RingComponent,
    ChipComponent,
    RowComponent,
    BadgeComponent,
    BarComponent,
    SegmentComponent,
    ToggleComponent,
    ButtonComponent,
    InputComponent,
    SelectComponent,
    SparklineComponent,
    ChartComponent,
    PanelComponent,
    ModalComponent,
    ToastHostComponent,
    LiveDotComponent,
    LogoComponent,
    LogViewComponent,
    DataGridComponent,
  ],
  templateUrl: './components.page.html',
  styleUrl: './components.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComponentsPage {
  private readonly toastService = inject(ToastService);

  readonly plus = 'M12 5v14M5 12h14';
  readonly copyIcon = 'M8 8h12v12H8zM4 16V4h12';

  // Segment
  readonly seg2: SegmentOption[] = [
    { value: 'in', label: 'Sign in' },
    { value: 'up', label: 'Create account' },
  ];
  readonly seg3: SegmentOption[] = [
    { value: 'all', label: 'All' },
    { value: 'err', label: 'Errors' },
    { value: 'warn', label: 'Warnings' },
    { value: 'info', label: 'Info' },
  ];
  readonly seg8: SegmentOption[] = ['System', 'Login & sudo', 'Kernel', 'Packages', 'Web server', 'Firewall', 'Containers', 'Custom files'].map((l, i) => ({
    value: `s${i}`,
    label: l,
  }));
  readonly segA = signal('in');
  readonly segB = signal('all');
  readonly segC = signal('s0');
  readonly segD = signal('all');

  // Toggle
  readonly on = signal(true);
  readonly off = signal(false);

  // Inputs
  readonly email = signal('ole@kodetank.no');
  readonly search = signal('');
  readonly bad = signal('short');
  readonly sort = signal('cpu');
  readonly sortOptions = [
    { value: 'name', label: 'Sort: Name' },
    { value: 'cpu', label: 'Sort: CPU' },
    { value: 'mem', label: 'Sort: Memory' },
  ];
  readonly tz = signal('Europe/Oslo');
  readonly tzOptions = [
    { value: 'Europe/Oslo', label: 'Europe/Oslo' },
    { value: 'UTC', label: 'UTC' },
  ];

  // Sparklines and charts
  readonly spark = synth(60, 40, 25).map((v) => v ?? 0);
  readonly sparkMem = synth(60, 60, 8).map((v) => v ?? 0);
  readonly serie60 = synth(60, 45, 20, 38);
  readonly serie288 = synth(288, 55, 25, 200);
  readonly rate288 = synth(288, 12, 8).map((v) => (v === null ? null : v / 3));
  readonly from60 = Date.UTC(2026, 8, 10, 6, 15);
  readonly from288 = Date.UTC(2026, 8, 9, 7, 15);
  readonly range1 = signal<'1h' | '24h'>('1h');
  readonly range2 = signal<'1h' | '24h'>('24h');
  readonly events: ChartEvent[] = [{ x: 72, color: 'var(--color-warn)', label: 'Reboot required 22:10' }];

  // Panels
  readonly cpuOpen = signal(true);
  readonly closedOpen = signal(false);

  // Data grid
  readonly procs: Proc[] = [
    { pid: 1842, name: 'node', user: 'www-data', cpu: 38.2, mem: 412, time: 3 * 86400 + 4 * 3600 + 12 * 60, cmd: 'node /srv/app/server.js --port 8080' },
    { pid: 911, name: 'postgres', user: 'postgres', cpu: 12.4, mem: 1024, time: 41 * 86400 + 2 * 3600, cmd: 'postgres: checkpointer' },
    { pid: 2201, name: 'nginx', user: 'root', cpu: 3.1, mem: 48, time: 41 * 86400, cmd: 'nginx: master process /usr/sbin/nginx -g daemon on; master_process on;' },
    { pid: 3390, name: 'dockerd', user: 'root', cpu: 2.2, mem: 156, time: 41 * 86400, cmd: '/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock' },
    { pid: 1, name: 'systemd', user: 'root', cpu: 0.4, mem: 12, time: 41 * 86400, cmd: '/sbin/init' },
    { pid: 4410, name: 'python3', user: 'ole', cpu: 61.9, mem: 220, time: 12 * 60 + 33, cmd: 'python3 -m http.server 8000' },
    { pid: 780, name: 'sshd', user: 'root', cpu: 0.1, mem: 9, time: 41 * 86400, cmd: 'sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups' },
    { pid: 5602, name: 'glimt-agent', user: 'glimt', cpu: 0.6, mem: 18, time: 12 * 86400 + 4 * 3600, cmd: '/opt/glimt/agent --hub wss://hub.glimtpanel.com' },
  ];
  readonly procColumns: ColDef<Proc>[] = [
    { field: 'name', headerName: 'Process', flex: 1, minWidth: 140, cellRenderer: (p: { data?: Proc }) => nameCell(p.data) },
    { field: 'cpu', headerName: 'CPU', width: 72, cellClass: 'num', headerClass: 'num', valueFormatter: (p) => `${p.value.toFixed(1)}%`, cellStyle: (p) => ({ color: p.value > 50 ? 'var(--color-warn)' : 'var(--w-85)', fontWeight: 600 }) },
    { field: 'mem', headerName: 'Memory', width: 90, cellClass: 'num', headerClass: 'num', valueFormatter: (p) => `${p.value} MB`, cellStyle: { fontWeight: 600, color: 'var(--w-85)' } },
    { field: 'time', headerName: 'Time', width: 94, cellClass: 'num', headerClass: 'num', valueFormatter: (p) => formatDurationClock(p.value), cellStyle: { fontSize: '11px', color: 'var(--w-60)' } },
  ];
  readonly procId = (p: Proc) => String(p.pid);
  readonly procFilter = signal('');

  readonly ports: Port[] = [
    { port: 22, proc: 'sshd', proto: 'tcp', isNew: false },
    { port: 80, proc: 'nginx', proto: 'tcp', isNew: false },
    { port: 443, proc: 'nginx', proto: 'tcp', isNew: false },
    { port: 8000, proc: 'python3', proto: 'tcp', isNew: true },
  ];
  readonly portColumns: ColDef<Port>[] = [
    { field: 'port', headerName: 'Port', width: 80, cellClass: 'num', cellStyle: { fontWeight: 600, color: 'var(--w-90)' } },
    { field: 'proc', headerName: 'Process', flex: 1, minWidth: 120, cellStyle: { color: 'var(--w-70)', fontSize: '11px' } },
    { field: 'proto', headerName: 'Proto', width: 72, cellStyle: { color: 'var(--w-40)', fontSize: '10px' } },
  ];
  readonly portId = (p: Port) => String(p.port);

  // Log view
  readonly logLines: LogLine[] = [
    { ts: this.from60 + 3_600_000, unit: 'sshd', priority: 'warn', message: 'Failed password for invalid user admin from 185.220.101.4 port 51422 ssh2' },
    { ts: this.from60 + 3_540_000, unit: 'nginx', priority: 'info', message: '10.0.0.12 - - "GET /api/servers HTTP/1.1" 200 1832' },
    { ts: this.from60 + 3_480_000, unit: 'kernel', priority: 'err', message: 'EXT4-fs error (device sda1): ext4_find_entry:1455: inode #1234: comm node: reading directory lblock 0' },
    { ts: this.from60 + 3_420_000, unit: 'systemd', priority: 'info', message: 'Started Daily apt download activities.' },
    { ts: this.from60 + 3_360_000, container: 'web-web', priority: 'info', message: 'server listening on :8080' },
    { ts: this.from60 + 3_300_000, unit: 'ufw', priority: 'warn', message: '[UFW BLOCK] IN=eth0 OUT= SRC=45.155.205.233 DST=10.0.0.5 PROTO=TCP DPT=23' },
    { ts: this.from60 + 3_240_000, unit: 'postgres', priority: 'err', message: 'FATAL: password authentication failed for user "app" — a very long message that must wrap on narrow screens without horizontal scrolling anywhere' },
    { ts: this.from60 + 3_180_000, container: 'web-db', priority: 'info', message: 'checkpoint complete: wrote 412 buffers (2.5%)' },
  ];
  readonly unitColors = new Map<string, string>([
    ['web-web', 'var(--color-swap)'],
    ['web-db', 'var(--color-net)'],
  ]);

  // Modal, toast, live dot
  readonly modalOpen = signal(false);
  readonly pulse = signal(false);
  readonly serverName = signal('');

  thr(pct: number, base: string): string {
    return thr(pct, base);
  }

  clock(seconds: number): string {
    return formatDurationClock(seconds);
  }

  toast(): void {
    this.toastService.show('Copied to clipboard');
  }

  blip(): void {
    this.pulse.update((v) => !v);
  }
}

function nameCell(p: Proc | undefined): string {
  if (!p) return '';
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
  return `<div class="gp-grid-stack"><div class="gp-grid-name">${esc(p.name)}</div><div class="gp-grid-sub">${esc(p.user)} · <span class="num">${p.pid}</span></div></div>`;
}
