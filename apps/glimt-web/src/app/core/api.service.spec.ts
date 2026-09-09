import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ApiError, ApiService, errorKey } from './api.service';
import { SessionService } from './session.service';

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': body === undefined ? 'text/plain' : 'application/json' },
  });
}

describe('ApiService', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let session: { accessToken: ReturnType<typeof signal<string | null>>; refresh: ReturnType<typeof vi.fn> };
  let api: ApiService;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    session = { accessToken: signal<string | null>('tok-1'), refresh: vi.fn() };
    TestBed.configureTestingModule({ providers: [{ provide: SessionService, useValue: session }] });
    api = TestBed.inject(ApiService);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('sender JSON med Bearer og cookie mot config.apiUrl', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const res = await api.post<{ ok: boolean }>('/servers', { name: 'x' });
    expect(res).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/servers');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tok-1');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(init.body).toBe('{"name":"x"}');
  });

  it('anonymous: uten Authorization og uten oppfriskning ved 401', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { title: 'Unauthorized' }));
    await expect(api.post('/auth/login', { email: 'a@b.c', password: 'x' }, { anonymous: true })).rejects.toBeInstanceOf(ApiError);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['authorization']).toBeUndefined();
    expect(session.refresh).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('401 → refresh → nytt forsøk én gang med nytt token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401)).mockResolvedValueOnce(jsonResponse(200, [{ id: 'a' }]));
    session.refresh.mockImplementation(async () => {
      session.accessToken.set('tok-2');
      return true;
    });
    const res = await api.get<{ id: string }[]>('/servers');
    expect(res).toEqual([{ id: 'a' }]);
    expect(session.refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retry = fetchMock.mock.calls[1][1] as RequestInit;
    expect((retry.headers as Record<string, string>)['authorization']).toBe('Bearer tok-2');
  });

  it('401 der oppfriskningen feiler gir ApiError 401 uten nytt forsøk', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401));
    session.refresh.mockResolvedValue(false);
    await expect(api.get('/servers')).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('samtidige 401 deler én oppfriskning', async () => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>)['authorization'];
      return auth === 'Bearer tok-2' ? jsonResponse(200, { ok: 1 }) : jsonResponse(401);
    });
    let resolveRefresh: (v: boolean) => void = () => undefined;
    session.refresh.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveRefresh = (v) => {
            session.accessToken.set('tok-2');
            resolve(v);
          };
        }),
    );
    const p1 = api.get('/a');
    const p2 = api.get('/b');
    await Promise.resolve();
    await Promise.resolve();
    resolveRefresh(true);
    await expect(p1).resolves.toEqual({ ok: 1 });
    await expect(p2).resolves.toEqual({ ok: 1 });
    expect(session.refresh).toHaveBeenCalledTimes(1);
  });

  it('ProblemDetails → ApiError med code, title og errors', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, { title: 'E-mail already registered', status: 409, code: 'emailTaken', errors: { email: ['taken'] } }),
    );
    const err = await api.post('/auth/register', {}, { anonymous: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(409);
    expect(apiErr.code).toBe('emailTaken');
    expect(apiErr.title).toBe('E-mail already registered');
    expect(apiErr.errors).toEqual({ email: ['taken'] });
    expect(errorKey(apiErr)).toBe('emailTaken');
  });

  it('204 gir undefined, nettverksfeil gir status 0', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(api.post('/auth/forgot', { email: 'a@b.c' }, { anonymous: true })).resolves.toBeUndefined();
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const err = (await api.get('/x').catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(0);
    expect(errorKey(err)).toBe('networkError');
  });

  it('errorKey: 401 uten kode = feil passord, ukjent = generisk', () => {
    expect(errorKey(new ApiError(401))).toBe('wrongCredentials');
    expect(errorKey(new ApiError(403, 'emailNotConfirmed'))).toBe('emailNotConfirmed');
    expect(errorKey(new ApiError(500))).toBe('errorGeneric');
    expect(errorKey(new Error('x'))).toBe('errorGeneric');
  });

  it('url() legger på spørrestreng', () => {
    expect(api.url('/servers/a/history', { metric: 'cpu', range: '1h', skip: undefined })).toBe('/api/servers/a/history?metric=cpu&range=1h');
  });
});
