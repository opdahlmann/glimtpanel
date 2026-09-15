import { computed, inject, Injectable, signal } from '@angular/core';
import { ApiError, ApiService } from './api.service';
import { I18nService } from './i18n.service';
import { LoginResponse, ServerRole, UserDto } from './live.types';
import { PrefsService } from './prefs.service';

/** Oppfrisk tilgangstokenet så lenge før utløp (15 min token → ved 14 min). */
export const REFRESH_MARGIN_MS = 60_000;

/**
 * Innlogging og tilgangstoken i minnet (steg 3.4). Ved oppstart prøves `POST /api/auth/refresh` én gang (cookie)
 * og deretter `GET /api/auth/me`; `ready` blir true uansett utfall, og guardene venter på den. Cookien er httpOnly,
 * så `prefs.hasSession` husker om denne nettleseren har hatt en sesjon: uten den hoppes oppfriskningen over
 * (ingen 401 i konsollen for førstegangsbesøkende).
 * `isOwnerOf(id)` leser rollekartet som ServerListService fyller fra `GET /api/servers`.
 *
 * Demomodus (steg 10.1): `/demo` kaller `startDemo()`, som henter et demotoken fra `POST /api/demo/session` og legger det
 * i `_demo` ved siden av en eventuell ekte sesjon. `user`/`accessToken` peker på demoen så lenge den er aktiv, rollen
 * er alltid leser, oppfriskning henter et nytt demotoken, og `endDemo()` gir den ekte sesjonen tilbake urørt.
 */
@Injectable({ providedIn: 'root' })
export class SessionService {
  private readonly api = inject(ApiService);
  private readonly i18n = inject(I18nService);
  private readonly prefs = inject(PrefsService);

  private readonly _user = signal<UserDto | null>(null);
  private readonly _token = signal<string | null>(null);
  private readonly _expiresAt = signal<number | null>(null);
  private readonly _demo = signal<LoginResponse | null>(null);
  private readonly _ready = signal(false);
  private readonly _roles = signal<ReadonlyMap<string, ServerRole>>(new Map());
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  /** Demomodus (steg 10.1): `/demo` har hentet et demotoken; alt annet leser demoen i stedet for den ekte sesjonen. */
  readonly demoMode = computed(() => this._demo() !== null);
  readonly user = computed(() => this._demo()?.user ?? this._user());
  readonly accessToken = computed(() => this._demo()?.accessToken ?? this._token());
  readonly expiresAt = computed(() => {
    const demo = this._demo();
    return demo ? Date.parse(demo.expiresAt) : this._expiresAt();
  });
  readonly isAuthenticated = computed(() => this.user() !== null && this.accessToken() !== null);
  /** true etter første oppfriskningsforsøk (eller etter `start()` uten cookie). */
  readonly ready = this._ready.asReadonly();
  readonly serverRoles = this._roles.asReadonly();
  /** Demoen er alltid leser, uansett hva huben svarer (i produksjon eier demokontoen serverne). */
  readonly ownsAnyServer = computed(() => {
    if (this.demoMode()) return false;
    const u = this._user();
    if (u?.ownsServers) return true;
    for (const role of this._roles().values()) if (role === 'owner') return true;
    return false;
  });

  /** Kalles fra app.config.ts etter at config.json er lastet. Blokkerer ikke oppstarten. */
  start(): void {
    if (this.readyPromise) return;
    this.readyPromise = new Promise<void>((resolve) => (this.resolveReady = resolve));
    void this.bootstrap();
  }

  /** Løses når første oppfriskningsforsøk er ferdig. Guardene bruker den. */
  whenReady(): Promise<void> {
    if (this._ready()) return Promise.resolve();
    if (!this.readyPromise) this.start();
    return this.readyPromise as Promise<void>;
  }

  private async bootstrap(): Promise<void> {
    try {
      if (this.prefs.hasSession.value() && (await this.refresh())) await this.loadMe();
    } catch (err) {
      console.warn('[session] startup refresh failed', err);
    } finally {
      this.markReady();
    }
  }

  private markReady(): void {
    this._ready.set(true);
    this.resolveReady?.();
    this.resolveReady = null;
  }

  async login(email: string, password: string): Promise<UserDto> {
    const res = await this.api.post<LoginResponse>('/auth/login', { email, password }, { anonymous: true });
    this.apply(res);
    void this.loadMe().catch(() => undefined);
    if (!this._ready()) this.markReady();
    return res.user;
  }

  /** `POST /api/auth/register` (201 med brukeren). Sesjonen settes først ved bekreftelse. */
  register(email: string, password: string, name: string): Promise<UserDto> {
    return this.api.post<UserDto>('/auth/register', { email, password, name }, { anonymous: true });
  }

  /** `POST /api/auth/confirm { token }` → innlogget. */
  async confirm(token: string): Promise<UserDto> {
    const res = await this.api.post<LoginResponse>('/auth/confirm', { token }, { anonymous: true });
    this.apply(res);
    void this.loadMe().catch(() => undefined);
    return res.user;
  }

  resendConfirmation(email: string): Promise<void> {
    return this.api.post<void>('/auth/resend-confirmation', { email }, { anonymous: true });
  }

  forgot(email: string): Promise<void> {
    return this.api.post<void>('/auth/forgot', { email }, { anonymous: true });
  }

  reset(token: string, password: string): Promise<void> {
    return this.api.post<void>('/auth/reset', { token, password }, { anonymous: true });
  }

  /** Setter sesjonen fra et ferdig svar (demo-token i fase 10, eller tester). */
  apply(res: LoginResponse): void {
    this._token.set(res.accessToken);
    this._expiresAt.set(Date.parse(res.expiresAt));
    this._user.set(res.user);
    this.i18n.applyProfile(res.user);
    this.prefs.hasSession.set(true);
    this.armExpiryTimer();
  }

  /**
   * `POST /api/demo/session` (steg 10.1): demotoken uten innlogging. Den ekte sesjonen (om noen) beholdes bak demoen.
   * Kaster `ApiError` når huben ikke kjører i demomodus (404).
   */
  async startDemo(): Promise<UserDto> {
    const res = await this.api.post<LoginResponse>('/demo/session', undefined, { anonymous: true });
    this._demo.set(res);
    this._roles.set(new Map());
    this.armExpiryTimer();
    if (!this._ready()) this.markReady();
    return res.user;
  }

  /** Ut av demoen: den ekte sesjonen, om noen, er som før. */
  endDemo(): void {
    if (!this._demo()) return;
    this._demo.set(null);
    this._roles.set(new Map());
    this.armExpiryTimer();
  }

  /** `POST /api/auth/refresh` med cookien. true når vi fikk nytt token; false ved 401 (ingen sesjon). I demoen: nytt demotoken. */
  async refresh(): Promise<boolean> {
    if (this.demoMode()) {
      try {
        await this.startDemo();
        return true;
      } catch (err) {
        console.warn('[session] demo refresh failed', err);
        this.armExpiryTimer(REFRESH_MARGIN_MS / 2);
        return false;
      }
    }
    try {
      const res = await this.api.post<LoginResponse>('/auth/refresh', undefined, { anonymous: true });
      this.apply(res);
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) {
        // nettverksfeil: behold en eventuell sesjon, prøv igjen senere
        this.armExpiryTimer(REFRESH_MARGIN_MS / 2);
        return false;
      }
      this.clear();
      return false;
    }
  }

  /** `GET /api/auth/me`: brukeren pluss ownsServers/readerOf. Ikke i demoen (svaret fra /demo/session er alt vi trenger). */
  async loadMe(): Promise<UserDto | null> {
    if (!this._token() || this.demoMode()) return null;
    const me = await this.api.get<UserDto>('/auth/me');
    this._user.set(me);
    this.i18n.applyProfile(me);
    return me;
  }

  /** `PATCH /api/account { name?, timezone?, language? }`. */
  async updateAccount(patch: { name?: string; timezone?: string; language?: string }): Promise<UserDto> {
    const me = await this.api.patch<UserDto>('/account', patch);
    this._user.set(me);
    this.i18n.applyProfile(me);
    return me;
  }

  async logout(): Promise<void> {
    if (this.demoMode()) {
      this.endDemo();
      return;
    }
    try {
      await this.api.post<void>('/auth/logout', undefined, { anonymous: true });
    } catch (err) {
      console.warn('[session] logout request failed', err);
    } finally {
      this.clear();
    }
  }

  /** Fylles av ServerListService fra `GET /api/servers` (rolle per server). */
  setServerRoles(roles: Iterable<[string, ServerRole]>): void {
    this._roles.set(new Map(roles));
  }

  isOwnerOf(serverId: string): boolean {
    return !this.demoMode() && this._roles().get(serverId) === 'owner';
  }

  private clear(): void {
    this._token.set(null);
    this._expiresAt.set(null);
    this._user.set(null);
    this._roles.set(new Map());
    this.i18n.applyProfile(null);
    this.prefs.hasSession.set(false);
    this.clearTimer();
  }

  private armExpiryTimer(inMs?: number): void {
    this.clearTimer();
    const at = this.expiresAt();
    const delay = inMs ?? (at === null ? null : Math.max(1000, at - Date.now() - REFRESH_MARGIN_MS));
    if (delay === null || !this.accessToken()) return;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      void this.refresh();
    }, delay);
  }

  private clearTimer(): void {
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  }
}
