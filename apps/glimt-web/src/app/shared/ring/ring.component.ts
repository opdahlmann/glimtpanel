import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { clamp, metricColor, thr } from '../util/thr';

/** Omkretsen til r=32: 2π·32. Prototypen: `dash = p => `${(p/100*201.06).toFixed(1)} 201.06``. */
export const RING_CIRC = 201.06;

export function ringDash(value: number): string {
  return `${((clamp(value, 0, 100) / 100) * RING_CIRC).toFixed(1)} ${RING_CIRC}`;
}

/**
 * Ringkort fra serverkortet (IMPLEMENTERINGSPLAN 6.3): SVG 76×76, r=32, strek 6, rotert −90°.
 * Rendres som en knapp (min. 44 px) med hover `--s-9`.
 */
@Component({
  selector: 'gp-ring',
  templateUrl: './ring.component.html',
  styleUrl: './ring.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RingComponent {
  readonly value = input(0);
  readonly color = input<string>('cpu');
  readonly label = input('');
  readonly sub = input('');
  readonly unit = input('%');
  readonly threshold = input(true);
  readonly pressed = output<void>();

  readonly dash = computed(() => ringDash(this.value()));
  readonly shown = computed(() => Math.round(clamp(this.value(), 0, 100)));
  readonly stroke = computed(() => {
    const base = metricColor(this.color());
    return this.threshold() ? thr(this.value(), base) : base;
  });
  readonly ariaLabel = computed(() => {
    const unit = this.unit() === '%' ? 'percent' : this.unit();
    const sub = this.sub();
    return `${this.label()} ${this.shown()} ${unit}${sub ? `, ${sub}` : ''}`;
  });
}
