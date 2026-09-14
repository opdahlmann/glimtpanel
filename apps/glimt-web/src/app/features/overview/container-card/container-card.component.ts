import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, ElementRef, inject, input, linkedSignal, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { I18nService } from '@core/i18n.service';
import { LastHour, LiveStore } from '@core/live.store';
import { CardDto } from '@core/live.types';
import { PrefsService } from '@core/prefs.service';
import { TPipe } from '@core/t.pipe';
import { BadgeComponent } from '@shared/badge/badge.component';
import { ChipComponent } from '@shared/chip/chip.component';
import { LiveDotComponent } from '@shared/live-dot/live-dot.component';
import { RingComponent } from '@shared/ring/ring.component';
import { SparklineComponent } from '@shared/sparkline/sparkline.component';
import { containerCardView } from './container-card-view';

interface Frame {
  card: CardDto | null;
  hour: LastHour;
}

/**
 * Containerkortet (steg 12.8, skjerm 20): samme `article`-ramme som serverkortet (glass, stripe, tittelrad med
 * tagger, navn og status), infolinje «container · nginx:1.27 · up 3d 4h · on web-02», to ringer (CPU mot tildelte
 * kjerner, minne mot grensen), fire chips (Net, Restarts, Health, Ports) og to sparklines. Sovende: nøytral prikk,
 * «sleeping since 14:02», ringer på 0, opasitet .6. Uten cgroup: «≈» foran tallene.
 */
@Component({
  selector: 'gp-container-card',
  imports: [RingComponent, ChipComponent, BadgeComponent, LiveDotComponent, SparklineComponent, TPipe],
  templateUrl: './container-card.component.html',
  styleUrls: ['../server-card/server-card.component.css', './container-card.component.css'],
  host: {
    tabindex: '0',
    '[class.dim]': 'view()?.dimmed',
    '[attr.aria-label]': 'view()?.ariaLabel',
    '[attr.data-status]': 'view()?.status',
    '[attr.data-kind]': '"container"',
    '(keydown.enter)': 'open()',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContainerCardComponent {
  readonly id = input.required<string>();

  private readonly store = inject(LiveStore);
  private readonly i18n = inject(I18nService);
  private readonly router = inject(Router);
  private readonly prefs = inject(PrefsService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly visible = signal(true);
  readonly sparklines = this.prefs.sparklines.value;

  private readonly source = computed<Frame>(() => ({ card: this.store.card(this.id())(), hour: this.store.lastHour(this.id())() }));

  /** Som serverkortet: fryses utenfor skjermen. */
  readonly frame = linkedSignal<{ frame: Frame; visible: boolean }, Frame>({
    source: () => ({ frame: this.source(), visible: this.visible() }),
    computation: (src, prev) => (src.visible || !prev ? src.frame : prev.value),
  });

  readonly view = computed(() => {
    const card = this.frame().card;
    return card ? containerCardView(card, this.i18n) : null;
  });
  readonly hour = computed(() => this.frame().hour);
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

  openPanel(panel: 'cpu' | 'mem'): void {
    void this.router.navigate(['/servers', this.id()], { fragment: panel });
  }
}
