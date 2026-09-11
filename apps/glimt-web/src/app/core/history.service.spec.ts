import { TestBed } from '@angular/core/testing';
import { ApiService } from './api.service';
import { HISTORY_CACHE_MS, HistoryResult, HistoryService } from './history.service';

describe('HistoryService', () => {
  let get: ReturnType<typeof vi.fn>;
  let service: HistoryService;
  let now: number;
  const result: HistoryResult = { metric: 'cpu', range: '1h', stepMs: 30_000, from: 0, to: 3_600_000, values: [1, null, 3] };

  beforeEach(() => {
    get = vi.fn(() => Promise.resolve(result));
    TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: { get } }] });
    service = TestBed.inject(HistoryService);
    now = 1_000_000;
    service.now = () => now;
  });

  it('henter med metric og range som spørrestreng og mellomlagrer i 60 s', async () => {
    await expect(service.get('s1', 'cpu', '1h')).resolves.toBe(result);
    expect(get).toHaveBeenCalledWith('/servers/s1/history', { query: { metric: 'cpu', range: '1h' } });
    await service.get('s1', 'cpu', '1h');
    expect(get).toHaveBeenCalledTimes(1);
    now += HISTORY_CACHE_MS;
    await service.get('s1', 'cpu', '1h');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('deler én pågående forespørsel per nøkkel og skiller på server, metrikk og område', async () => {
    let resolve: (r: HistoryResult) => void = () => undefined;
    get.mockImplementationOnce(() => new Promise<HistoryResult>((r) => (resolve = r)));
    const a = service.get('s1', 'mem', '24h');
    const b = service.get('s1', 'mem', '24h');
    expect(a).toBe(b);
    resolve(result);
    await a;
    await service.get('s2', 'mem', '24h');
    await service.get('s1', 'cont:abc:mem', '24h');
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('feil mellomlagres ikke', async () => {
    get.mockImplementationOnce(() => Promise.reject(new Error('503')));
    await expect(service.get('s1', 'cpu', '1h')).rejects.toThrow('503');
    await expect(service.get('s1', 'cpu', '1h')).resolves.toBe(result);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('clear glemmer alt eller bare én server', async () => {
    await service.get('s1', 'cpu', '1h');
    await service.get('s2', 'cpu', '1h');
    service.clear('s1');
    await service.get('s1', 'cpu', '1h');
    await service.get('s2', 'cpu', '1h');
    expect(get).toHaveBeenCalledTimes(3);
    service.clear();
    await service.get('s2', 'cpu', '1h');
    expect(get).toHaveBeenCalledTimes(4);
  });
});
