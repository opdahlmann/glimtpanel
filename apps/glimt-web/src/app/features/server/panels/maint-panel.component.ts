import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { I18nService } from '@core/i18n.service';
import { BadgeComponent } from '@shared/badge/badge.component';
import { ChipComponent } from '@shared/chip/chip.component';
import { MaintView } from '../server-view';

/** Vedlikeholdspanelet (steg 5.10): tre chips, «Triggered by», «needs restart» og Ubuntu-linjen med support-badge. */
@Component({
  selector: 'gp-maint-panel',
  imports: [ChipComponent, BadgeComponent],
  template: `
    <div class="chips-3 data">
      @for (c of view().chips; track c.label) {
        <gp-chip [label]="c.label" [value]="c.value" [tone]="c.tone" />
      }
    </div>
    @if (view().rebootRequired) {
      @if (view().triggeredBy) {
        <div class="muted">{{ view().triggeredBy }}</div>
      }
      @if (view().needsRestart) {
        <div class="muted">{{ i18n.t('needsRestart') }}: <span class="warn strong">{{ view().needsRestart }}</span></div>
      }
    }
    <div class="ubuntu muted">
      <span>{{ view().ubuntu }}</span>
      @if (view().support) {
        <gp-badge [tone]="view().supportTone">{{ view().support }}</gp-badge>
      }
    </div>
  `,
  styleUrls: ['./panels.css'],
  styles: `.ubuntu { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }`,
  host: { '[class.dim]': 'dim()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MaintPanelComponent {
  readonly view = input.required<MaintView>();
  readonly dim = input(false);
  readonly i18n = inject(I18nService);
}
