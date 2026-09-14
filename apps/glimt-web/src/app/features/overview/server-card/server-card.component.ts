import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, ElementRef, inject, input, linkedSignal, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { I18nService } from '@core/i18n.service';
import { LastHour, LiveStore } from '@core/live.store';
import { CardDto } from '@core/live.types';
import { PrefsService } from '@core/prefs.service';
import { ServerListService } from '@core/server-list.service';
import { TPipe } from '@core/t.pipe';
import { BadgeComponent } from '@shared/badge/badge.component';
import { ChipComponent } from '@shared/chip/chip.component';
import { LiveDotComponent } from '@shared/live-dot/live-dot.component';
import { RingComponent } from '@shared/ring/ring.component';
import { SparklineComponent } from '@shared/sparkline/sparkline.component';
import { NodeMenuComponent } from '../node-menu/node-menu.component';
import { cardView } from './card-view';

export type CardPanel = 'cpu' | 'mem' | 'disk';

interface Frame {
  card: CardDto | null;
  hour: LastHour;
}

/**
 * Serverkortet (steg 4.2, skjerm 4 og 16): `article` med glass, 3 px varselstripe, tittelrad `1fr auto 1fr`
 * (tagger, navn, status + prikk), infolinje, tre ringer (knapper til `/servers/:id#cpu|mem|disk`), fem chips og
 * to sparklines. Matet av `LiveStore.card(id)`; utenfor skjermen (IntersectionObserver) fryses det som tegnes,
 * mens signalene i lageret lever videre. Nede: ringer på 0, opasitet .6, rød prikk. Pauset: nøytral prikk, opasitet .6.
 */
@Component({
  selector: 'gp-server-card',
  imports: [RingComponent, ChipComponent, BadgeComponent, LiveDotComponent, SparklineComponent, NodeMenuComponent, TPipe],
  templateUrl: './server-card.component.html',
  styleUrl: './server-card.component.css',
  host: {
    tabindex: '0',
    '[class.dim]': 'view()?.dimmed',
    '[attr.aria-label]': 'view()?.ariaLabel',
    '[attr.data-status]': 'view()?.status',
    '(keydown.enter)': 'onEnter($event)',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ServerCardComponent {
  readonly id = input.required<string>();

  private readonly store = inject(LiveStore);
  private readonly i18n = inject(I18nService);
  private readonly router = inject(Router);
  private readonly prefs = inject(PrefsService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly serverList = inject(ServerListService);
  /** Leseren ser hvem som eier serveren (steg 8.4). */
  readonly sharedBy = computed(() => this.serverList.byId().get(this.id())?.ownerEmail ?? null);

  /** Synlig i viewport (IntersectionObserver). Uten observer (jsdom) alltid synlig. */
  readonly visible = signal(true);
  readonly sparklines = this.prefs.sparklines.value;

  private readonly source = computed<Frame>(() => ({ card: this.store.card(this.id())(), hour: this.store.lastHour(this.id())() }));

  /** Det som tegnes: følger lageret mens kortet er synlig, ellers beholdes siste tegnede ramme. */
  readonly frame = linkedSignal<{ frame: Frame; visible: boolean }, Frame>({
    source: () => ({ frame: this.source(), visible: this.visible() }),
    computation: (src, prev) => (src.visible || !prev ? src.frame : prev.value),
  });

  readonly view = computed(() => {
    const card = this.frame().card;
    return card ? cardView(card, this.i18n) : null;
  });
  readonly hour = computed(() => this.frame().hour);

  /** Bytter for hver tegnede ramme, så prikken kan dimme kort ved ny data. */
  readonly pulse = signal(false);

  constructor() {
    effect(() => {
      this.frame();
      untracked(() => this.pulse.update((v) => !v));
    });
    if (typeof IntersectionObserver === 'function') {
      const io = new IntersectionObserver((entries) => this.visible.set(entries.some((e) => e.isIntersecting)), { rootMargin: '120px 0px' });
      io.observe(this.host.nativeElement);
      inject(DestroyRef).onDestroy(() => io.disconnect());
    }
  }

  open(): void {
    void this.router.navigate(['/servers', this.id()]);
  }

  /** Enter på selve kortet åpner serveren; Enter inne i ⋯-menyen (dialogen) gjør ikke det. */
  onEnter(e: Event): void {
    if ((e.target as HTMLElement | null)?.closest('gp-node-menu')) return;
    this.open();
  }

  openPanel(panel: CardPanel): void {
    void this.router.navigate(['/servers', this.id()], { fragment: panel });
  }
}
