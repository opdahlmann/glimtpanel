import { computed, inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import { SwPush } from '@angular/service-worker';
import { AlertsService } from './alerts.service';
import { ConfigService } from './config.service';

export type PushStatus = 'idle' | 'asking' | 'on' | 'denied' | 'unsupported' | 'error';

/** `window.__gpFakePush = 'granted' | 'denied'`: utenom produksjon svarer tillatelsen slik, og ingen ekte abonnement registreres (Playwright uten service worker). */
declare global {
  interface Window {
    __gpFakePush?: 'granted' | 'denied' | 'default';
  }
}

/**
 * Web Push i nettleseren (steg 7.5): tillatelse → `SwPush.requestSubscription({ serverPublicKey })` →
 * `POST /api/push-subscriptions` med enhetsnavn. `notificationClicks` navigerer til `url` i nyttelasten.
 * `unsubscribe()` melder av hos huben og i nettleseren. Uten service worker (ng serve) er push «unsupported»,
 * unntatt når `window.__gpFakePush` er satt utenom produksjon: da er svaret på tillatelsen gitt av flagget og abonnementet simuleres lokalt.
 */
@Injectable({ providedIn: 'root' })
export class PushService {
  private readonly swPush = inject(SwPush);
  private readonly alerts = inject(AlertsService);
  private readonly config = inject(ConfigService);
  private readonly router = inject(Router);

  private readonly _status = signal<PushStatus>(initialStatus(this.fakeAnswer()));
  private readonly _endpoint = signal<string | null>(null);
  private clicksWired = false;

  readonly status = this._status.asReadonly();
  readonly isOn = computed(() => this._status() === 'on');
  /** Nettleseren kan vise varsler (Notification finnes) og service worker eller falsk push er tilgjengelig. */
  readonly supported = computed(() => this._status() !== 'unsupported');
  readonly endpoint = this._endpoint.asReadonly();

  constructor() {
    if (this.swPush.isEnabled) {
      this.swPush.subscription.subscribe((sub) => {
        this._endpoint.set(sub?.endpoint ?? null);
        if (sub && permission() === 'granted') this._status.set('on');
      });
      this.wireClicks();
    }
  }

  /** Ber om tillatelse og registrerer enheten. Resultatet ligger i `status`. */
  async enable(): Promise<PushStatus> {
    const fake = this.fakeAnswer();
    if (fake === null && typeof Notification === 'undefined') {
      this._status.set('unsupported');
      return 'unsupported';
    }
    this._status.set('asking');
    let result: NotificationPermission;
    if (fake !== null) {
      result = fake;
    } else {
      try {
        result = await Notification.requestPermission();
      } catch (err) {
        console.warn('[push] permission request failed', err);
        result = 'default';
      }
    }
    if (result !== 'granted') {
      this._status.set(result === 'denied' ? 'denied' : 'idle');
      return this._status();
    }
    if (fake !== null) {
      this._endpoint.set('fake://e2e');
      this._status.set('on');
      return 'on';
    }
    if (!this.swPush.isEnabled) {
      this._status.set('unsupported');
      return 'unsupported';
    }
    const key = this.config.config().vapidPublic;
    if (!key) {
      console.warn('[push] no VAPID public key in config.json');
      this._status.set('error');
      return 'error';
    }
    try {
      const sub = await this.swPush.requestSubscription({ serverPublicKey: key });
      const json = sub.toJSON();
      await this.alerts.addPushSubscription(sub.endpoint, { p256dh: json.keys?.['p256dh'] ?? '', auth: json.keys?.['auth'] ?? '' }, deviceName());
      this._endpoint.set(sub.endpoint);
      this._status.set('on');
      return 'on';
    } catch (err) {
      console.warn('[push] subscription failed', err);
      this._status.set('error');
      return 'error';
    }
  }

  /** Melder av denne enheten hos huben og i nettleseren. */
  async disable(): Promise<void> {
    const endpoint = this._endpoint();
    if (endpoint && !endpoint.startsWith('fake://')) {
      try {
        await this.alerts.removePushSubscription(endpoint);
      } catch (err) {
        console.warn('[push] could not remove the subscription on the hub', err);
      }
      if (this.swPush.isEnabled) {
        try {
          await this.swPush.unsubscribe();
        } catch (err) {
          console.warn('[push] browser unsubscribe failed', err);
        }
      }
    }
    this._endpoint.set(null);
    this._status.set('idle');
  }

  /** Flaggets svar utenom produksjon, ellers null. */
  private fakeAnswer(): NotificationPermission | null {
    if (typeof window === 'undefined' || this.config.config().env === 'production') return null;
    const v = window.__gpFakePush;
    return v === 'granted' || v === 'denied' || v === 'default' ? v : null;
  }

  private wireClicks(): void {
    if (this.clicksWired) return;
    this.clicksWired = true;
    this.swPush.notificationClicks.subscribe(({ notification }) => {
      const url = (notification.data as { url?: string } | undefined)?.url;
      if (typeof url === 'string' && url.startsWith('/')) void this.router.navigateByUrl(url);
    });
  }
}

function permission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

function initialStatus(fake: NotificationPermission | null): PushStatus {
  if (fake !== null) return 'idle';
  const p = permission();
  if (p === 'unsupported') return 'unsupported';
  if (p === 'denied') return 'denied';
  return 'idle';
}

/** «iPhone · Safari», «MacBook · Chrome» – fra userAgentData når den finnes, ellers UA-strengen. */
export function deviceName(ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent, platformHint?: string): string {
  const nav = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { userAgentData?: { platform?: string; brands?: { brand: string }[] } });
  const platform = platformHint ?? nav?.userAgentData?.platform ?? platformFromUa(ua);
  const browser = browserFromUa(ua, nav?.userAgentData?.brands?.map((b) => b.brand));
  return [platform, browser].filter(Boolean).join(' · ') || 'Browser';
}

function platformFromUa(ua: string): string {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad|Macintosh.*Mobile/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return '';
}

function browserFromUa(ua: string, brands?: string[]): string {
  const known = brands?.find((b) => /Chrome|Edge|Opera|Brave/.test(b) && !/Chromium|Not/.test(b));
  if (known) return known.replace('Google ', '').replace('Microsoft ', '');
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return '';
}
