/** Terskelfargen fra IMPLEMENTERINGSPLAN 6.1: crit fra 90 %, warn fra 80 %, ellers grunnfargen. Returnerer CSS-verdier (token-variabler). */
export const COLOR_CRIT = 'var(--color-crit)';
export const COLOR_WARN = 'var(--color-warn)';

export type MetricColor = 'cpu' | 'ram' | 'disk' | 'net' | 'swap';
const METRICS: readonly string[] = ['cpu', 'ram', 'disk', 'net', 'swap'];

/** Navngitt måling (`cpu`, `ram`, …) → token-variabel; alt annet sendes videre som rå CSS-farge. */
export function metricColor(color: MetricColor | string): string {
  return METRICS.includes(color) ? `var(--color-${color})` : color;
}

export function thr(pct: number, base: string): string {
  if (pct >= 90) return COLOR_CRIT;
  if (pct >= 80) return COLOR_WARN;
  return base;
}

/** Fargen med alfa: hex-farger får suffiks (`#0a84ff` + `14`), alt annet via `color-mix` slik at token-variabler også virker. */
export function withAlpha(color: string, hexAlpha: string, percent: number): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color + hexAlpha;
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
}

export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
