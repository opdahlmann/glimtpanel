import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';

export type PanelTone = 'cpu' | 'ram' | 'disk' | 'net' | 'swap' | 'warn' | 'crit' | 'neutral';

let seq = 0;

/**
 * Panel på serversiden (6.3): tonet bakgrunn `<farge>14` med hårlinje `<farge>40` (nøytral: `--s-5`/`--s-8`), radius 10,
 * `padding 10px 12px 12px`. Hodet er en knapp i full bredde (32 px) med `aria-expanded`/`aria-controls`. Innholdet glir inn med `pdIn`.
 */
@Component({
  selector: 'gp-panel',
  templateUrl: './panel.component.html',
  styleUrl: './panel.component.css',
  host: {
    '[class]': '"tone-" + tone()',
    '[attr.id]': 'panelId() || null',
    '[style.--panel-color]': 'toneColor()',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PanelComponent {
  readonly title = input('');
  readonly meta = input('');
  readonly tone = input<PanelTone>('neutral');
  readonly open = model(true);
  readonly panelId = input('');

  private readonly seq = ++seq;
  readonly bodyId = computed(() => `${this.panelId() || 'gp-panel-' + this.seq}-body`);
  readonly toneColor = computed(() => (this.tone() === 'neutral' ? null : `var(--color-${this.tone()})`));

  toggle(): void {
    this.open.set(!this.open());
  }
}
