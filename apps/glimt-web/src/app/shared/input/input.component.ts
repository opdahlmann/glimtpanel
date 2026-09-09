import { ChangeDetectionStrategy, Component, forwardRef, input, signal } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

let seq = 0;

/**
 * Tekstfelt (6.3): `--s-5` med hårlinje `--s-8`, radius 10, `padding 12px 14px`, min. 44 px, fokus `0 0 0 2px --color-cpu`.
 * `label` over (10 px `--w-45`), `error` under (11 px `--color-crit`), `leadingIcon` viser lupe. ControlValueAccessor.
 */
@Component({
  selector: 'gp-input',
  templateUrl: './input.component.html',
  styleUrl: './input.component.css',
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => InputComponent), multi: true }],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InputComponent implements ControlValueAccessor {
  readonly label = input('');
  readonly error = input('');
  readonly leadingIcon = input(false);
  readonly type = input('text');
  readonly placeholder = input('');
  readonly autocomplete = input('');
  readonly name = input('');
  readonly mono = input(false);
  readonly size = input<'md' | 'sm'>('md');

  readonly id = `gp-in-${++seq}`;
  readonly value = signal('');
  readonly disabled = signal(false);

  private onChange: (v: string) => void = () => undefined;
  private onTouched: () => void = () => undefined;

  onInput(e: Event): void {
    const v = (e.target as HTMLInputElement).value;
    this.value.set(v);
    this.onChange(v);
  }
  blur(): void {
    this.onTouched();
  }
  writeValue(v: string | null): void {
    this.value.set(v ?? '');
  }
  registerOnChange(fn: (v: string) => void): void {
    this.onChange = fn;
  }
  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }
  setDisabledState(d: boolean): void {
    this.disabled.set(d);
  }
}
