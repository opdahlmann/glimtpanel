import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { clamp, metricColor, withAlpha } from '../util/thr';

/** Prototypens `sparkPath(arr, w=100, h=24)`: `M x,y L …` med y = h − (v/max)·(h−2) − 1. */
export function sparkPath(values: number[], w = 100, h = 24, max = 100): string {
  const n = values.length;
  if (n < 2) return '';
  return values
    .map((v, i) => `${i ? 'L' : 'M'}${((i / (n - 1)) * w).toFixed(1)},${(h - (clamp(v, 0, max) / max) * (h - 2) - 1).toFixed(1)}`)
    .join(' ');
}

/** Sparkline (6.3): `viewBox 0 0 100 h`, `preserveAspectRatio none`, strek 1,5 px i fargen med 60 % alfa, ingen akser. */
@Component({
  selector: 'gp-sparkline',
  template: `
    <svg [attr.viewBox]="'0 0 100 ' + height()" preserveAspectRatio="none" [style.height.px]="height()" aria-hidden="true">
      <path [attr.d]="path()" fill="none" [attr.stroke]="stroke()" stroke-width="1.5" vector-effect="non-scaling-stroke" />
    </svg>
  `,
  styles: `:host { display: block; min-width: 0; } svg { display: block; width: 100%; }`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SparklineComponent {
  readonly values = input<number[]>([]);
  readonly color = input<string>('cpu');
  readonly height = input(24);
  readonly max = input(100);

  readonly path = computed(() => sparkPath(this.values(), 100, this.height(), this.max()));
  readonly stroke = computed(() => withAlpha(metricColor(this.color()), '99', 60));
}
