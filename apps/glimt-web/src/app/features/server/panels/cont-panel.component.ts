import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { Router } from '@angular/router';
import { ConfigService } from '@core/config.service';
import { I18nService } from '@core/i18n.service';
import { BadgeComponent } from '@shared/badge/badge.component';
import { LiveDotComponent } from '@shared/live-dot/live-dot.component';
import { RowComponent } from '@shared/row/row.component';
import { ContainersView, ContainerView } from '../server-view';

/**
 * Containerpanelet (steg 5.8): rad per container med prikk, navn, image-badge, «running · 3d 4h», CPU og minne mot
 * grense, stolpe, fot med restarts / image age / net / health. Restarting og stopped først. Klikk åpner containersiden.
 * Uten Docker-tilgang: «Docker not available on this server · how to enable».
 */
@Component({
  selector: 'gp-cont-panel',
  imports: [RowComponent, BadgeComponent, LiveDotComponent],
  template: `
    @if (!view().available) {
      <div class="empty">{{ i18n.t('dockerNotAvailable') }} · <a [href]="docsUrl()" target="_blank" rel="noopener">{{ i18n.t('howToEnable') }}</a></div>
    } @else {
      <div class="rows data">
        @for (c of view().rows; track c.id) {
          <gp-row [interactive]="true" (pressed)="open(c)" [attr.data-container]="c.name" [attr.data-state]="c.state">
            <gp-live-dot leading [state]="c.dot" />
            <span class="name">{{ c.name }}</span>
            <gp-badge class="image">{{ c.image }}</gp-badge>
            @if (c.nodeId) {
              <gp-badge class="node" tone="ok">{{ i18n.t('asNode') }}</gp-badge>
            }
            <span class="sub">{{ c.status }}</span>
            <span trailing class="strong num nums">{{ c.cpu }} <span class="unit">CPU</span> · {{ c.mem }} <span class="unit">{{ c.limit }}</span></span>
            <div footer class="detail">
              <div class="track"><div class="fill" [style.width.%]="c.memPct" [style.background]="c.memColor"></div></div>
              <div class="foot num">
                <span>{{ i18n.t('restarts') }} <b [class.warn]="c.restartsTone === 'warn'">{{ c.restarts }}</b></span>
                <span>{{ i18n.t('imageAge') }} <b [class.warn]="c.ageTone === 'warn'">{{ c.age }}</b></span>
                <span>{{ i18n.t('net') }} <b>{{ c.net }}</b></span>
                <span>{{ i18n.t('health') }} <b>{{ c.health }}</b></span>
              </div>
            </div>
          </gp-row>
        } @empty {
          <div class="empty">{{ i18n.t('noContainers') }}</div>
        }
      </div>
    }
  `,
  styleUrls: ['./panels.css'],
  styles: `
    .image { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
    /* «node»-badgen (steg 12.8): containeren er en egen node; lenken til den står på containersiden (ingen lenke i en klikkbar rad, 9.3). */
    .node { flex: none; }
    /* Mobil: toppraden bryter, tallene på egen linje (6.4). */
    @media (max-width: 759.98px) { .nums { flex-basis: 100%; } }
    .detail { display: flex; flex-direction: column; gap: 6px; width: 100%; }
    .track { height: 5px; border-radius: 3px; background: var(--s-10); overflow: hidden; }
    .fill { height: 100%; border-radius: 3px; transition: width var(--t-data); }
    /* Berøring: lenken får 44 px treffflate uten å flytte teksten. */
    @media (pointer: coarse) { .empty a { display: inline-flex; align-items: center; min-height: 44px; margin: -14px 0; padding: 0 2px; } }
  `,
  host: { '[class.dim]': 'dim()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContPanelComponent {
  readonly view = input.required<ContainersView>();
  readonly serverId = input.required<string>();
  readonly dim = input(false);
  readonly i18n = inject(I18nService);
  private readonly router = inject(Router);
  private readonly config = inject(ConfigService);

  docsUrl(): string {
    return this.config.config().docsUrl;
  }

  open(c: ContainerView): void {
    void this.router.navigate(['/servers', this.serverId(), 'containers', c.id]);
  }
}
