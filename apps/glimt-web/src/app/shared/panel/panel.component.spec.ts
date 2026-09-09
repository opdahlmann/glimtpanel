import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { PanelComponent } from './panel.component';

@Component({
  imports: [PanelComponent],
  template: `<gp-panel title="CPU" meta="48%" tone="cpu" panelId="cpu" [(open)]="open"><p class="content">body</p></gp-panel>`,
})
class HostComponent {
  readonly open = signal(true);
}

describe('gp-panel', () => {
  it('toggles aria-expanded, hides the body when closed and keeps aria-controls pointing at the body id', async () => {
    const fixture = TestBed.createComponent(HostComponent);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const head = el.querySelector('button.head') as HTMLButtonElement;
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(head.getAttribute('aria-controls')).toBe('cpu-body');
    expect(el.querySelector('#cpu-body')).not.toBeNull();
    expect(el.querySelector('.content')).not.toBeNull();
    expect(el.querySelector('gp-panel')?.id).toBe('cpu');
    expect(el.querySelector('gp-panel')?.classList.contains('tone-cpu')).toBe(true);

    head.click();
    await fixture.whenStable();
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('#cpu-body')).toBeNull();
    expect(el.querySelector('.content')).toBeNull();
    expect(fixture.componentInstance.open()).toBe(false);

    fixture.componentInstance.open.set(true);
    await fixture.whenStable();
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(el.querySelector('.content')).not.toBeNull();
  });
});
