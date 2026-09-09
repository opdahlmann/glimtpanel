import { inject, Injectable, Injector } from '@angular/core';
import { ConfigService } from './config.service';
import { I18nKey } from './i18n.service';
import { SessionService } from './session.service';

/** ProblemDetails fra huben → feilobjekt. `status: 0` = nettverksfeil. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
    readonly title?: string,
    readonly detail?: string,
    readonly errors?: Record<string, string[]>,
  ) {
    super(title ?? code ?? `HTTP ${status}`);
    this.name = 'ApiError';
  }
}

export interface RequestOptions {
  /** Uten Authorization og uten refresh-forsøk ved 401 (login, register, refresh, …). */
  anonymous?: boolean;
  /** Ekstra spørrestreng. */
  query?: Record<string, string | number | boolean | null | undefined>;
  signal?: AbortSignal;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

const CODE_KEYS: Record<string, I18nKey> = {
  emailTaken: 'emailTaken',
  emailNotConfirmed: 'emailNotConfirmed',
  invalidToken: 'invalidToken',
  wrongCredentials: 'wrongCredentials',
};

/** Feil → ordboksnøkkel. 401 uten kode regnes som feil e-post/passord (login), 0 som nettverksfeil. */
export function errorKey(err: unknown): I18nKey {
  if (err instanceof ApiError) {
    if (err.code && CODE_KEYS[err.code]) return CODE_KEYS[err.code];
    if (err.status === 401) return 'wrongCredentials';
    if (err.status === 0) return 'networkError';
  }
  return 'errorGeneric';
}

/**
 * `fetch`-basert klient mot `config.apiUrl` (steg 3.4): JSON begge veier, `Authorization: Bearer` fra SessionService,
 * `credentials: 'include'` for oppfriskningscookien, én automatisk `POST /api/auth/refresh` + nytt forsøk ved 401
 * (delt mellom samtidige kall), ProblemDetails → ApiError.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly config = inject(ConfigService);
  private readonly injector = inject(Injector);
  private refreshing: Promise<boolean> | null = null;

  /** Lazy: SessionService bruker ApiService, så oppslaget skjer først ved kall. */
  private get session(): SessionService {
    return this.injector.get(SessionService);
  }

  get<T>(path: string, opts?: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, undefined, opts);
  }

  post<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, body, opts);
  }

  patch<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.request<T>('PATCH', path, body, opts);
  }

  put<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.request<T>('PUT', path, body, opts);
  }

  delete<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.request<T>('DELETE', path, body, opts);
  }

  /** Full URL for en sti under `apiUrl`, f.eks. url('/servers') → "/api/servers". */
  url(path: string, query?: RequestOptions['query']): string {
    const base = this.config.config().apiUrl.replace(/\/$/, '');
    let url = base + (path.startsWith('/') ? path : '/' + path);
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) params.set(k, String(v));
      }
      const qs = params.toString();
      if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    }
    return url;
  }

  private async request<T>(method: Method, path: string, body: unknown, opts: RequestOptions = {}): Promise<T> {
    const res = await this.send(method, path, body, opts);
    if (res.status === 401 && !opts.anonymous && (await this.tryRefresh())) {
      return this.parse<T>(await this.send(method, path, body, opts));
    }
    return this.parse<T>(res);
  }

  private async send(method: Method, path: string, body: unknown, opts: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (!opts.anonymous) {
      const token = this.session.accessToken();
      if (token) headers['authorization'] = `Bearer ${token}`;
    }
    try {
      return await fetch(this.url(path, opts.query), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'include',
        signal: opts.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new ApiError(0, 'network', 'network error', err instanceof Error ? err.message : String(err));
    }
  }

  /** Én oppfriskning om gangen; alle som venter får samme svar. */
  private tryRefresh(): Promise<boolean> {
    if (!this.refreshing) {
      this.refreshing = this.session
        .refresh()
        .catch(() => false)
        .finally(() => (this.refreshing = null));
    }
    return this.refreshing;
  }

  private async parse<T>(res: Response): Promise<T> {
    if (res.ok) {
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
    throw await toApiError(res);
  }
}

interface ProblemDetails {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  code?: string;
  errors?: Record<string, string[]>;
}

export async function toApiError(res: Response): Promise<ApiError> {
  let problem: ProblemDetails | null;
  try {
    const text = await res.text();
    problem = text ? (JSON.parse(text) as ProblemDetails) : null;
  } catch {
    problem = null;
  }
  return new ApiError(res.status, problem?.code, problem?.title, problem?.detail, problem?.errors);
}
