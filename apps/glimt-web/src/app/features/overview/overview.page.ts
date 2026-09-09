import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, Signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { I18nService } from '@core/i18n.service';
import { LiveService } from '@core/live.service';
import { LastHour, LiveStore } from '@core/live.store';
import { CardDto } from '@core/live.types';
import { TPipe } from '@core/t.pipe';
import { LiveDotComponent } from '@shared/live-dot/live-dot.component';
import { RowComponent } from '@shared/row/row.component';
import { SparklineComponent } from '@shared/sparkline/sparkline.component';
import { TitleService } from '../../shell/title.service';

/**
 * Midlertidig oversikt (steg 3.4 «en midlertidig side viser live-tall»): én `gp-row` per kort fra LiveStore med
 * statusprikk, cpu/mem/disk og sparkline fra siste time. Serverkortet og verktøylinjen kommer i fase 4.
 */
@Component({
  selector: 'gp-overview-page',
  imports: [RouterLink, RowComponent, LiveDotComponent, SparklineComponent, TPipe],
  templateUrl: './overview.page.html',
  styleUrl: './overview.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OverviewPage {
  private readonly live = inject(LiveService);
  private readonly store = inject(LiveStore);
  private readonly i18n = inject(I18nService);

  readonly state = this.live.state;
  readonly cards = this.store.cards;
  readonly upCount = computed(() => this.cards().filter((c) => c.status === 'up').length);
  readonly downCount = computed(() => this.cards().filter((c) => c.status === 'down').length);
  readonly pausedCount = computed(() => this.cards().filter((c) => c.status === 'paused').length);

  constructor() {
    inject(TitleService).setKey('servers');
    const unsubscribe = this.live.subscribeOverview();
    inject(DestroyRef).onDestroy(unsubscribe);
  }

  lastHour(id: string): Signal<LastHour> {
    return this.store.lastHour(id);
  }

  dot(c: CardDto): 'up' | 'down' | 'paused' {
    return c.status === 'up' ? 'up' : c.status === 'paused' ? 'paused' : 'down';
  }

  statusText(c: CardDto): string {
    if (c.status === 'up') return this.i18n.t('liveLabel');
    if (c.status === 'paused') return this.i18n.t('paused');
    return c.lastSeenAt ? `${this.i18n.t('lastSeen')} ${this.i18n.formatWhen(Date.parse(c.lastSeenAt))}` : this.i18n.t('down');
  }

  pct(v: number | null | undefined): string {
    return v === null || v === undefined ? '—' : `${Math.round(v)}%`;
  }
}
