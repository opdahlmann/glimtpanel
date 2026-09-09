import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Bakgrunnen (6.2): to aurora-sirkler uten drift og et 48 px rutenett maskert mot toppen. `pointer-events: none`. */
@Component({
  selector: 'gp-backdrop',
  template: `<div class="a1"></div><div class="a2"></div><div class="grid"></div>`,
  styles: `
    :host { position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 0; }
    .a1, .a2 { position: absolute; border-radius: 50%; opacity: .2; }
    .a1 { left: -20%; top: -30%; width: 70vmax; height: 70vmax; background: radial-gradient(closest-side, #0a84ff2e, transparent); }
    .a2 { right: -25%; top: -10%; width: 60vmax; height: 60vmax; background: radial-gradient(closest-side, #bf5af22e, transparent); }
    .grid {
      position: absolute; inset: 0;
      background-image: linear-gradient(var(--s-3) 1px, transparent 1px), linear-gradient(90deg, var(--s-3) 1px, transparent 1px);
      background-size: 48px 48px;
      -webkit-mask-image: radial-gradient(at 50% 0, #000 30%, transparent 75%);
      mask-image: radial-gradient(at 50% 0, #000 30%, transparent 75%);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BackdropComponent {}
