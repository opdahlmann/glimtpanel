import { computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { I18nService } from '@core/i18n.service';
import { SegmentOption } from '@shared/segment/segment.component';

export type AuthMode = 'login' | 'register';

/** Segmentet «Sign in / Create account» øverst i kortet: bytter rute uten omlasting og beholder `?next=`. */
export function authSegment(): { options: ReturnType<typeof computed<SegmentOption<AuthMode>[]>>; go: (v: AuthMode | null) => void } {
  const i18n = inject(I18nService);
  const router = inject(Router);
  return {
    options: computed<SegmentOption<AuthMode>[]>(() => [
      { value: 'login', label: i18n.t('signIn') },
      { value: 'register', label: i18n.t('createAcc') },
    ]),
    go: (v) => {
      if (v) void router.navigate([v === 'login' ? '/login' : '/register'], { queryParamsHandling: 'preserve' });
    },
  };
}
