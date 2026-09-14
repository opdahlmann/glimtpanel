import { Injectable, computed, signal } from '@angular/core';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  message: string;
  /** Valgfri knapp (steg 9.5: «Reload» ved uventet feil). Toasten står lenger når den har en handling. */
  action?: ToastAction;
}

export const TOAST_MS = 2200;
export const TOAST_ACTION_MS = 8000;

/** Signal-kø for «kopiert»-meldinger. `gp-toast-host` viser den første og fjerner den etter 2,2 s. */
@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly queue = signal<Toast[]>([]);
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  readonly current = computed(() => this.queue()[0] ?? null);

  show(message: string, action?: ToastAction): void {
    this.queue.update((q) => [...q, { id: ++this.seq, message, action }]);
    this.arm();
  }

  dismiss(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue.update((q) => q.slice(1));
    this.arm();
  }

  private arm(): void {
    if (this.timer || !this.queue().length) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.dismiss();
    }, this.queue()[0]?.action ? TOAST_ACTION_MS : TOAST_MS);
  }
}
