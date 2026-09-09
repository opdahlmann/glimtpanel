import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { ApiError } from '@core/api.service';
import { SessionService } from '@core/session.service';
import { LoginPage } from './login.page';

/** jsdom uten opprinnelse har ikke alltid localStorage; PrefsService tåler det, og testene skal ikke lekke valg. */
function clearStorage(): void {
  try {
    globalThis.localStorage?.clear();
  } catch {
    // ingen lagring
  }
}

describe('LoginPage', () => {
  let session: { login: ReturnType<typeof vi.fn>; resendConfirmation: ReturnType<typeof vi.fn> };
  let router: Router;

  beforeEach(async () => {
    clearStorage();
    session = { login: vi.fn(), resendConfirmation: vi.fn().mockResolvedValue(undefined) };
    await TestBed.configureTestingModule({
      imports: [LoginPage],
      providers: [provideRouter([]), { provide: SessionService, useValue: session }],
    }).compileComponents();
    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
  });

  function create() {
    const fixture = TestBed.createComponent(LoginPage);
    fixture.detectChanges();
    return fixture;
  }

  function setInput(el: HTMLElement, name: string, value: string): void {
    const input = el.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    if (!input) throw new Error(`fant ikke feltet ${name}`);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
  }

  it('rendrer kortet med segment, e-post, passord, Sign in og Forgot password?', () => {
    const el = create().nativeElement as HTMLElement;
    expect(el.querySelector('h1')?.textContent).toBe('Glimtpanel');
    expect(el.querySelectorAll('gp-segment [role="radio"]').length).toBe(2);
    expect(el.querySelector('input[type="email"]')).not.toBeNull();
    expect(el.querySelector('input[type="password"]')).not.toBeNull();
    expect(el.querySelector('button[type="submit"]')?.textContent?.trim()).toBe('Sign in');
    expect(el.querySelector('a.forgot')?.textContent?.trim()).toBe('Forgot password?');
    expect(el.textContent).toContain('Free in beta');
  });

  it('viser valideringsfeil fra ordboken ved innsending av tomt skjema, uten å kalle login', async () => {
    const fixture = create();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector('form')?.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    fixture.detectChanges();
    const errors = [...el.querySelectorAll('gp-input .error')].map((e) => e.textContent?.trim());
    expect(errors).toEqual(['Enter a valid e-mail address', 'At least 10 characters']);
    expect(session.login).not.toHaveBeenCalled();
  });

  it('viser feil for ugyldig e-post og kort passord etter blur', async () => {
    const fixture = create();
    const el = fixture.nativeElement as HTMLElement;
    setInput(el, 'email', 'not-an-email');
    setInput(el, 'password', 'short');
    await fixture.whenStable();
    fixture.detectChanges();
    const errors = [...el.querySelectorAll('gp-input .error')].map((e) => e.textContent?.trim());
    expect(errors).toEqual(['Enter a valid e-mail address', 'At least 10 characters']);
  });

  it('gyldig skjema logger inn og navigerer til next', async () => {
    session.login.mockResolvedValue({});
    const fixture = create();
    fixture.componentRef.setInput('next', '/servers/a');
    const el = fixture.nativeElement as HTMLElement;
    setInput(el, 'email', 'dev@glimtpanel.local');
    setInput(el, 'password', 'GlimtDev-2026!');
    el.querySelector('form')?.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    expect(session.login).toHaveBeenCalledWith('dev@glimtpanel.local', 'GlimtDev-2026!');
    expect(router.navigateByUrl).toHaveBeenCalledWith('/servers/a');
  });

  it('401 viser «Wrong e-mail or password», 403 emailNotConfirmed viser knappen Send again', async () => {
    session.login.mockRejectedValueOnce(new ApiError(401, undefined, 'Unauthorized'));
    const fixture = create();
    const el = fixture.nativeElement as HTMLElement;
    setInput(el, 'email', 'dev@glimtpanel.local');
    setInput(el, 'password', 'wrong-password-1');
    el.querySelector('form')?.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('.err')?.textContent).toContain('Wrong e-mail or password');
    expect(el.querySelector('.err button')).toBeNull();

    session.login.mockRejectedValueOnce(new ApiError(403, 'emailNotConfirmed'));
    el.querySelector('form')?.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('.err')?.textContent).toContain('Confirm your e-mail first');
    const resend = el.querySelector<HTMLButtonElement>('.err button');
    expect(resend?.textContent?.trim()).toBe('Send again');
    resend?.click();
    await fixture.whenStable();
    expect(session.resendConfirmation).toHaveBeenCalledWith('dev@glimtpanel.local');
  });
});
