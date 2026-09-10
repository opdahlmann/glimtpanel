import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { LiveStore } from '@core/live.store';
import { PrefsService } from '@core/prefs.service';
import { demoCardByName } from '../overview.fixtures';
import { ServerCardComponent } from './server-card.component';

function clearStorage(): void {
  try {
    globalThis.localStorage?.clear();
  } catch {
    // ingen lagring
  }
}

describe('ServerCardComponent', () => {
  let store: LiveStore;

  beforeEach(async () => {
    clearStorage();
    await TestBed.configureTestingModule({ imports: [ServerCardComponent], providers: [provideRouter([])] }).compileComponents();
    store = TestBed.inject(LiveStore);
    store.applyCard(demoCardByName('web-02'));
    store.applyCard(demoCardByName('nordic-db'));
  });

  async function render(id: string) {
    const fixture = TestBed.createComponent(ServerCardComponent);
    fixture.componentRef.setInput('id', id);
    await fixture.whenStable();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('viser tagger, navn, status, infolinje, tre ringer, fem chips og to sparklines', async () => {
    const { el } = await render('demo-web-02');
    expect(el.getAttribute('aria-label')).toBe('web-02: live, CPU 48%, Memory 61%, Disk 92%');
    expect(el.getAttribute('data-status')).toBe('up');
    expect(el.getAttribute('tabindex')).toBe('0');
    expect(el.classList.contains('dim')).toBe(false);
    expect(el.querySelector('gp-badge')?.textContent).toBe('prod');
    expect(el.querySelector('.name')?.textContent).toBe('web-02');
    expect(el.querySelector('.status')?.textContent?.trim()).toBe('live');
    expect(el.querySelector('.info')?.textContent).toBe('Ubuntu 24.04 · 4 cores · 8 GB · up 41d 4h');
    const rings = el.querySelectorAll('gp-ring');
    expect(rings.length).toBe(3);
    expect(rings[0].querySelector('.val')?.textContent).toBe('48%');
    expect(rings[2].querySelector('.val')?.textContent).toBe('92%');
    expect(rings[2].querySelector('.sub')?.textContent).toBe('/ 92%');
    const chips = [...el.querySelectorAll('gp-chip')].map((c) => c.querySelector('.value')?.textContent?.trim());
    expect(chips).toEqual(['↓15.8 ↑1.2', '6 / 6', '7 (2)', '—', 'ok']);
    expect(el.querySelectorAll('gp-sparkline').length).toBe(2);
    expect(el.querySelector('gp-sparkline path')?.getAttribute('d')).toContain('M0');
    expect((el.querySelector('.stripe') as HTMLElement).style.background).toBe('var(--color-crit)');
  });

  it('nede: opasitet, «last seen», ringer på 0', async () => {
    const { el } = await render('demo-nordic-db');
    expect(el.classList.contains('dim')).toBe(true);
    expect(el.getAttribute('data-status')).toBe('down');
    expect(el.querySelector('.status')?.textContent).toContain('last seen');
    expect(el.querySelector('.status--down')).not.toBeNull();
    expect([...el.querySelectorAll('gp-ring .val')].map((v) => v.textContent)).toEqual(['0%', '0%', '0%']);
    expect(el.querySelector('gp-chip .value')?.textContent?.trim()).toBe('—');
  });

  it('navnet åpner serversiden, ringene åpner panelet som fragment, Enter på kortet åpner', async () => {
    const { el } = await render('demo-web-02');
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    (el.querySelector('.name') as HTMLButtonElement).click();
    expect(navigate).toHaveBeenLastCalledWith(['/servers', 'demo-web-02']);
    (el.querySelectorAll('gp-ring button')[1] as HTMLButtonElement).click();
    expect(navigate).toHaveBeenLastCalledWith(['/servers', 'demo-web-02'], { fragment: 'mem' });
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(navigate).toHaveBeenCalledTimes(3);
  });

  it('sparklines kan slås av i PrefsService', async () => {
    TestBed.inject(PrefsService).sparklines.set(false);
    const { el } = await render('demo-web-02');
    expect(el.querySelectorAll('gp-sparkline').length).toBe(0);
  });

  it('fryser det som tegnes når kortet er utenfor skjermen, og tar igjen når det blir synlig', async () => {
    const { fixture, el } = await render('demo-web-02');
    fixture.componentInstance.visible.set(false);
    store.applyCard({ ...demoCardByName('web-02'), cpu: 77 });
    await fixture.whenStable();
    expect(el.querySelector('gp-ring .val')?.textContent).toBe('48%');
    expect(store.card('demo-web-02')()?.cpu).toBe(77);
    fixture.componentInstance.visible.set(true);
    await fixture.whenStable();
    expect(el.querySelector('gp-ring .val')?.textContent).toBe('77%');
  });
});
