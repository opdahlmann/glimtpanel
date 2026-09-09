import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ToastHostComponent } from '@shared/toast/toast-host.component';
import { BreakpointService } from '@shared/util/breakpoint.service';
import { BackdropComponent } from './backdrop.component';

/** Skallet for auth-sidene (6.2): bakgrunn, sentrert innhold, ingen navigasjon, toast. */
@Component({
  selector: 'gp-auth-shell',
  imports: [RouterOutlet, BackdropComponent, ToastHostComponent],
  template: `
    <gp-backdrop />
    <main>
      <router-outlet />
    </main>
    <gp-toast-host />
  `,
  styles: `
    :host { display: flex; flex-direction: column; min-height: 100dvh; position: relative; }
    main { flex: 1; z-index: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px 28px 40px; }
    :host(.mobile) main { padding: 12px 12px 24px; }
  `,
  host: { '[class.mobile]': 'isMobile()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuthShellComponent {
  readonly isMobile = inject(BreakpointService).isMobile;
}
