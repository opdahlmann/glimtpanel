import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { I18nService } from '@core/i18n.service';
import { isLang } from '@core/i18n.service';
import { SegmentComponent, SegmentOption } from '@shared/segment/segment.component';

/** EN / NO-segmentet (steg 3.2 «midlertidig knapp»; flyttes til innstillingene i fase 8, men blir i topplinjen). */
@Component({
  selector: 'gp-lang-switch',
  imports: [SegmentComponent],
  template: `<gp-segment [options]="options" [value]="i18n.lang()" (valueChange)="set($event)" [size]="size()" [label]="label()" />`,
  styles: `:host { display: inline-flex; }`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LangSwitchComponent {
  readonly i18n = inject(I18nService);
  readonly size = input<'sm' | 'md'>('sm');
  readonly options: SegmentOption[] = [
    { value: 'en', label: 'EN' },
    { value: 'no', label: 'NO' },
  ];
  readonly label = computed(() => this.i18n.t('language'));

  set(v: string | null): void {
    if (isLang(v)) this.i18n.setLang(v);
  }
}
