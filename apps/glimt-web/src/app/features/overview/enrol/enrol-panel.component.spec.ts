import { TestBed } from '@angular/core/testing';
import { ApiError, ApiService } from '@core/api.service';
import { ClipboardService } from '@core/clipboard.service';
import { EnrolKey, EnrolPanelComponent, formatCountdown } from './enrol-panel.component';

function key(expiresInMs: number, dockerMode = 'proxy'): EnrolKey {
  const k = 'gp_8f3kQ2mLx9RtAbCdEfGhIj';
  return { key: k, command: `curl -fsSL http://localhost:5080/install | sh -s -- --key ${k} --docker ${dockerMode}`, expiresAt: new Date(Date.now() + expiresInMs).toISOString(), dockerMode };
}

describe('EnrolPanelComponent', () => {
  let api: { post: ReturnType<typeof vi.fn> };
  let clipboard: { copy: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    api = { post: vi.fn() };
    clipboard = { copy: vi.fn(() => Promise.resolve(true)) };
    await TestBed.configureTestingModule({
      imports: [EnrolPanelComponent],
      providers: [
        { provide: ApiService, useValue: api },
        { provide: ClipboardService, useValue: clipboard },
      ],
    }).compileComponents();
  });

  async function render() {
    const fixture = TestBed.createComponent(EnrolPanelComponent);
    await fixture.whenStable();
    await Promise.resolve();
    await fixture.whenStable();
    return { fixture, el: fixture.nativeElement as HTMLElement, cmp: fixture.componentInstance };
  }

  it('henter nøkkelen ved visning (Secure = proxy) og viser kommando, nedtelling, løfte og «venter»', async () => {
    api.post.mockResolvedValue(key(59 * 60_000 + 42_000));
    const { el } = await render();
    expect(api.post).toHaveBeenCalledWith('/servers/enrol-key', { dockerMode: 'proxy' });
    expect(el.querySelector('[data-testid="enrol-command"]')?.textContent?.trim()).toContain('--key gp_8f3kQ2mLx9RtAbCdEfGhIj --docker proxy');
    expect(el.querySelector('[data-testid="enrol-countdown"]')?.textContent).toMatch(/^59:4[0-2]$/);
    expect(el.textContent).toContain('The one-time key expires in');
    expect(el.textContent).toContain('It can never change anything on the server');
    expect(el.textContent).toContain('Waiting for the agent…');
    expect(el.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe('Secure (recommended)');
    expect(el.querySelector('.note')?.textContent).toContain('read-only proxy');
  });

  it('Docker-segmentet henter en ny nøkkel med det valget og bytter forklaringen', async () => {
    api.post.mockResolvedValueOnce(key(60_000)).mockResolvedValueOnce(key(60_000, 'simple'));
    const { el, fixture } = await render();
    (el.querySelectorAll('[role="radio"]')[1] as HTMLButtonElement).click();
    await fixture.whenStable();
    await Promise.resolve();
    await fixture.whenStable();
    expect(api.post).toHaveBeenLastCalledWith('/servers/enrol-key', { dockerMode: 'simple' });
    expect(el.querySelector('[data-testid="enrol-command"]')?.textContent).toContain('--docker simple');
    expect(el.querySelector('.note')?.textContent).toContain('directly from the Docker socket');
  });

  it('Copy kopierer kommandoen og viser «Copied»', async () => {
    api.post.mockResolvedValue(key(60_000));
    const { el, fixture } = await render();
    (el.querySelector('.copy') as HTMLButtonElement).click();
    await fixture.whenStable();
    await Promise.resolve();
    await fixture.whenStable();
    expect(clipboard.copy).toHaveBeenCalledWith(expect.stringContaining('curl -fsSL'));
    expect(el.querySelector('.copy')?.textContent).toBe('Copied');
  });

  it('utløpt nøkkel: melding og «New key» henter en ny', async () => {
    api.post.mockResolvedValueOnce(key(-1000)).mockResolvedValueOnce(key(60_000));
    const { el, fixture } = await render();
    expect(el.textContent).toContain('The key has expired');
    expect((el.querySelector('.copy') as HTMLButtonElement).disabled).toBe(true);
    (el.querySelector('.expired gp-button button') as HTMLButtonElement).click();
    await fixture.whenStable();
    await Promise.resolve();
    await fixture.whenStable();
    expect(api.post).toHaveBeenCalledTimes(2);
    expect(el.textContent).toContain('The one-time key expires in');
  });

  it('feil fra huben vises som ordbokstekst (e-post ikke bekreftet)', async () => {
    api.post.mockRejectedValue(new ApiError(403, 'emailNotConfirmed', 'Confirm your e-mail before adding servers'));
    const { el } = await render();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Confirm your e-mail first');
  });

  it('formatCountdown', () => {
    expect(formatCountdown(59 * 60_000 + 42_000)).toBe('59:42');
    expect(formatCountdown(5_000)).toBe('00:05');
    expect(formatCountdown(-5_000)).toBe('00:00');
    expect(formatCountdown(3_600_000 + 130_000)).toBe('1:02:10');
  });
});
