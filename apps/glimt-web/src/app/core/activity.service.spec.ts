import { TestBed } from '@angular/core/testing';
import { ActivityService, IDLE_AFTER_MS } from './activity.service';

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('ActivityService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starter aktiv og blir idle etter 2 min uten interaksjon', () => {
    const activity = TestBed.inject(ActivityService);
    expect(activity.mode()).toBe('active');
    vi.advanceTimersByTime(IDLE_AFTER_MS - 1);
    expect(activity.mode()).toBe('active');
    vi.advanceTimersByTime(1);
    expect(activity.mode()).toBe('idle');
  });

  it('interaksjon nullstiller fristen og gjør idle → active', () => {
    const activity = TestBed.inject(ActivityService);
    vi.advanceTimersByTime(IDLE_AFTER_MS - 1000);
    window.dispatchEvent(new Event('pointermove'));
    vi.advanceTimersByTime(IDLE_AFTER_MS - 1000);
    expect(activity.mode()).toBe('active');
    vi.advanceTimersByTime(1000);
    expect(activity.mode()).toBe('idle');
    window.dispatchEvent(new Event('keydown'));
    expect(activity.mode()).toBe('active');
  });

  it('skjult fane → hidden, uansett interaksjon; synlig igjen → active', () => {
    const activity = TestBed.inject(ActivityService);
    setVisibility('hidden');
    expect(activity.mode()).toBe('hidden');
    window.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(IDLE_AFTER_MS * 2);
    expect(activity.mode()).toBe('hidden');
    setVisibility('visible');
    expect(activity.mode()).toBe('active');
    vi.advanceTimersByTime(IDLE_AFTER_MS);
    expect(activity.mode()).toBe('idle');
  });
});
