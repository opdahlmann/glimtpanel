import { ChangeDetectionStrategy, Component, computed, input, model, signal } from '@angular/core';
import { SegmentComponent, SegmentOption } from '../segment/segment.component';
import { formatTime } from '../util/format';
import { clamp, metricColor, withAlpha } from '../util/thr';

export type ChartRange = '1h' | '24h';
export type ChartUnit = '%' | 'MB/s' | 'MB';

export interface ChartEvent {
  /** 0–100, prosent av bredden. */
  x: number;
  color: string;
  label: string;
}

export const CHART_MAX_POINTS = 600;
export const CHART_W = 600;

/** Nedsampler til høyst `maxPoints` ved å snitte bøtter. Bøtter uten tall blir `null` (hull). */
export function downsample(series: (number | null)[], maxPoints = CHART_MAX_POINTS): (number | null)[] {
  const n = series.length;
  if (n <= maxPoints) return series;
  const out: (number | null)[] = [];
  for (let b = 0; b < maxPoints; b++) {
    const start = Math.floor((b * n) / maxPoints);
    const end = Math.max(start + 1, Math.floor(((b + 1) * n) / maxPoints));
    let sum = 0;
    let count = 0;
    for (let i = start; i < end; i++) {
      const v = series[i];
      if (v !== null && v !== undefined && Number.isFinite(v)) {
        sum += v;
        count++;
      }
    }
    out.push(count ? sum / count : null);
  }
  return out;
}

export interface ChartPaths {
  line: string;
  fill: string;
}

/** Bygger linje og fyll som prototypens `chart()`: y = H − v/max·(H−4) − 2. `null` bryter linjen og fyllet. */
export function chartPaths(data: (number | null)[], max: number, h: number, w = CHART_W): ChartPaths {
  const n = data.length;
  if (n < 2 || max <= 0) return { line: '', fill: '' };
  const x = (i: number) => ((i / (n - 1)) * w).toFixed(1);
  const y = (v: number) => (h - (clamp(v, 0, max) / max) * (h - 4) - 2).toFixed(1);
  const line: string[] = [];
  const fill: string[] = [];
  let open = false;
  let last = '';
  for (let i = 0; i < n; i++) {
    const v = data[i];
    if (v === null || v === undefined || !Number.isFinite(v)) {
      if (open) fill.push(`L${last},${h} Z`);
      open = false;
      continue;
    }
    const xi = x(i);
    if (!open) {
      line.push(`M${xi},${y(v)}`);
      fill.push(`M${xi},${h} L${xi},${y(v)}`);
      open = true;
    } else {
      line.push(`L${xi},${y(v)}`);
      fill.push(`L${xi},${y(v)}`);
    }
    last = xi;
  }
  if (open) fill.push(`L${last},${h} Z`);
  return { line: line.join(' '), fill: fill.join(' ') };
}

/**
 * Kurve (6.3): `viewBox 0 0 600 H`, fyll under kurven i 8 %, strek 1,5 px. Segment 1 t / 24 t høyrestilt i hodet.
 * Pekemerke via `pointermove` (mus og finger): hårlinje `#ffffff59` og chip `#282a30` med verdi og klokkeslett. Fem tidsmerker under.
 */
@Component({
  selector: 'gp-chart',
  imports: [SegmentComponent],
  templateUrl: './chart.component.html',
  styleUrl: './chart.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChartComponent {
  readonly series = input<(number | null)[]>([]);
  readonly color = input<string>('cpu');
  readonly height = input<120 | 100>(120);
  readonly stepMs = input(60_000);
  /** Tidspunkt (ms) for første punkt. Uten: nå − (n−1)·stepMs. */
  readonly from = input<number | null>(null);
  readonly max = input<number | 'auto'>(100);
  readonly unit = input<ChartUnit>('%');
  readonly range = model<ChartRange>('1h');
  readonly events = input<ChartEvent[]>([]);
  readonly label = input('');
  readonly timeZone = input<string | undefined>(undefined);
  readonly showRange = input(true);

  readonly rangeOptions: SegmentOption<ChartRange>[] = [
    { value: '1h', label: '1 h' },
    { value: '24h', label: '24 h' },
  ];

  readonly hoverIdx = signal<number | null>(null);

  readonly data = computed(() => downsample(this.series()));
  readonly maxValue = computed(() => {
    const m = this.max();
    if (m !== 'auto') return m;
    let top = 0;
    for (const v of this.data()) if (v !== null && v > top) top = v;
    return top > 0 ? top * 1.1 : 1;
  });
  readonly paths = computed(() => chartPaths(this.data(), this.maxValue(), this.height()));
  readonly stroke = computed(() => metricColor(this.color()));
  readonly fill8 = computed(() => withAlpha(this.stroke(), '14', 8));
  readonly viewBox = computed(() => `0 0 ${CHART_W} ${this.height()}`);

  private readonly start = computed(() => {
    const n = this.series().length;
    return this.from() ?? Date.now() - Math.max(0, n - 1) * this.stepMs();
  });

  /** Tidspunkt for et nedsamplet punkt: skalert tilbake til originalserien. */
  timeAt(idx: number): number {
    const n = this.series().length;
    const m = this.data().length;
    const orig = m > 1 ? (idx / (m - 1)) * (n - 1) : 0;
    return this.start() + orig * this.stepMs();
  }

  readonly ticks = computed(() => {
    const m = this.data().length;
    if (m < 2) return [] as string[];
    return [0, 0.25, 0.5, 0.75, 1].map((f) => formatTime(this.timeAt(Math.round(f * (m - 1))), { timeZone: this.timeZone() }));
  });

  readonly hover = computed(() => {
    const idx = this.hoverIdx();
    const d = this.data();
    if (idx === null || d.length < 2) return null;
    const i = clamp(idx, 0, d.length - 1);
    const v = d[i];
    return {
      x: ((i / (d.length - 1)) * 100).toFixed(2),
      value: v === null ? '—' : this.fmt(v),
      time: formatTime(this.timeAt(i), { timeZone: this.timeZone() }),
    };
  });

  readonly ariaLabel = computed(() => {
    const vals = this.data().filter((v): v is number => v !== null);
    if (!vals.length) return `${this.label()} no data`.trim();
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const last = vals[vals.length - 1];
    return `${this.label()} min ${this.fmt(min)}, max ${this.fmt(max)}, last ${this.fmt(last)}`.trim();
  });

  fmt(v: number): string {
    const u = this.unit();
    if (u === '%') return `${Math.round(v)}%`;
    return `${(Math.round(v * 10) / 10).toFixed(1)} ${u}`;
  }

  onPointer(e: PointerEvent): void {
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const m = this.data().length;
    if (m < 2 || rect.width <= 0) return;
    const i = clamp(Math.round(((e.clientX - rect.left) / rect.width) * (m - 1)), 0, m - 1);
    if (this.hoverIdx() !== i) this.hoverIdx.set(i);
  }
  leave(): void {
    this.hoverIdx.set(null);
  }
}
