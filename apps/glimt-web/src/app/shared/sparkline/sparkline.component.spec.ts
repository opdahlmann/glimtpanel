import { TestBed } from '@angular/core/testing';
import { SparklineComponent, sparkPath } from './sparkline.component';

/** Prototypens sparkPath, ordrett fra glimtData.js. */
function protoSparkPath(arr: number[], w = 100, h = 24): string {
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
  const n = arr.length;
  if (n < 2) return '';
  return arr.map((v, i) => `${i ? 'L' : 'M'}${((i / (n - 1)) * w).toFixed(1)},${(h - (clamp(v, 0, 100) / 100) * (h - 2) - 1).toFixed(1)}`).join(' ');
}

describe('gp-sparkline', () => {
  const series = [12, 40, 55.5, 99, 0, 120, -5, 33, 70, 48];

  it('builds the same path as the prototype formula', () => {
    expect(sparkPath(series)).toBe(protoSparkPath(series));
    expect(sparkPath(series)).toBe('M0.0,20.4 L11.1,14.2 L22.2,10.8 L33.3,1.2 L44.4,23.0 L55.6,1.0 L66.7,23.0 L77.8,15.7 L88.9,7.6 L100.0,12.4');
    expect(sparkPath([5])).toBe('');
    expect(sparkPath([0, 100], 100, 20)).toBe('M0.0,19.0 L100.0,1.0');
  });

  it('renders a non-scaling 1.5 px stroke in the metric colour at 60 %', async () => {
    const fixture = TestBed.createComponent(SparklineComponent);
    fixture.componentRef.setInput('values', series);
    fixture.componentRef.setInput('color', '#0a84ff');
    await fixture.whenStable();
    const path = fixture.nativeElement.querySelector('path') as SVGPathElement;
    expect(path.getAttribute('d')).toBe(protoSparkPath(series));
    expect(path.getAttribute('stroke')).toBe('#0a84ff99');
    expect(path.getAttribute('stroke-width')).toBe('1.5');
    expect(path.getAttribute('vector-effect')).toBe('non-scaling-stroke');
    expect(fixture.nativeElement.querySelector('svg').getAttribute('viewBox')).toBe('0 0 100 24');
    expect(fixture.nativeElement.querySelector('svg').getAttribute('aria-hidden')).toBe('true');
  });
});
