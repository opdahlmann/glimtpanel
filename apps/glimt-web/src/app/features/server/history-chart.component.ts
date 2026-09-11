import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, input, model, signal, untracked } from '@angular/core';
import { HISTORY_CACHE_MS, HistoryRange, HistoryResult, HistoryService } from '@core/history.service';
import { I18nService } from '@core/i18n.service';
import { HourChart } from '@core/live.store';
import { ChartComponent, ChartEvent, ChartUnit } from '@shared/chart/chart.component';

interface Series {
  values: (number | null)[];
  stepMs: number;
  from: number | null;
}

/**
 * Kurve med 1 t / 24 t (steg 5.3, 5.13, 5.14). 1 t kommer fra `live` (ringen i LiveStore, 600 punkter à 6 s) når den
 * finnes, ellers fra `history?range=1h`; 24 t alltid fra `history?range=24h`. Historikken hentes ved bytte og
 * oppfriskes hvert 60. sekund mens den vises (HistoryService mellomlagrer i 60 s). Hull (server nede) vises som brudd.
 */
@Component({
  selector: 'gp-history-chart',
  imports: [ChartComponent],
  template: `
    <gp-chart
      [series]="series().values"
      [stepMs]="series().stepMs"
      [from]="series().from"
      [color]="color()"
      [height]="height()"
      [unit]="unit()"
      [max]="max()"
      [events]="events()"
      [label]="label()"
      [timeZone]="timeZone()"
      [(range)]="range"
    >
      <ng-content />
      @if (empty()) {
        <span class="empty">{{ i18n.t('noHistory') }}</span>
      }
    </gp-chart>
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .empty { font-weight: 400; color: var(--w-45); }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HistoryChartComponent {
  readonly serverId = input.required<string>();
  /** `cpu`, `mem`, `cont:<id>` eller `cont:<id>:mem`. */
  readonly metric = input.required<string>();
  /** Siste time fra ringen (serversiden). Null = hent 1 t fra historikken (containersiden). */
  readonly live = input<HourChart | null>(null);
  readonly color = input('cpu');
  readonly height = input<120 | 100>(120);
  readonly unit = input<ChartUnit>('%');
  readonly max = input<number | 'auto'>(100);
  readonly events = input<ChartEvent[]>([]);
  readonly label = input('');
  readonly range = model<HistoryRange>('1h');

  readonly i18n = inject(I18nService);
  private readonly history = inject(HistoryService);
  private readonly fetched = signal<HistoryResult | null>(null);
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;

  readonly timeZone = computed(() => this.i18n.timeZone() ?? undefined);

  private readonly useLive = computed(() => this.range() === '1h' && this.live() !== null);

  readonly series = computed<Series>(() => {
    if (this.useLive()) {
      const l = this.live() as HourChart;
      const values = /:mem$|^mem$/.test(this.metric()) ? l.mem : l.cpu;
      return { values, stepMs: l.stepMs, from: l.from > 0 ? l.from : null };
    }
    const h = this.fetched();
    if (!h || h.range !== this.range()) return { values: [], stepMs: this.range() === '1h' ? 30_000 : 300_000, from: null };
    return { values: h.values ?? h.rx ?? [], stepMs: h.stepMs, from: h.from };
  });

  readonly empty = computed(() => !this.series().values.some((v) => v !== null));

  constructor() {
    const destroyRef = inject(DestroyRef);
    effect(() => {
      const id = this.serverId();
      const metric = this.metric();
      const range = this.range();
      const wantFetch = !this.useLive();
      untracked(() => this.arm(wantFetch, id, metric, range));
    });
    destroyRef.onDestroy(() => this.clearTimer());
  }

  private arm(wantFetch: boolean, id: string, metric: string, range: HistoryRange): void {
    this.clearTimer();
    if (!wantFetch) return;
    void this.load(id, metric, range);
    this.timer = setInterval(() => void this.load(id, metric, range), HISTORY_CACHE_MS);
  }

  private async load(id: string, metric: string, range: HistoryRange): Promise<void> {
    const seq = ++this.seq;
    try {
      const result = await this.history.get(id, metric, range);
      if (seq === this.seq) this.fetched.set(result);
    } catch (err) {
      if (seq === this.seq) console.warn('[history] could not load', metric, range, err);
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
