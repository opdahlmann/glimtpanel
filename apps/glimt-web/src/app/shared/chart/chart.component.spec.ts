import { TestBed } from '@angular/core/testing';
import { ChartComponent, chartPaths, downsample } from './chart.component';

describe('gp-chart', () => {
  it('downsamples to at most 600 points by averaging buckets and keeps all-null buckets as gaps', () => {
    const big = Array.from({ length: 3000 }, (_, i) => (i >= 1000 && i < 1010 ? null : i % 100));
    const out = downsample(big);
    expect(out.length).toBe(600);
    expect(out[0]).toBe((0 + 1 + 2 + 3 + 4) / 5);
    expect(out[200]).toBeNull();
    expect(out.filter((v) => v === null).length).toBe(2);
    expect(downsample([1, 2, 3])).toEqual([1, 2, 3]);
    expect(downsample([1, null, 3, 4], 2)).toEqual([1, 3.5]);
  });

  it('breaks the line and the fill at nulls', () => {
    const { line, fill } = chartPaths([50, null, 50, 100], 100, 120);
    expect(line).toBe('M0.0,60.0 M400.0,60.0 L600.0,2.0');
    expect(fill).toBe('M0.0,120 L0.0,60.0 L0.0,120 Z M400.0,120 L400.0,60.0 L600.0,2.0 L600.0,120 Z');
    expect(chartPaths([1], 100, 120).line).toBe('');
  });

  it('exposes min/max/last in the aria-label, five ticks and a hover chip with HH:mm', async () => {
    const fixture = TestBed.createComponent(ChartComponent);
    fixture.componentRef.setInput('series', [10, 20, null, 40, 30]);
    fixture.componentRef.setInput('from', Date.UTC(2026, 8, 10, 6, 0));
    fixture.componentRef.setInput('stepMs', 60_000);
    fixture.componentRef.setInput('timeZone', 'Europe/Oslo');
    fixture.componentRef.setInput('label', 'CPU');
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.plot')?.getAttribute('aria-label')).toBe('CPU min 10%, max 40%, last 30%');
    const ticks = Array.from(el.querySelectorAll('.ticks span')).map((s) => s.textContent);
    expect(ticks).toEqual(['08:00', '08:01', '08:02', '08:03', '08:04']);
    expect(el.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 600 120');
    expect(el.querySelector('path')?.getAttribute('fill')).toBe('color-mix(in srgb, var(--color-cpu) 8%, transparent)');

    fixture.componentInstance.hoverIdx.set(3);
    await fixture.whenStable();
    expect(el.querySelector('.chip b')?.textContent).toBe('40%');
    expect(el.querySelector('.chip span')?.textContent).toBe('08:03');
    expect((el.querySelector('.hair') as HTMLElement).style.left).toBe('75%');
    fixture.componentInstance.leave();
    await fixture.whenStable();
    expect(el.querySelector('.chip')).toBeNull();
  });
});
