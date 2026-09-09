import { TestBed } from '@angular/core/testing';
import { ToastHostComponent } from './toast-host.component';
import { TOAST_MS, ToastService } from './toast.service';

describe('ToastService / gp-toast-host', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows a toast, hides it after 2.2 s and drains the queue one at a time', () => {
    const svc = TestBed.inject(ToastService);
    expect(svc.current()).toBeNull();
    svc.show('Copied to clipboard');
    svc.show('Link copied');
    expect(svc.current()?.message).toBe('Copied to clipboard');
    vi.advanceTimersByTime(TOAST_MS - 1);
    expect(svc.current()?.message).toBe('Copied to clipboard');
    vi.advanceTimersByTime(1);
    expect(svc.current()?.message).toBe('Link copied');
    vi.advanceTimersByTime(TOAST_MS);
    expect(svc.current()).toBeNull();
  });

  it('renders the pill in a polite live region', () => {
    const fixture = TestBed.createComponent(ToastHostComponent);
    fixture.detectChanges();
    const host = fixture.nativeElement.querySelector('.host') as HTMLElement;
    expect(host.getAttribute('aria-live')).toBe('polite');
    expect(fixture.nativeElement.querySelector('.pill')).toBeNull();
    TestBed.inject(ToastService).show('Copied');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pill')?.textContent?.trim()).toBe('Copied');
    vi.advanceTimersByTime(TOAST_MS);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pill')).toBeNull();
  });
});
