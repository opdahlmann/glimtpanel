import { inject, Pipe, PipeTransform } from '@angular/core';
import { I18nKey, I18nService } from './i18n.service';

/**
 * `{{ 'servers' | t }}`. Uren slik at språkbytte oppdaterer malene; oppslaget er et Map-oppslag i et signal,
 * så kostnaden er ubetydelig ved denne størrelsen. Nøkkelen er typet mot en.json.
 */
@Pipe({ name: 't', pure: false })
export class TPipe implements PipeTransform {
  private readonly i18n = inject(I18nService);

  transform(key: I18nKey | null | undefined): string {
    return key ? this.i18n.t(key) : '';
  }
}
