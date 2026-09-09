import { ChangeDetectionStrategy, Component, forwardRef, input, signal } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
}

let seq = 0;

/** Nedtrekksliste (6.3): samme flate som gp-input, 12 px 600 tekst, mørke `option`. ControlValueAccessor. */
@Component({
  selector: 'gp-select',
  templateUrl: './select.component.html',
  styleUrl: './select.component.css',
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => SelectComponent), multi: true }],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SelectComponent<T extends string = string> implements ControlValueAccessor {
  readonly label = input('');
  readonly error = input('');
  readonly options = input<SelectOption<T>[]>([]);
  readonly name = input('');

  readonly id = `gp-sel-${++seq}`;
  readonly value = signal<T | ''>('');
  readonly disabled = signal(false);

  private onChange: (v: T) => void = () => undefined;
  private onTouched: () => void = () => undefined;

  onSelect(e: Event): void {
    const v = (e.target as HTMLSelectElement).value as T;
    this.value.set(v);
    this.onChange(v);
  }
  blur(): void {
    this.onTouched();
  }
  writeValue(v: T | null): void {
    this.value.set(v ?? '');
  }
  registerOnChange(fn: (v: T) => void): void {
    this.onChange = fn;
  }
  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }
  setDisabledState(d: boolean): void {
    this.disabled.set(d);
  }
}
