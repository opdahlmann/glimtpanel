import { TestBed } from '@angular/core/testing';
import { RingComponent, ringDash } from './ring.component';

describe('gp-ring', () => {
  async function make(value: number, extra: Partial<{ color: string; threshold: boolean; label: string; sub: string }> = {}) {
    const fixture = TestBed.createComponent(RingComponent);
    fixture.componentRef.setInput('value', value);
    fixture.componentRef.setInput('label', extra.label ?? 'CPU');
    fixture.componentRef.setInput('sub', extra.sub ?? '1.9 of 4 cores');
    if (extra.color) fixture.componentRef.setInput('color', extra.color);
    if (extra.threshold !== undefined) fixture.componentRef.setInput('threshold', extra.threshold);
    await fixture.whenStable();
    return fixture;
  }

  it('computes the dasharray exactly like the prototype (value/100 × 201.06)', async () => {
    expect(ringDash(48)).toBe('96.5 201.06');
    expect(ringDash(0)).toBe('0.0 201.06');
    expect(ringDash(100)).toBe('201.1 201.06');
    expect(ringDash(140)).toBe('201.1 201.06');
    const fixture = await make(48);
    const fill = fixture.nativeElement.querySelector('circle.fill') as SVGCircleElement;
    expect(fill.getAttribute('stroke-dasharray')).toBe('96.5 201.06');
  });

  it('uses the metric colour below 80 and switches to warn at 80 and crit at 90', async () => {
    const stroke = (f: Awaited<ReturnType<typeof make>>) => f.nativeElement.querySelector('circle.fill').getAttribute('stroke');
    expect(stroke(await make(79, { color: 'disk' }))).toBe('var(--color-disk)');
    expect(stroke(await make(80, { color: 'disk' }))).toBe('var(--color-warn)');
    expect(stroke(await make(90, { color: 'disk' }))).toBe('var(--color-crit)');
    expect(stroke(await make(95, { color: 'disk', threshold: false }))).toBe('var(--color-disk)');
    expect(stroke(await make(10, { color: '#123456' }))).toBe('#123456');
  });

  it('renders a 76×76 SVG inside a button with a readable aria-label', async () => {
    const fixture = await make(48);
    const btn = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(btn.getAttribute('aria-label')).toBe('CPU 48 percent, 1.9 of 4 cores');
    const svg = fixture.nativeElement.querySelector('svg') as SVGElement;
    expect(svg.getAttribute('width')).toBe('76');
    expect(svg.querySelector('circle')?.getAttribute('r')).toBe('32');
    expect(fixture.nativeElement.querySelector('.val').textContent).toContain('48');
  });
});
