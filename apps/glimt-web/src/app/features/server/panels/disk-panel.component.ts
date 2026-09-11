import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { I18nService } from '@core/i18n.service';
import { BadgeComponent } from '@shared/badge/badge.component';
import { RowComponent } from '@shared/row/row.component';
import { DiskView } from '../server-view';

/** Diskpanelet (steg 5.5): én rad per montering, fulleste først, med terskelstolpe, fot og inode-linje. */
@Component({
  selector: 'gp-disk-panel',
  imports: [RowComponent, BadgeComponent],
  template: `
    <div class="rows data">
      @for (m of view().mounts; track m.path) {
        <gp-row [attr.data-mount]="m.path">
          <span leading class="icon" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="8" width="18" height="8" rx="2" /><path d="M17 12h.01" /></svg></span>
          <span class="name">{{ m.path }}</span>
          <gp-badge>{{ m.fs }}</gp-badge>
          <span trailing class="strong num">{{ m.free }} <span class="unit">{{ i18n.t('free') }}</span></span>
          <div footer class="detail">
            <div class="track"><div class="fill" [style.width.%]="m.pct" [style.background]="m.color"></div></div>
            <div class="line num"><span>{{ m.foot }}</span><span>{{ m.pct }}%</span></div>
            <div class="inodes num">
              <span class="ilabel">{{ i18n.t('inodes') }} {{ m.inodePct === null ? '—' : m.inodePct + '%' }}</span>
              <div class="itrack"><div class="ifill" [style.width.%]="m.inodePct ?? 0" [style.background]="m.inodeColor"></div></div>
              <span class="io">{{ m.io }}</span>
            </div>
          </div>
        </gp-row>
      } @empty {
        <div class="empty">—</div>
      }
    </div>
  `,
  styleUrls: ['./panels.css'],
  styles: `
    .icon { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 5px; background: var(--s-8); color: var(--w-55); flex: none; }
    .detail { display: flex; flex-direction: column; gap: 5px; width: 100%; }
    .track { height: 5px; border-radius: 3px; background: var(--s-10); overflow: hidden; }
    .fill { height: 100%; border-radius: 3px; transition: width var(--t-data); }
    .line { display: flex; justify-content: space-between; font-size: 10px; color: var(--w-45); }
    .inodes { display: flex; align-items: center; gap: 8px; font-size: 10px; color: var(--w-45); }
    .ilabel { min-width: 60px; }
    .itrack { flex: 1; height: 3px; border-radius: 3px; background: var(--s-8); overflow: hidden; }
    .ifill { height: 100%; border-radius: 3px; }
    .io { white-space: nowrap; }
  `,
  host: { '[class.dim]': 'dim()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DiskPanelComponent {
  readonly view = input.required<DiskView>();
  readonly dim = input(false);
  readonly i18n = inject(I18nService);
}
