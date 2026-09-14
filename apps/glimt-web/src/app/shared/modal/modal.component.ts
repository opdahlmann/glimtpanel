import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterRenderEffect, effect, inject, input, model, viewChild } from '@angular/core';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Dialog (6.3): overlegg `#0f1013b3` + `blur(8px)`, kort `--color-glass` radius 14 med vindusskygge, `padding 16px 14px 14px`,
 * rund lukkeknapp. Fokusfelle, Esc og klikk utenfor lukker, body-scroll låses. På mobil full bredde med 12 px marg og intern scroll.
 */
@Component({
  selector: 'gp-modal',
  templateUrl: './modal.component.html',
  styleUrl: './modal.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModalComponent {
  readonly open = model(false);
  readonly title = input('');
  readonly maxWidth = input<560 | 440>(560);
  readonly closeLabel = input('Close');
  /** Bunnark (fase 13, menyer på mobil): festes nederst med 44 px rader, ellers som vanlig dialog. */
  readonly sheet = input(false);

  private readonly card = viewChild<ElementRef<HTMLElement>>('card');
  private readonly doc = inject(DOCUMENT);
  private restoreFocus: HTMLElement | null = null;
  private lockedOverflow: string | null = null;

  constructor() {
    effect(() => {
      if (this.open()) this.lock();
      else this.unlock();
    });
    afterRenderEffect(() => {
      const el = this.card()?.nativeElement;
      if (this.open() && el && !el.contains(this.doc.activeElement)) {
        const first = el.querySelector<HTMLElement>(FOCUSABLE);
        (first ?? el).focus();
      }
    });
    inject(DestroyRef).onDestroy(() => this.unlock());
  }

  close(): void {
    this.open.set(false);
  }

  onOverlay(e: MouseEvent): void {
    if (e.target === e.currentTarget) this.close();
  }

  onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
      return;
    }
    if (e.key !== 'Tab') return;
    const el = this.card()?.nativeElement;
    if (!el) return;
    const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null || n === this.doc.activeElement);
    if (!items.length) {
      e.preventDefault();
      el.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = this.doc.activeElement;
    if (e.shiftKey && (active === first || active === el)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  private lock(): void {
    const body = this.doc.body;
    if (!body || this.lockedOverflow !== null) return;
    this.restoreFocus = this.doc.activeElement instanceof HTMLElement ? this.doc.activeElement : null;
    this.lockedOverflow = body.style.overflow;
    body.style.overflow = 'hidden';
  }

  private unlock(): void {
    const body = this.doc.body;
    if (!body || this.lockedOverflow === null) return;
    body.style.overflow = this.lockedOverflow;
    this.lockedOverflow = null;
    this.restoreFocus?.focus();
    this.restoreFocus = null;
  }
}
