import { TestBed } from '@angular/core/testing';
import { LogLine, LogViewComponent } from './log-view.component';

describe('gp-log-view', () => {
  const t0 = Date.UTC(2026, 8, 10, 6, 14, 5);
  const lines: LogLine[] = [
    { ts: t0, unit: 'sshd', priority: 'warn', message: 'warned' },
    { ts: t0 + 1000, unit: 'kernel', priority: 'err', message: 'failed' },
    { ts: t0 + 2000, container: 'web-web', message: 'info line', server: 'web-02' },
  ];

  async function make(inputs: Record<string, unknown> = {}) {
    const fixture = TestBed.createComponent(LogViewComponent);
    fixture.componentRef.setInput('lines', lines);
    fixture.componentRef.setInput('timeZone', 'Europe/Oslo');
    for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
    await fixture.whenStable();
    return fixture;
  }

  it('shows newest first with priority classes, HH:mm:ss and unit colours', async () => {
    const fixture = await make({ colorByUnit: new Map([['web-web', 'var(--color-swap)']]) });
    const rows = Array.from(fixture.nativeElement.querySelectorAll('.line')) as HTMLElement[];
    expect(rows.map((r) => r.querySelector('.msg')?.textContent)).toEqual(['info line', 'failed', 'warned']);
    expect(rows.map((r) => r.classList.contains('err'))).toEqual([false, true, false]);
    expect(rows.map((r) => r.classList.contains('warn'))).toEqual([false, false, true]);
    expect(rows[0].classList.contains('info')).toBe(true);
    expect(rows[2].querySelector('.time')?.textContent).toBe('08:14:05');
    expect((rows[0].querySelector('.unit') as HTMLElement).style.color).toBe('var(--color-swap)');
    expect(rows[0].querySelector('.server')).toBeNull();
  });

  it('respects showServer, maxLines and oldest-first', async () => {
    const fixture = await make({ showServer: true, maxLines: 2, newestFirst: false });
    const rows = Array.from(fixture.nativeElement.querySelectorAll('.line')) as HTMLElement[];
    expect(rows.length).toBe(2);
    expect(rows[0].querySelector('.msg')?.textContent).toBe('warned');
    const fixture2 = await make({ showServer: true });
    expect(fixture2.nativeElement.querySelector('.server')?.textContent).toBe('web-02');
  });
});
