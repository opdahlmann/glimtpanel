import { ChangeDetectionStrategy, Component, input, model } from '@angular/core';

/** Bryter 38×20 (6.3): spor grønn når på, `--s-14` når av, knott 16 px hvit, overgang .2s. Treffflate minst 44 px. */
@Component({
  selector: 'gp-toggle',
  template: `
    <button
      type="button"
      role="switch"
      class="btn"
      [attr.aria-checked]="checked()"
      [attr.aria-label]="label() || srLabel() || null"
      [attr.aria-describedby]="describedBy() || null"
      [disabled]="disabled()"
      (click)="checked.set(!checked())"
    >
      <span class="track" [class.on]="checked()" aria-hidden="true"><span class="knob"></span></span>
      @if (label()) {
        <span class="text">{{ label() }}</span>
      }
    </button>
  `,
  styles: `
    :host { display: inline-flex; }
    .btn {
      display: inline-flex; align-items: center; gap: 8px; min-height: 44px; min-width: 44px; padding: 0 4px;
      background: transparent; border: 0; color: var(--w-85); font-size: 12px; font-weight: 600; cursor: pointer;
    }
    .btn:disabled { opacity: .5; cursor: default; }
    .track { position: relative; flex: none; width: 38px; height: 20px; border-radius: var(--radius-pill); background: var(--s-14); transition: background var(--t-segment); }
    .track.on { background: var(--color-ram); }
    .knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--w-100); transition: left var(--t-segment); }
    .track.on .knob { left: 20px; }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToggleComponent {
  readonly checked = model(false);
  readonly label = input('');
  /** Navn for skjermleser uten synlig tekst (steg 9.3). */
  readonly srLabel = input('');
  readonly describedBy = input('');
  readonly disabled = input(false);
}
