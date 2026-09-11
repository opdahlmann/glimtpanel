import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { HISTORY_CACHE_MS, HistoryService } from '@core/history.service';
import { BadgeComponent } from '@shared/badge/badge.component';
import { RowComponent } from '@shared/row/row.component';
import { SparklineComponent } from '@shared/sparkline/sparkline.component';
import { NetView } from '../server-view';

/** Nettverkspanelet (steg 5.6): rad per grensesnitt med IP-badge, sparkline for siste time (inn) og ↓/↑ MB/s. */
@Component({
  selector: 'gp-net-panel',
  imports: [RowComponent, BadgeComponent, SparklineComponent],
  template: `
    <div class="rows data">
      @for (i of view().ifaces; track i.name) {
        <gp-row [attr.data-iface]="i.name">
          <span class="name">{{ i.name }}</span>
          @if (i.ip) {
            <gp-badge class="num" [attr.title]="i.ips">{{ i.ip }}</gp-badge>
          }
          <gp-sparkline class="spark" [values]="sparks()[i.name] ?? []" color="net" [height]="24" [max]="sparkMax()[i.name] ?? 1" />
          <span trailing class="strong num">{{ i.rx }} {{ i.tx }} <span class="unit">MB/s</span></span>
        </gp-row>
      } @empty {
        <div class="empty">—</div>
      }
    </div>
  `,
  styleUrls: ['./panels.css'],
  styles: `
    .spark { flex: 1; min-width: 80px; }
    @media (max-width: 759.98px) { .spark { flex-basis: 100%; order: 3; } }
  `,
  host: { '[class.dim]': 'dim()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NetPanelComponent {
  readonly view = input.required<NetView>();
  readonly serverId = input.required<string>();
  readonly dim = input(false);

  private readonly history = inject(HistoryService);
  /** Grensesnitt → siste time inn (MB/s, 120 punkter). */
  readonly sparks = signal<Record<string, number[]>>({});
  readonly sparkMax = signal<Record<string, number>>({});
  private timer: ReturnType<typeof setInterval> | null = null;
  private names: string[] = [];

  constructor() {
    effect(() => {
      const id = this.serverId();
      const names = this.view().ifaces.map((i) => i.name);
      untracked(() => {
        if (names.join('|') === this.names.join('|')) return;
        this.names = names;
        this.arm(id, names);
      });
    });
    inject(DestroyRef).onDestroy(() => this.clear());
  }

  private arm(id: string, names: string[]): void {
    this.clear();
    if (!names.length) return;
    void this.load(id, names);
    this.timer = setInterval(() => void this.load(id, names), HISTORY_CACHE_MS);
  }

  private async load(id: string, names: string[]): Promise<void> {
    const sparks: Record<string, number[]> = {};
    const max: Record<string, number> = {};
    await Promise.all(
      names.map(async (name) => {
        try {
          const h = await this.history.get(id, `net:${name}`, '1h');
          const mb = (h.rx ?? []).map((v) => (v === null ? 0 : v / 1024 ** 2));
          sparks[name] = mb;
          max[name] = Math.max(1, ...mb);
        } catch (err) {
          console.warn('[net] could not load history for', name, err);
        }
      }),
    );
    if (this.names === names) {
      this.sparks.set(sparks);
      this.sparkMax.set(max);
    }
  }

  private clear(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
