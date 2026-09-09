import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { I18nKey, I18nService } from '@core/i18n.service';

/**
 * Sidetittelen i topplinjen på mobil (og `document.title`). Sidene setter en ordboksnøkkel (`servers`) eller en
 * fri tekst (servernavnet på serversiden). Nøkler følger språkbytte.
 */
@Injectable({ providedIn: 'root' })
export class TitleService {
  private readonly i18n = inject(I18nService);
  private readonly key = signal<I18nKey | null>(null);
  private readonly text = signal<string | null>(null);

  readonly title = computed(() => {
    const t = this.text();
    if (t) return t;
    const k = this.key();
    return k ? this.i18n.t(k) : 'Glimtpanel';
  });

  constructor() {
    effect(() => {
      const title = this.title();
      if (typeof document !== 'undefined') document.title = title === 'Glimtpanel' ? title : `${title} · Glimtpanel`;
    });
  }

  setKey(key: I18nKey): void {
    this.text.set(null);
    this.key.set(key);
  }

  set(text: string): void {
    this.key.set(null);
    this.text.set(text);
  }

  clear(): void {
    this.key.set(null);
    this.text.set(null);
  }
}
