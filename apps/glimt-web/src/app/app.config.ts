import {
  ApplicationConfig,
  ErrorHandler,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  isDevMode,
} from '@angular/core';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { ConfigService } from '@core/config.service';
import { GlobalErrorHandler } from '@core/error-handler';
import { SessionService } from '@core/session.service';
import { routes } from './app.routes';
import { provideServiceWorker } from '@angular/service-worker';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Uventede feil (steg 9.5): toast «Something went wrong · Reload» og POST /api/client-errors, begrenset.
    { provide: ErrorHandler, useClass: GlobalErrorHandler },
    // Ingen withViewTransitions: dekor står stille (6.7).
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withFetch()),
    // Henter /config.json før appen starter (standardverdier hvis den mangler), og starter deretter
    // sesjonens oppfriskning (cookie → /api/auth/me) uten å blokkere; guardene venter på `ready`.
    provideAppInitializer(() => {
      const config = inject(ConfigService);
      const session = inject(SessionService);
      return config.load().then(() => session.start());
    }),
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};
