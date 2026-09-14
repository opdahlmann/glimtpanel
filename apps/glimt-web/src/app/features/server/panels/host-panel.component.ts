import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { I18nService } from '@core/i18n.service';
import { ChipComponent } from '@shared/chip/chip.component';
import { HostView } from '../server-view';

/**
 * Verten (steg 12.9): vises bare når en vertsagent hos samme eier ser containeren (12.6): image, image-alder,
 * omstarter, tilstand og minnegrense fra Docker, og en lenke til verten.
 */
@Component({
  selector: 'gp-host-panel',
  imports: [ChipComponent, RouterLink],
  template: `
    <div class="host data">
      <a class="link" [routerLink]="['/servers', view().serverId]">{{ i18n.t('viewHost') }} · {{ view().name }}</a>
      <div class="chips-4">
        <gp-chip [label]="i18n.t('image')" [value]="view().image" />
        <gp-chip [label]="i18n.t('imageAgeShort')" [value]="view().age" />
        <gp-chip [label]="i18n.t('restarts')" [value]="view().restarts" />
        <gp-chip [label]="i18n.t('state')" [value]="view().state" />
      </div>
    </div>
  `,
  styleUrls: ['./panels.css'],
  styles: `
    .host { display: flex; flex-direction: column; gap: 10px; }
    .link { display: inline-flex; align-items: center; min-height: 44px; font-size: 12px; font-weight: 600; color: var(--color-cpu); text-decoration: none; }
    .link:hover { text-decoration: underline; }
    .chips-4 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
    @media (max-width: 759.98px) { .chips-4 { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  `,
  host: { '[class.dim]': 'dim()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HostPanelComponent {
  readonly view = input.required<HostView>();
  readonly dim = input(false);
  readonly i18n = inject(I18nService);
}
