import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { Router } from '@angular/router';
import { I18nService } from '@core/i18n.service';
import { BadgeComponent } from '@shared/badge/badge.component';
import { ButtonComponent } from '@shared/button/button.component';
import { LiveDotComponent } from '@shared/live-dot/live-dot.component';
import { RowComponent } from '@shared/row/row.component';
import { ServicesView, ServiceView } from '../server-view';

/** Tjenestepanelet (steg 5.9): feilede først med «View log» → /logs, «needs restart»-badge, «Show all» over 200. */
@Component({
  selector: 'gp-svc-panel',
  imports: [RowComponent, BadgeComponent, ButtonComponent, LiveDotComponent],
  template: `
    <div class="rows-tight data">
      @for (s of view().rows; track s.name) {
        <gp-row [attr.data-service]="s.name" [attr.data-state]="s.state">
          <gp-live-dot leading [state]="s.dot" />
          <span class="name svc">{{ s.name }}</span>
          @if (s.needsRestart) {
            <gp-badge tone="warn">{{ i18n.t('needsRestart') }}</gp-badge>
          }
          <span class="status" [class.crit]="s.state === 'failed'" [class.ok]="s.state === 'running'">{{ s.status }}</span>
          @if (s.state === 'failed') {
            <gp-button trailing variant="danger" size="sm" (click)="viewLog(s)">{{ i18n.t('viewLog') }}</gp-button>
          }
        </gp-row>
      } @empty {
        <div class="empty">—</div>
      }
      @if (view().hidden > 0) {
        <gp-button variant="ghost" size="sm" class="more" (click)="showAll.emit()">{{ i18n.t('showAll') }} · {{ view().hidden }}</gp-button>
      }
    </div>
  `,
  styleUrls: ['./panels.css'],
  styles: `
    .svc { flex: 1; min-width: 120px; }
    .status { font-size: 10px; color: var(--w-45); }
    .status.ok { color: var(--color-ram); }
    .more { align-self: flex-start; }
  `,
  host: { '[class.dim]': 'dim()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SvcPanelComponent {
  readonly view = input.required<ServicesView>();
  readonly serverId = input.required<string>();
  readonly dim = input(false);
  readonly showAll = output<void>();
  readonly i18n = inject(I18nService);
  private readonly router = inject(Router);

  viewLog(s: ServiceView): void {
    void this.router.navigate(['/logs'], { queryParams: { server: this.serverId(), source: 'journal', unit: s.name } });
  }
}
