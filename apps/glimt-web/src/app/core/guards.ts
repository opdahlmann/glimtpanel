import { inject } from '@angular/core';
import { ActivatedRouteSnapshot, CanActivateFn, CanMatchFn, Router, RouterStateSnapshot, UrlSegment } from '@angular/router';
import { BreakpointService } from '@shared/util/breakpoint.service';
import { ConfigService } from './config.service';
import { PrefsService } from './prefs.service';
import { SessionService } from './session.service';

/** Stiene under AuthShellComponent. */
export const AUTH_PATHS = ['login', 'register', 'forgot', 'reset', 'confirm'];

/**
 * AuthShell-ruten har `path: ''` med barn; uten denne ville roten `/` matche den (Angular godtar en tom foreldresti
 * uten barn for rot-URL-en) og vise et tomt skall i stedet for oversikten.
 */
export const authShellMatch: CanMatchFn = (_route, segments: UrlSegment[]) => AUTH_PATHS.includes(segments[0]?.path ?? '');

/**
 * Venter på første oppfriskningsforsøk, og sender uinnloggede til `/login?next=<url>`. Første gang appen åpnes på mobil
 * etter innlogging går `/` til `/welcome` (skjerm 14), én gang per nettleser (`gp.welcomeSeen`, steg 7.5).
 */
export const authGuard: CanActivateFn = async (_route, state: RouterStateSnapshot) => {
  const session = inject(SessionService);
  const router = inject(Router);
  // inject() må skje før første await (injeksjonskonteksten varer bare synkront).
  const prefs = inject(PrefsService);
  const breakpoint = inject(BreakpointService);
  await session.whenReady();
  if (session.isAuthenticated()) {
    if ((state.url === '/' || state.url === '') && breakpoint.isMobile() && !prefs.welcomeSeen.value() && !session.demoMode()) {
      prefs.welcomeSeen.set(true);
      return router.createUrlTree(['/welcome']);
    }
    return true;
  }
  const next = state.url && state.url !== '/' ? state.url : null;
  return router.createUrlTree(['/login'], { queryParams: next ? { next } : {} });
};

/** Auth-sidene: innloggede sendes til `/` (eller `next`). */
export const guestGuard: CanActivateFn = async (route: ActivatedRouteSnapshot) => {
  const session = inject(SessionService);
  const router = inject(Router);
  await session.whenReady();
  if (!session.isAuthenticated()) return true;
  return router.parseUrl(safeNext(route.queryParamMap.get('next')));
};

/** Innstillinger og handlinger som krever eier av `:id` (rollekartet fra GET /api/servers). */
export const ownerGuard: CanActivateFn = async (route: ActivatedRouteSnapshot) => {
  const session = inject(SessionService);
  const router = inject(Router);
  await session.whenReady();
  const id = route.paramMap.get('id') ?? route.parent?.paramMap.get('id');
  if (session.isAuthenticated() && (id ? session.isOwnerOf(id) : session.ownsAnyServer())) return true;
  return router.createUrlTree(['/']);
};

/** `/dev/components`: kun `GLIMT_ENV=development` (og `e2e`, der Playwright fotograferer siden). */
export const devGuard: CanActivateFn = () => {
  const env = inject(ConfigService).config().env;
  return env === 'development' || env === 'e2e' ? true : inject(Router).createUrlTree(['/']);
};

/** Kun interne stier (ingen `//host` eller absolutte URL-er) slipper gjennom som `next`. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || /^\/[\\@]/.test(next)) return '/';
  return next;
}
