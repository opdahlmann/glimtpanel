import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { LiveService } from '@core/live.service';
import { LiveState, ServerStatusDto } from '@core/live.types';
import { OverviewPage } from './overview.page';

class LiveServiceStub {
  readonly state = signal<LiveState>('disconnected');
  readonly servers = signal<ServerStatusDto[]>([]);
  readonly start = vi.fn().mockResolvedValue(undefined);
  readonly stop = vi.fn().mockResolvedValue(undefined);
}

describe('OverviewPage', () => {
  let live: LiveServiceStub;

  beforeEach(async () => {
    live = new LiveServiceStub();
    await TestBed.configureTestingModule({
      imports: [OverviewPage],
      providers: [{ provide: LiveService, useValue: live }],
    }).compileComponents();
  });

  it('starts the live connection on init and stops it on destroy', async () => {
    const fixture = TestBed.createComponent(OverviewPage);
    await fixture.whenStable();
    expect(live.start).toHaveBeenCalledTimes(1);

    fixture.destroy();
    expect(live.stop).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state and a red live dot while disconnected', async () => {
    const fixture = TestBed.createComponent(OverviewPage);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('.empty')?.textContent).toContain('Waiting for the first agent');
    expect(el.querySelector('.live')?.classList.contains('live--on')).toBe(false);
    expect(el.querySelector('.live__label')?.textContent?.trim()).toBe('disconnected');
  });

  it('lists servers with status, RAM in GB and agent version when connected', async () => {
    live.state.set('connected');
    live.servers.set([
      {
        id: 'a',
        name: 'ubuntu-dev',
        hostname: 'ubuntu-dev.local',
        status: 'up',
        lastSeenAt: '2026-09-09T20:00:00Z',
        connected: true,
        agentVersion: '0.1.0',
        os: 'Ubuntu 24.04',
        arch: 'x86_64',
        cores: 4,
        ramBytes: 8 * 1024 ** 3,
      },
    ]);
    const fixture = TestBed.createComponent(OverviewPage);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('.empty')).toBeNull();
    expect(el.querySelector('.live')?.classList.contains('live--on')).toBe(true);
    expect(el.querySelectorAll('.row').length).toBe(1);
    expect(el.querySelector('.name')?.textContent).toBe('ubuntu-dev');
    expect(el.querySelector('.dot')?.classList.contains('dot--up')).toBe(true);
    expect(el.textContent).toContain('8.0 GB');
    expect(el.textContent).toContain('0.1.0');
  });
});
