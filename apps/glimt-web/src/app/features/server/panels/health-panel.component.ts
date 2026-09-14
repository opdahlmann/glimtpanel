import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { I18nService } from '@core/i18n.service';
import { LiveDotComponent } from '@shared/live-dot/live-dot.component';
import { RowComponent } from '@shared/row/row.component';
import { HealthView } from '../server-view';

/**
 * Helse og sjekker (steg 12.9, skjerm 21): helsesjekk-URL med status, svartid og «checked 08:14:02», én rad per
 * TCP-sjekk med navn, mål, ok/feil og ms. Panelet tones grønt eller rødt av siden.
 */
@Component({
  selector: 'gp-health-panel',
  imports: [RowComponent, LiveDotComponent],
  template: `
    @if (!view().configured) {
      <div class="empty">{{ i18n.t('noHealthUrl') }}</div>
    } @else {
      <div class="rows data">
        @if (view().line) {
          <gp-row data-testid="health-row">
            <gp-live-dot leading [state]="view().ok ? 'up' : 'down'" />
            <span class="name">{{ i18n.t('healthUrl') }}</span>
            <span class="sub mono num">{{ view().line }}</span>
            <span trailing class="num muted">{{ view().checked }}</span>
          </gp-row>
        }
        @for (c of view().checks; track c.name) {
          <gp-row [attr.data-check]="c.name">
            <gp-live-dot leading [state]="c.ok ? 'up' : 'down'" />
            <span class="name">{{ c.name }}</span>
            <span class="sub mono num">{{ c.target }}</span>
            <span trailing class="strong num" [class.crit]="!c.ok">{{ c.ok ? i18n.t('ok') : i18n.t('healthFail') }} · {{ c.text }}</span>
          </gp-row>
        }
      </div>
    }
  `,
  styleUrls: ['./panels.css'],
  styles: `
    .muted { color: var(--w-45); font-size: 11px; }
    .crit { color: var(--color-crit); }
  `,
  host: { '[class.dim]': 'dim()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HealthPanelComponent {
  readonly view = input.required<HealthView>();
  readonly dim = input(false);
  readonly i18n = inject(I18nService);
}
