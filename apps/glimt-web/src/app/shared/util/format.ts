/** Tallformatering. Alle tall vises med `.num` (tabular-nums) i malene. */

const KB = 1024;

/** 1536 → "1.5 KB", 0 → "0 B". Én desimal fra KB og opp. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = bytes;
  while (v >= KB && i < units.length - 1) {
    v /= KB;
    i++;
  }
  return `${i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Bytes per sekund → MB/s med én desimal, f.eks. 15518924 → "14.8" (eller "14.8 MB/s"). */
export function formatRate(bytesPerSec: number, withUnit = false): string {
  const mb = Number.isFinite(bytesPerSec) && bytesPerSec > 0 ? bytesPerSec / KB ** 2 : 0;
  const s = mb.toFixed(1);
  return withUnit ? `${s} MB/s` : s;
}

/** Bytes → GB med én desimal som prototypens `f1`, f.eks. 8589934592 → "8.0". */
export function formatGb(bytes: number, withUnit = false): string {
  const gb = Number.isFinite(bytes) && bytes > 0 ? bytes / KB ** 3 : 0;
  const s = (Math.round(gb * 10) / 10).toFixed(1);
  return withUnit ? `${s} GB` : s;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Sekunder → "12d 4h", "4h 12m", "12m" eller "45s" (oppetid). */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** Sekunder → "3d 04:12" (dager + HH:MM) eller "04:12:33" (HH:MM:SS) for prosesstid. */
export function formatDurationClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${pad(h)}:${pad(m)}`;
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

export interface FormatTimeOptions {
  /** Vis sekunder (HH:mm:ss). Standard: false (HH:mm). */
  seconds?: boolean;
  /** IANA-tidssone, f.eks. "Europe/Oslo". Standard: nettleserens. */
  timeZone?: string;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

/** Klokkeslett i 24-timers format via Intl. `formatTime(ms, { seconds: true, timeZone: 'Europe/Oslo' })` → "08:14:05". */
export function formatTime(ms: number | Date, opts: FormatTimeOptions = {}): string {
  const key = `${opts.seconds ? 's' : 'm'}|${opts.timeZone ?? ''}`;
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: opts.seconds ? '2-digit' : undefined,
      hourCycle: 'h23',
      timeZone: opts.timeZone,
    });
    fmtCache.set(key, f);
  }
  return f.format(ms);
}
