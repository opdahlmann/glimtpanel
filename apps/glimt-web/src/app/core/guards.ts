import { CanActivateFn } from '@angular/router';

/**
 * Plassholdere til steg 3.6: authGuard sender uinnloggede til /login?next=, guestGuard sender innloggede til /,
 * devGuard slipper bare gjennom når config.env er development.
 */
export const authGuard: CanActivateFn = () => true; // TODO(3.6): SessionService.isAuthenticated() ? true : router.createUrlTree(['/login'], { queryParams: { next } })
export const guestGuard: CanActivateFn = () => true; // TODO(3.6)
export const ownerGuard: CanActivateFn = () => true; // TODO(3.6)
export const devGuard: CanActivateFn = () => true; // TODO(3.1): ConfigService.config().env === 'development'
