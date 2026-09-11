import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivityMode, ActivityService } from './activity.service';
import { LiveService, LogHandlers } from './live.service';
import { LiveState, LogLineDto, LogRequest } from './live.types';
import { LOG_MAX_LINES, LogStreamService, requestKey } from './log-stream.service';

class LiveStub {
  readonly state = signal<LiveState>('connected');
  started: { req: LogRequest; handlers: LogHandlers; id: string }[] = [];
  stopped: string[] = [];
  private n = 0;
  readonly startLog = vi.fn(async (req: LogRequest, handlers: LogHandlers) => {
    const id = `s${++this.n}`;
    this.started.push({ req, handlers, id });
    return id;
  });
  readonly stopLog = vi.fn(async (id: string) => {
    this.stopped.push(id);
  });
  /** Skjult fane: LiveService avslutter alle strømmer selv med grunn «hidden». */
  hide(activity: ActivityStub): void {
    for (const s of this.started) if (!this.stopped.includes(s.id)) s.handlers.ended('hidden', null);
    activity.mode.set('hidden');
  }
}

class ActivityStub {
  readonly mode = signal<ActivityMode>('active');
}

const line = (ts: number, message = 'm'): LogLineDto => ({ ts, unit: 'sshd', container: null, priority: 'info', message });
const req = (over: Partial<LogRequest> = {}): LogRequest => ({ serverId: 's1', source: 'journal', tail: 200, ...over });

describe('LogStreamService', () => {
  let live: LiveStub;
  let activity: ActivityStub;
  let service: LogStreamService;

  beforeEach(() => {
    live = new LiveStub();
    activity = new ActivityStub();
    TestBed.configureTestingModule({
      providers: [LogStreamService, { provide: LiveService, useValue: live }, { provide: ActivityService, useValue: activity }],
    });
    service = TestBed.inject(LogStreamService);
  });

  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('bytte av filter gir ett stopp og én start, og linjene tømmes', async () => {
    service.configure([req()]);
    await flush();
    expect(live.startLog).toHaveBeenCalledTimes(1);
    live.started[0].handlers.lines([line(1)], null);
    expect(service.lines().length).toBe(1);
    expect(service.statuses()[0].state).toBe('streaming');

    service.configure([req({ priority: 'err' })]);
    await flush();
    expect(live.stopped).toEqual(['s1']);
    expect(live.startLog).toHaveBeenCalledTimes(2);
    expect(live.started[1].req.priority).toBe('err');
    expect(service.lines()).toEqual([]);
    // Linjer fra den gamle strømmen ignoreres.
    live.started[0].handlers.lines([line(2)], null);
    expect(service.lines()).toEqual([]);

    // Samme forespørsel igjen: ingen ny start.
    service.configure([req({ priority: 'err' })]);
    await flush();
    expect(live.startLog).toHaveBeenCalledTimes(2);
  });

  it('nyeste først, høyst 300 linjer, og «dropped» gir en markør', async () => {
    service.configure([req()]);
    await flush();
    const h = live.started[0].handlers;
    h.lines(Array.from({ length: 250 }, (_, i) => line(i + 1)), null);
    h.lines(Array.from({ length: 100 }, (_, i) => line(1000 + i)), 7);
    expect(service.lines().length).toBe(LOG_MAX_LINES);
    expect(service.lines()[0].dropped).toBe(7);
    expect(service.lines()[1].ts).toBe(1000);
    expect(service.dropped()).toBe(7);
  });

  it('pause samler linjer i en buffer med teller; resume flytter dem inn', async () => {
    service.configure([req()]);
    await flush();
    const h = live.started[0].handlers;
    h.lines([line(1)], null);
    service.pause();
    h.lines([line(2)], null);
    h.lines([line(3)], null);
    expect(service.paused()).toBe(true);
    expect(service.pendingCount()).toBe(2);
    expect(service.lines().length).toBe(1);
    service.resume();
    expect(service.paused()).toBe(false);
    expect(service.pendingCount()).toBe(0);
    expect(service.lines().map((l) => l.ts)).toEqual([3, 2, 1]);
  });

  it('skjult fane stopper; synlig igjen starter på nytt med sinceMs = siste linje + 1', async () => {
    service.configure([req()]);
    await flush();
    live.started[0].handlers.lines([line(5000), line(6000)], null);
    live.hide(activity);
    await flush();
    expect(service.streaming()).toBe(false);
    expect(service.statuses()[0].state).toBe('idle');
    activity.mode.set('active');
    await flush();
    expect(live.startLog).toHaveBeenCalledTimes(2);
    expect(live.started[1].req.sinceMs).toBe(6001);
    expect(live.started[1].req.tail).toBeNull();
    expect(service.lines().length).toBe(2);
  });

  it('hubens avslutning (unavailable) står til forespørselen byttes', async () => {
    service.configure([req({ source: 'web' })]);
    await flush();
    live.started[0].handlers.ended('unavailable', 'no web server logs');
    expect(service.allEnded()).toBe(true);
    expect(service.statuses()[0]).toMatchObject({ state: 'ended', reason: 'unavailable' });
    activity.mode.set('idle');
    await flush();
    expect(live.startLog).toHaveBeenCalledTimes(1);
  });

  it('flere containere: én strøm per container, høyst 4, alt stoppes ved destroy', async () => {
    const reqs = ['a', 'b', 'c', 'd', 'e'].map((c) => req({ source: 'container', container: c }));
    service.configure(reqs);
    await flush();
    expect(live.startLog).toHaveBeenCalledTimes(4);
    expect(service.statuses().map((s) => s.request.container)).toEqual(['a', 'b', 'c', 'd']);
    TestBed.resetTestingModule();
    expect(live.stopped.sort()).toEqual(['s1', 's2', 's3', 's4']);
  });

  it('requestKey skiller på det som gir ny strøm', () => {
    expect(requestKey(req())).toBe(requestKey(req()));
    expect(requestKey(req({ sinceMs: 1 }))).not.toBe(requestKey(req({ sinceMs: 2 })));
    expect(requestKey(req({ unit: 'x' }))).not.toBe(requestKey(req()));
  });
});
