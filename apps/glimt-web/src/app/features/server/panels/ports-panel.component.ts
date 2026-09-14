import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { I18nService } from '@core/i18n.service';
import { BadgeComponent } from '@shared/badge/badge.component';
import { PortRow } from '../server-view';

/** Porter alene (steg 12.9): containernoden har ingen innlogginger, SSH-tellere eller brannmur, bare lyttende porter. */
@Component({
  selector: 'gp-ports-panel',
  imports: [BadgeComponent],
  template: `
    <div class="rows-tight data">
      @for (p of rows(); track p.key) {
        <div class="port num" [attr.data-port]="p.port">
          <span class="strong">{{ p.port }}</span>
          <span class="proto">{{ p.proto }}</span>
          <span class="proc">{{ p.process || '—' }}</span>
          @if (p.isNew) {
            <gp-badge tone="new">{{ i18n.t('newBadge') }}</gp-badge>
          }
        </div>
      } @empty {
        <div class="empty">{{ i18n.t('noPorts') }}</div>
      }
    </div>
  `,
  styleUrls: ['./panels.css'],
  styles: `
    .port { display: flex; align-items: center; gap: 10px; background: var(--s-5); border-radius: var(--radius-row); padding: 8px 10px; box-shadow: var(--hairline-card); font-size: 11px; color: var(--w-90); }
    .proto { color: var(--w-45); text-transform: uppercase; }
    .proc { flex: 1; color: var(--w-70); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `,
  host: { '[class.dim]': 'dim()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PortsPanelComponent {
  readonly rows = input.required<PortRow[]>();
  readonly dim = input(false);
  readonly i18n = inject(I18nService);
}
