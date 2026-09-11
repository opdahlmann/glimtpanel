import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { I18nService } from '@core/i18n.service';
import { HourChart } from '@core/live.store';
import { ChipComponent } from '@shared/chip/chip.component';
import { HistoryChartComponent } from '../history-chart.component';
import { CpuView } from '../server-view';

/** CPU-panelet (steg 5.3): kjernestolper, seks belastningschips og kurven for siste time / 24 t. */
@Component({
  selector: 'gp-cpu-panel',
  imports: [ChipComponent, HistoryChartComponent],
  template: `
    <div class="cores data" role="list" [attr.aria-label]="i18n.t('perCore')">
      @for (c of view().cores; track c.label) {
        <div class="core" role="listitem" [attr.aria-label]="c.label + ' ' + c.pct + '%'">
          <div class="bar"><div class="fill" [style.height.%]="c.pct"></div></div>
          <span class="label">{{ c.label }}</span>
        </div>
      }
    </div>
    <div class="chips data">
      @for (c of view().chips; track c.label) {
        <gp-chip [label]="c.label" [value]="c.value" [tone]="c.tone">@if (c.sub) {<span class="unit"> {{ c.sub }}</span>}</gp-chip>
      }
    </div>
    <gp-history-chart [serverId]="serverId()" metric="cpu" [live]="live()" color="cpu" [height]="120" unit="%" [label]="i18n.t('cpu')" />
  `,
  styleUrls: ['./panels.css', './cpu-panel.component.css'],
  host: { '[class.dim]': 'dim()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CpuPanelComponent {
  readonly view = input.required<CpuView>();
  readonly serverId = input.required<string>();
  readonly live = input<HourChart | null>(null);
  readonly dim = input(false);
  readonly i18n = inject(I18nService);
}
