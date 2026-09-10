import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { ApiService } from '@core/api.service';
import { cardFromStatus } from '@core/live.store';
import { CardDto } from '@core/live.types';
import { ServerListService } from '@core/server-list.service';
import { AddServerDialogComponent, normalizeTag } from './add-server-dialog.component';

const GB = 1024 ** 3;

function newServer(): CardDto {
  return {
    ...cardFromStatus({ id: 'srv-1', name: 'web-03', hostname: 'web-03', status: 'up', lastSeenAt: null, connected: true, os: 'Ubuntu 24.04.3 LTS', cores: 2, ramBytes: 4 * GB }),
    versionId: '24.04',
  };
}

describe('AddServerDialogComponent', () => {
  let api: { post: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn> };
  let serverList: { load: ReturnType<typeof vi.fn>; loaded: ReturnType<typeof signal<boolean>>; servers: ReturnType<typeof signal<never[]>> };

  beforeEach(async () => {
    api = { post: vi.fn(() => new Promise(() => undefined)), patch: vi.fn() };
    serverList = { load: vi.fn(() => Promise.resolve([])), loaded: signal(true), servers: signal([]) };
    await TestBed.configureTestingModule({
      imports: [AddServerDialogComponent],
      providers: [provideRouter([]), { provide: ApiService, useValue: api }, { provide: ServerListService, useValue: serverList }],
    }).compileComponents();
  });

  async function render(step: 0 | 1 | 2, server: CardDto | null = newServer()) {
    const fixture = TestBed.createComponent(AddServerDialogComponent);
    fixture.componentRef.setInput('existingTags', ['prod', 'staging']);
    fixture.componentRef.setInput('server', server);
    fixture.componentInstance.step.set(step);
    fixture.componentInstance.open.set(true);
    await fixture.whenStable();
    return { fixture, cmp: fixture.componentInstance, dialog: document.querySelector('[role="dialog"]') as HTMLElement };
  }

  afterEach(() => {
    document.body.style.overflow = '';
  });

  it('trinn 0 viser innrulleringspanelet i en dialog på 560 px', async () => {
    const { dialog } = await render(0, null);
    expect(dialog.getAttribute('aria-label')).toBe('Add server');
    expect(dialog.style.maxWidth).toBe('560px');
    expect(dialog.querySelector('gp-enrol-panel')).not.toBeNull();
    expect(api.post).toHaveBeenCalledWith('/servers/enrol-key', { dockerMode: 'proxy' });
  });

  it('trinn 1: tilkoblet-kort, navn forhåndsutfylt, taggchips, «+» for ny tagg, Next lagrer med PATCH', async () => {
    api.patch.mockResolvedValue({ id: 'srv-1', name: 'web-03', tags: ['prod', 'client-c'], role: 'owner' });
    const { dialog, fixture, cmp } = await render(1);
    expect(dialog.querySelector('.connected .cname')?.textContent).toBe('web-03');
    expect(dialog.querySelector('.connected .cline')?.textContent).toBe('connected · Ubuntu 24.04 · 2 cores · 4 GB');
    expect((dialog.querySelector('gp-input input') as HTMLInputElement).value).toBe('web-03');
    const chips = () => [...dialog.querySelectorAll('.tag')].map((c) => c.textContent);
    expect(chips()).toEqual(['prod', 'staging', '+']);

    (dialog.querySelectorAll('.tag')[0] as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(dialog.querySelectorAll('.tag')[0].getAttribute('aria-pressed')).toBe('true');

    (dialog.querySelector('.tag.add') as HTMLButtonElement).click();
    await fixture.whenStable();
    const input = dialog.querySelector('.tag-input') as HTMLInputElement;
    expect(input).not.toBeNull();
    input.value = 'Bad Tag!';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await fixture.whenStable();
    expect(dialog.querySelector('.error')?.textContent).toContain('1–24 characters');
    input.value = 'client-c';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await fixture.whenStable();
    expect(chips()).toEqual(['prod', 'staging', 'client-c', '+']);
    expect(cmp.tags()).toEqual(['prod', 'client-c']);

    (dialog.querySelector('.foot gp-button button') as HTMLButtonElement).click();
    await fixture.whenStable();
    await Promise.resolve();
    await fixture.whenStable();
    expect(api.patch).toHaveBeenCalledWith('/servers/srv-1', { name: 'web-03', tags: ['prod', 'client-c'] });
    expect(serverList.load).toHaveBeenCalled();
    expect(cmp.step()).toBe(2);
    expect(dialog.textContent).toContain('Get alerts on your phone');
  });

  it('trinn 2: Done lukker (og nullstiller trinnet), Show me går til /welcome', async () => {
    const { dialog, fixture, cmp } = await render(2);
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const buttons = dialog.querySelectorAll('.foot gp-button button');
    expect([...buttons].map((b) => b.textContent?.trim())).toEqual(['Done', 'Show me']);
    (buttons[1] as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(navigate).toHaveBeenCalledWith(['/welcome']);
    expect(cmp.open()).toBe(false);
    expect(cmp.step()).toBe(0);
  });

  it('kan lukkes når som helst med Esc', async () => {
    const { dialog, fixture, cmp } = await render(1);
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await fixture.whenStable();
    expect(cmp.open()).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('normalizeTag følger hubens regel', () => {
    expect(normalizeTag(' Prod ')).toBe('prod');
    expect(normalizeTag('client-a')).toBe('client-a');
    expect(normalizeTag('bad tag')).toBeNull();
    expect(normalizeTag('x'.repeat(25))).toBeNull();
    expect(normalizeTag('')).toBeNull();
  });
});
