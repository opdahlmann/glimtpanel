import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, model } from '@angular/core';

export interface SegmentOption<T extends string = string> {
  value: T;
  label: string;
}

let seq = 0;

/**
 * Segmentkontroll (6.3): pille `--s-6` med 1 px kant `--s-8`, `padding 3px`, valgt hvit bakgrunn med `--color-ink` tekst.
 * `role="radiogroup"` med piltaster. `scroll` ruller horisontalt på mobil, `full` strekker knappene.
 */
@Component({
  selector: 'gp-segment',
  templateUrl: './segment.component.html',
  styleUrl: './segment.component.css',
  host: {
    '[class.sm]': 'size() === "sm"',
    '[class.scroll]': 'scroll()',
    '[class.full]': 'full()',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SegmentComponent<T extends string = string> {
  readonly options = input<SegmentOption<T>[]>([]);
  readonly value = model<T | null>(null);
  readonly size = input<'sm' | 'md'>('md');
  readonly scroll = input(false);
  readonly full = input(false);
  readonly label = input('');

  readonly id = `gp-seg-${++seq}`;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly selectedIndex = computed(() => {
    const i = this.options().findIndex((o) => o.value === this.value());
    return i < 0 ? 0 : i;
  });

  select(v: T): void {
    this.value.set(v);
  }

  onKeydown(e: KeyboardEvent, index: number): void {
    const n = this.options().length;
    if (n === 0) return;
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % n;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (index - 1 + n) % n;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    if (next === null) return;
    e.preventDefault();
    this.select(this.options()[next].value);
    const btn = this.host.nativeElement.querySelectorAll<HTMLButtonElement>('button')[next];
    btn?.focus();
  }
}
