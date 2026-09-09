import { TestBed } from '@angular/core/testing';
import { SegmentComponent } from './segment.component';

describe('gp-segment', () => {
  const options = [
    { value: '1h', label: '1 h' },
    { value: '24h', label: '24 h' },
    { value: '7d', label: '7 d' },
  ];

  async function make(value = '1h') {
    const fixture = TestBed.createComponent(SegmentComponent<string>);
    fixture.componentRef.setInput('options', options);
    fixture.componentRef.setInput('value', value);
    await fixture.whenStable();
    return fixture;
  }

  it('is a radiogroup where only the selected option is tabbable', async () => {
    const fixture = await make('24h');
    const group = fixture.nativeElement.querySelector('[role="radiogroup"]');
    expect(group).not.toBeNull();
    const radios = Array.from(fixture.nativeElement.querySelectorAll('[role="radio"]')) as HTMLButtonElement[];
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    expect(radios[1].classList.contains('on')).toBe(true);
  });

  it('ArrowRight moves the selection and updates the model; wraps around; ArrowLeft goes back', async () => {
    const fixture = await make('1h');
    const changes: string[] = [];
    fixture.componentInstance.value.subscribe((v) => changes.push(v ?? ''));
    const radios = () => Array.from(fixture.nativeElement.querySelectorAll('[role="radio"]')) as HTMLButtonElement[];

    radios()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await fixture.whenStable();
    expect(fixture.componentInstance.value()).toBe('24h');
    expect(document.activeElement).toBe(radios()[1]);

    radios()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    await fixture.whenStable();
    expect(fixture.componentInstance.value()).toBe('7d');

    radios()[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await fixture.whenStable();
    expect(fixture.componentInstance.value()).toBe('1h');

    radios()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await fixture.whenStable();
    expect(fixture.componentInstance.value()).toBe('7d');
    expect(changes).toEqual(['24h', '7d', '1h', '7d']);
  });

  it('click selects an option', async () => {
    const fixture = await make('1h');
    (fixture.nativeElement.querySelectorAll('[role="radio"]')[2] as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(fixture.componentInstance.value()).toBe('7d');
  });
});
