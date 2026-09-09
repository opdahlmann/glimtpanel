import { inject, Injectable } from '@angular/core';
import { ToastService } from '@shared/toast/toast.service';
import { I18nService } from './i18n.service';

/** Kopierer tekst og viser toasten «Copied to clipboard» (6.2). Tåler at Clipboard API mangler (http uten localhost). */
@Injectable({ providedIn: 'root' })
export class ClipboardService {
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);

  async copy(text: string, message?: string): Promise<boolean> {
    let ok: boolean;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      } else {
        ok = legacyCopy(text);
      }
    } catch {
      ok = legacyCopy(text);
    }
    if (ok) this.toast.show(message ?? this.i18n.t('copied'));
    return ok;
  }
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok: boolean;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}
