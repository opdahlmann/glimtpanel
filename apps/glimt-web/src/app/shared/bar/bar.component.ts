import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { clamp, metricColor, thr } from '../util/thr';

export interface BarSegment {
  value: number;
  color: string;
}

/**
 * Diskstolpe (5 px), segmentert minnestolpe (8 px, 1 px gap), inode-stolpe (3 px) (6.3).
 * Spor `--s-10` (5 px) eller `--s-8` (8/3 px), fyll terskelfarget, overgang `width .6s`.
 */
@Component({
  selector: 'gp-bar',
  template: `
    <div class="track" [class]="'track h' + height()" role="progressbar" [attr.aria-valuenow]="valueNow()" aria-valuemin="0" aria-valuemax="100" [attr.aria-label]="label() || null">
      @if (segments(); as segs) {
        @for (s of segs; track $index) {
          <div class="seg" [style.width.%]="clamp(s.value)" [style.background]="segColor(s.color)"></div>
        }
      } @else {
        <div class="fill" [style.width.%]="clamp(value())" [style.background]="fillColor()"></div>
      }
    </div>
  `,
  styles: `
    :host { display: block; }
    .track { display: flex; gap: 1px; width: 100%; overflow: hidden; background: var(--s-8); }
    .h5 { height: 5px; border-radius: 3px; background: var(--s-10); }
    .h8 { height: 8px; border-radius: 4px; }
    .h3 { height: 3px; border-radius: 2px; }
    .fill, .seg { height: 100%; transition: width var(--t-data); }
    .fill { border-radius: inherit; }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BarComponent {
  readonly value = input(0);
  readonly color = input<string>('disk');
  readonly height = input<5 | 8 | 3>(5);
  readonly threshold = input(true);
  readonly segments = input<BarSegment[] | null>(null);
  readonly label = input('');

  readonly fillColor = computed(() => {
    const base = metricColor(this.color());
    return this.threshold() ? thr(this.value(), base) : base;
  });
  readonly valueNow = computed(() => {
    const segs = this.segments();
    return Math.round(segs ? segs.reduce((a, s) => a + s.value, 0) : clamp(this.value(), 0, 100));
  });

  clamp(v: number): number {
    return clamp(v, 0, 100);
  }
  segColor(c: string): string {
    return metricColor(c);
  }
}
