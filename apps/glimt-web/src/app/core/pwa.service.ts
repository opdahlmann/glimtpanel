import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs';

/** Chromiums `beforeinstallprompt` (ikke i lib.dom). */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * Installasjon og oppdatering (steg 7.5): fanger `beforeinstallprompt` (desktop-banneret på /welcome), vet om appen
 * kjører fra hjemskjermen (`display-mode: standalone` eller `navigator.standalone`), og ser `SwUpdate.versionUpdates`
 * («New version · Reload»-toasten i skallet).
 */
@Injectable({ providedIn: 'root' })
export class PwaService {
  private readonly updates = inject(SwUpdate);

  private readonly _installPrompt = signal<BeforeInstallPromptEvent | null>(null);
  private readonly _installed = signal(false);
  private readonly _updateReady = signal(false);
  private readonly _standalone = signal(isStandalone());

  /** Nettleseren tilbyr installasjon (Chromium på desktop og Android). */
  readonly canInstall = computed(() => this._installPrompt() !== null && !this._installed());
  readonly installed = this._installed.asReadonly();
  readonly updateReady = this._updateReady.asReadonly();
  /** Kjører som installert app (hjemskjerm / dock). */
  readonly standalone = this._standalone.asReadonly();
  readonly isIos = computed(() => typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent));
  /** iPhone/iPad i Safari, ikke på hjemskjermen: push virker først etter «Legg til på hjemskjerm». */
  readonly iosNeedsHomeScreen = computed(() => this.isIos() && !this._standalone());

  constructor() {
    if (typeof window === 'undefined') return;
    const onPrompt = (e: Event) => {
      e.preventDefault();
      this._installPrompt.set(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      this._installed.set(true);
      this._installPrompt.set(null);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    const media = window.matchMedia?.('(display-mode: standalone)');
    const onMedia = () => this._standalone.set(isStandalone());
    media?.addEventListener?.('change', onMedia);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      media?.removeEventListener?.('change', onMedia);
    });
    if (this.updates.isEnabled) {
      this.updates.versionUpdates.pipe(filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY')).subscribe(() => this._updateReady.set(true));
    }
  }

  /** Viser nettleserens installasjonsdialog. true når brukeren godtok. */
  async install(): Promise<boolean> {
    const prompt = this._installPrompt();
    if (!prompt) return false;
    try {
      await prompt.prompt();
      const { outcome } = await prompt.userChoice;
      if (outcome === 'accepted') this._installed.set(true);
      this._installPrompt.set(null);
      return outcome === 'accepted';
    } catch (err) {
      console.warn('[pwa] install prompt failed', err);
      return false;
    }
  }

  /** «Reload» i toasten: aktiverer den nye versjonen og laster siden på nytt. */
  async reload(): Promise<void> {
    try {
      if (this.updates.isEnabled) await this.updates.activateUpdate();
    } catch (err) {
      console.warn('[pwa] activateUpdate failed', err);
    }
    if (typeof location !== 'undefined') location.reload();
  }
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia?.('(display-mode: standalone)')?.matches === true;
}
