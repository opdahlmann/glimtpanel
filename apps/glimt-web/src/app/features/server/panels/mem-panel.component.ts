import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { I18nService } from '@core/i18n.service';
import { HourChart } from '@core/live.store';
import { BarComponent, BarSegment } from '@shared/bar/bar.component';
import { HistoryChartComponent } from '../history-chart.component';
import { MemView } from '../server-view';

/** Minnepanelet (steg 5.4): segmentert stolpe brukt / buffer+cache, legende i to kolonner og kurven. */
@Component({
  selector: 'gp-mem-panel',
  imports: [BarComponent, HistoryChartComponent],
  template: `
    <gp-bar class="data" [height]="8" [segments]="segments()" [label]="i18n.t('memory')" />
    <div class="legend data">
      @for (l of view().legend; track l.name) {
        <div class="item"><span class="swatch" [style.background]="l.color" aria-hidden="true"></span><span class="lname">{{ l.name }}</span><span class="lval num">{{ l.value }}</span></div>
      }
    </div>
    <gp-history-chart [serverId]="serverId()" metric="mem" [live]="live()" color="ram" [height]="120" unit="%" [label]="i18n.t('memory')" />
  `,
  styleUrls: ['./panels.css'],
  styles: `
    .legend { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px; }
    .item { display: flex; align-items: center; gap: 6px; font-size: 10.5px; color: var(--w-70); min-width: 0; }
    .swatch { width: 7px; height: 7px; border-radius: 2px; flex: none; }
    .lname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lval { color: var(--w-50); white-space: nowrap; }
  `,
  host: { '[class.dim]': 'dim()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MemPanelComponent {
  readonly view = input.required<MemView>();
  readonly serverId = input.required<string>();
  readonly live = input<HourChart | null>(null);
  readonly dim = input(false);
  readonly i18n = inject(I18nService);

  readonly segments = computed<BarSegment[]>(() => [
    { value: this.view().usedPct, color: 'ram' },
    { value: this.view().bufPct, color: 'disk' },
  ]);
}
