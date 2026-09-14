import { ErrorHandler, inject, Injectable, Injector } from '@angular/core';
import { ToastService } from '@shared/toast/toast.service';
import { ApiError } from './api.service';
import { ConfigService } from './config.service';
import { I18nService } from './i18n.service';

/** Høyst så mange rapporter per minutt fra én nettleser, og aldri samme melding to ganger på rad. */
export const CLIENT_ERROR_LIMIT_PER_MIN = 5;

/**
 * Global feilhåndterer (steg 9.5): uventede feil gir toasten «Something went wrong · Reload» og sendes til
 * `POST /api/client-errors` (uten token, begrenset i huben og her). `ApiError` håndteres der kallet gjøres og
 * rapporteres ikke; det samme gjelder avbrutte `fetch`. Feil i selve rapporteringen svelges.
 */
@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
  private readonly injector = inject(Injector);
  private sent: number[] = [];
  private lastMessage = '';

  handleError(error: unknown): void {
    const err = unwrap(error);
    console.error(err);
    if (err instanceof ApiError || isAbort(err)) return;
    this.toast();
    void this.report(err);
  }

  private toast(): void {
    try {
      const toast = this.injector.get(ToastService);
      const i18n = this.injector.get(I18nService);
      toast.show(i18n.t('somethingWrong'), { label: i18n.t('reload'), run: () => location.reload() });
    } catch {
      // ingen toast før appen er oppe
    }
  }

  private async report(err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const now = Date.now();
    this.sent = this.sent.filter((t) => now - t < 60_000);
    if (this.sent.length >= CLIENT_ERROR_LIMIT_PER_MIN || message === this.lastMessage) return;
    this.sent.push(now);
    this.lastMessage = message;
    try {
      const config = this.injector.get(ConfigService);
      await fetch(`${config.config().apiUrl}/client-errors`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: message.slice(0, 500),
          stack: err instanceof Error ? (err.stack ?? '').slice(0, 4000) : null,
          url: typeof location === 'undefined' ? null : location.href,
          userAgent: typeof navigator === 'undefined' ? null : navigator.userAgent,
          version: null,
        }),
        keepalive: true,
      });
    } catch {
      // rapportering skal aldri gi ny feil
    }
  }
}

/** Angular pakker feil fra promises/effects inn; hent den egentlige. */
function unwrap(error: unknown): unknown {
  const rejection = (error as { rejection?: unknown } | null)?.rejection;
  return rejection ?? error;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}
