import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { errorKey } from '@core/api.service';
import { GroupsStore } from '@core/groups.store';
import { I18nKey, I18nService } from '@core/i18n.service';
import { LiveStore } from '@core/live.store';
import { TPipe } from '@core/t.pipe';
import { BadgeComponent } from '@shared/badge/badge.component';
import { ButtonComponent } from '@shared/button/button.component';
import { ChipComponent } from '@shared/chip/chip.component';
import { InputComponent } from '@shared/input/input.component';
import { LiveDotComponent } from '@shared/live-dot/live-dot.component';
import { ModalComponent } from '@shared/modal/modal.component';
import { BreakpointService } from '@shared/util/breakpoint.service';
import { groupView } from './group-view';

/**
 * Gruppekortet (steg 13.2, skjerm 23; F3): glass, radius 14, samme bredde som serverkortet. Navn, «4 nodes · 3 up ·
 * 1 sleeping», verste status som prikk og stripe, tre summer som chips (CPU, Memory, Alerts) og én kompakt medlemsrad
 * per node som lenker til noden. ⋯-menyen har Rename, Delete (bekreftelse) og «Show as cards» (Cards med
 * `?group=id`). Piltaster opp/ned flytter gruppen (lagres med PATCH av siden). Alt regnes fra `Card`-ene i lageret.
 */
@Component({
  selector: 'gp-group-card',
  imports: [ChipComponent, BadgeComponent, LiveDotComponent, ModalComponent, InputComponent, ButtonComponent, FormsModule, TPipe],
  templateUrl: './group-card.component.html',
  styleUrl: './group-card.component.css',
  host: {
    tabindex: '0',
    '[class.dim]': 'view().dimmed',
    '[attr.aria-label]': 'view().ariaLabel',
    '[attr.data-status]': 'view().worst',
    '[attr.data-group]': 'view().name',
    '(keydown.arrowUp)': 'onMove($event, -1)',
    '(keydown.arrowDown)': 'onMove($event, 1)',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GroupCardComponent {
  readonly id = input.required<string>();
  /** Opp (-1) eller ned (+1); siden lagrer rekkefølgen. */
  readonly move = output<-1 | 1>();
  /** «Show as cards»: siden bytter visning og setter filteret. */
  readonly showAsCards = output<string>();

  private readonly store = inject(GroupsStore);
  private readonly live = inject(LiveStore);
  private readonly i18n = inject(I18nService);
  private readonly router = inject(Router);
  readonly isMobile = inject(BreakpointService).isMobile;

  readonly group = computed(() => this.store.byId().get(this.id()) ?? { id: this.id(), name: '', memberIds: [], order: 0, createdAt: '' });
  private readonly cardsById = computed(() => new Map(this.live.cards().map((c) => [c.id, c])));
  readonly view = computed(() => groupView(this.group(), this.cardsById(), this.i18n));
  readonly readOnly = this.store.readOnly;

  readonly menuOpen = signal(false);
  readonly renaming = signal(false);
  readonly confirming = signal(false);
  readonly newName = signal('');
  readonly busy = signal(false);
  readonly error = signal<I18nKey | null>(null);

  openNode(id: string): void {
    void this.router.navigate(['/servers', id]);
  }

  toggleMenu(e: Event): void {
    e.stopPropagation();
    this.renaming.set(false);
    this.confirming.set(false);
    this.error.set(null);
    this.menuOpen.update((v) => !v);
  }

  onMove(e: Event, dir: -1 | 1): void {
    if (this.menuOpen()) return;
    e.preventDefault();
    this.move.emit(dir);
  }

  startRename(): void {
    this.newName.set(this.group().name);
    this.renaming.set(true);
  }

  async rename(): Promise<void> {
    const name = this.newName().trim();
    if (!name || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.store.rename(this.id(), name);
      this.renaming.set(false);
      this.menuOpen.set(false);
    } catch (err) {
      this.error.set(errorKey(err));
    } finally {
      this.busy.set(false);
    }
  }

  async remove(): Promise<void> {
    if (!this.confirming()) {
      this.confirming.set(true);
      return;
    }
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.store.remove(this.id());
      this.menuOpen.set(false);
    } catch (err) {
      this.error.set(errorKey(err));
      this.busy.set(false);
    }
  }

  cards(): void {
    this.menuOpen.set(false);
    this.showAsCards.emit(this.id());
  }
}
