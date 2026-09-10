import { afterNextRender, Directive, ElementRef, inject } from '@angular/core';

/** Fokuserer elementet når det rendres (feltet for ny tagg i «Legg til server»). */
@Directive({ selector: '[gpAutofocus]' })
export class AutofocusDirective {
  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    afterNextRender(() => el.focus());
  }
}
