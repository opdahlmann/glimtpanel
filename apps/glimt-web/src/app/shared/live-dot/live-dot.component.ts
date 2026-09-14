import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';

export type LiveState = 'up' | 'down' | 'paused' | 'connecting';

/** 6 px prikk: grønn tilkoblet, rød nede, nøytral pauset, oransje kobler til. Dimmes til .35 i 180 ms når `pulse` endres (ikke ved redusert bevegelse). */
@Component({
  selector: 'gp-live-dot',
  template: `<span class="dot" [class]="'dot ' + state()" [class.dim]="dim()" [attr.role]="label() ? 'img' : null" [attr.aria-label]="label() || null" [attr.aria-hidden]="label() ? null : true"></span>`,
  styles: `
    :host { display: inline-flex; align-items: center; justify-content: center; width: 6px; height: 6px; }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--color-neutral); transition: opacity 180ms; }
    .up { background: var(--color-ram); }
    .down { background: var(--color-crit); }
    .paused { background: var(--color-neutral); }
    .connecting { background: var(--color-warn); animation: blink 1.2s infinite; }
    .dim { opacity: .35; }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LiveDotComponent {
  readonly state = input<LiveState>('up');
  readonly pulse = input(false);
  /** Tekst for skjermleser der prikken står uten statusord ved siden av (steg 9.3); ellers dekor. */
  readonly label = input('');
  readonly dim = signal(false);

  private timer: ReturnType<typeof setTimeout> | null = null;
  private first = true;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.clear());
    effect(() => {
      this.pulse();
      if (this.first) {
        this.first = false;
        return;
      }
      if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      untracked(() => {
        this.clear();
        this.dim.set(true);
        this.timer = setTimeout(() => this.dim.set(false), 180);
      });
    });
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
