import { TestBed } from '@angular/core/testing';
import { BarComponent } from './bar.component';

describe('gp-bar', () => {
  it('renders one threshold-coloured fill by default', async () => {
    const fixture = TestBed.createComponent(BarComponent);
    fixture.componentRef.setInput('value', 92);
    fixture.componentRef.setInput('color', 'disk');
    await fixture.whenStable();
    const fill = fixture.nativeElement.querySelector('.fill') as HTMLElement;
    expect(fill.style.width).toBe('92%');
    expect(fill.style.background).toBe('var(--color-crit)');
    const track = fixture.nativeElement.querySelector('.track') as HTMLElement;
    expect(track.getAttribute('role')).toBe('progressbar');
    expect(track.getAttribute('aria-valuenow')).toBe('92');
    expect(track.classList.contains('h5')).toBe(true);
  });

  it('renders segments with their own colours and sums them for aria-valuenow', async () => {
    const fixture = TestBed.createComponent(BarComponent);
    fixture.componentRef.setInput('height', 8);
    fixture.componentRef.setInput('segments', [
      { value: 61, color: 'ram' },
      { value: 14, color: 'disk' },
    ]);
    await fixture.whenStable();
    const segs = Array.from(fixture.nativeElement.querySelectorAll('.seg')) as HTMLElement[];
    expect(segs.length).toBe(2);
    expect(segs[0].style.width).toBe('61%');
    expect(segs[0].style.background).toBe('var(--color-ram)');
    expect(segs[1].style.width).toBe('14%');
    expect(segs[1].style.background).toBe('var(--color-disk)');
    expect(fixture.nativeElement.querySelector('.fill')).toBeNull();
    expect(fixture.nativeElement.querySelector('.track').getAttribute('aria-valuenow')).toBe('75');
    expect(fixture.nativeElement.querySelector('.track').classList.contains('h8')).toBe(true);
  });
});
