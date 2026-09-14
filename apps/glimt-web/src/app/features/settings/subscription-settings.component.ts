import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ApiService } from '@core/api.service';
import { SubscriptionDto } from '@core/live.types';
import { SessionService } from '@core/session.service';
import { TPipe } from '@core/t.pipe';
import { ChipComponent } from '@shared/chip/chip.component';

/**
 * Innstillinger › Abonnement (steg 8.5, skjerm 13): grønt kort «Free in beta» med tre chips fra `GET /api/subscription`
 * (plasser teller noder av begge typer), og kortet «What it would cost today» med rabattert pris stort, full pris
 * gjennomstreket, «per year», rabattlinje bare for tidlig-kontoer og «14 × 12 USD · 60 days notice …». Ingen betaling i MVP.
 */
@Component({
  selector: 'gp-subscription-settings',
  imports: [TPipe, ChipComponent],
  template: `
    @if (sub(); as s) {
      <div class="grid">
        <section class="card ok" aria-labelledby="beta-title" data-testid="beta-card">
          <h2 id="beta-title" class="section">{{ 'beta' | t }}</h2>
          <p class="note">{{ 'betaSub' | t }}</p>
          <div class="chips">
            <gp-chip [label]="('slots' | t) + ' ' + ('slotsUsed' | t)" [value]="s.slotsUsed" />
            <gp-chip [label]="'slotsFree' | t" [value]="s.slotsFree" />
            <gp-chip [label]="'slotsBeta' | t" [value]="s.slotsBeta" />
          </div>
          <p class="note num">{{ s.slotsUsed }} {{ 'slots' | t }} {{ 'slotsUsed' | t }} · {{ s.slotsFree }} {{ 'slotsFree' | t }} · {{ s.slotsBeta }} {{ 'slotsBeta' | t }} · {{ 'perNode' | t }}</p>
        </section>
        <section class="card" aria-labelledby="cost-title" data-testid="cost-card">
          <h2 id="cost-title" class="section">{{ 'whatItWouldCost' | t }}</h2>
          <div class="row">
            <span class="big num" data-testid="cost">{{ s.wouldCostWithDiscountUsd }} USD</span>
            @if (s.discountPct > 0) {
              <span class="strike num">{{ s.wouldCostUsd }} USD</span>
            }
            <span class="note">{{ 'perYear' | t }}</span>
          </div>
          @if (s.discountPct > 0) {
            <p class="note">{{ 'discount' | t }}</p>
          }
          <p class="note num">{{ s.slotsBeta }} × {{ s.plannedPricePerSlotUsd }} USD · {{ s.noticeDays }} {{ 'noticeDays' | t }}</p>
          <p class="note faint">{{ 'paymentLater' | t }}</p>
        </section>
      </div>
    } @else if (error()) {
      <p class="muted">{{ 'errorGeneric' | t }}</p>
    } @else {
      <p class="muted">{{ 'loading' | t }}</p>
    }
  `,
  styleUrl: './settings.css',
  styles: `.faint { color: var(--w-45); }`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SubscriptionSettingsComponent {
  private readonly api = inject(ApiService);
  private readonly session = inject(SessionService);

  readonly sub = signal<SubscriptionDto | null>(null);
  readonly error = signal(false);
  readonly earlyAdopter = computed(() => this.session.user()?.earlyAdopter ?? false);

  constructor() {
    void this.api
      .get<SubscriptionDto>('/subscription')
      .then((s) => this.sub.set(s))
      .catch(() => this.error.set(true));
  }
}
