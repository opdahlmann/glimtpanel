import { DestroyRef, Injectable, WritableSignal, inject, signal } from '@angular/core';

/** Mobilbreakpointet 760 px målt på rot-elementets bredde med ResizeObserver, ikke på vinduet (IMPLEMENTERINGSPLAN 6.2). */
export const MOBILE_BREAKPOINT = 760;

@Injectable({ providedIn: 'root' })
export class BreakpointService {
  readonly isMobile = signal(measureRoot() < MOBILE_BREAKPOINT);

  constructor() {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const destroyRef = inject(DestroyRef);
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver((entries) => this.set(entries[0]?.contentRect.width ?? root.clientWidth));
      ro.observe(root);
      destroyRef.onDestroy(() => ro.disconnect());
    } else if (typeof window !== 'undefined') {
      const onResize = () => this.set(measureRoot());
      window.addEventListener('resize', onResize);
      destroyRef.onDestroy(() => window.removeEventListener('resize', onResize));
    }
  }

  private set(w: number): void {
    if (w > 0) this.isMobile.set(w < MOBILE_BREAKPOINT);
  }
}

function measureRoot(): number {
  if (typeof document === 'undefined') return MOBILE_BREAKPOINT;
  const w = document.documentElement.clientWidth;
  return w > 0 ? w : typeof window !== 'undefined' ? window.innerWidth : MOBILE_BREAKPOINT;
}

/**
 * Observerer bredden til ett element (< 760 = mobil). gp-data-grid måler seg selv med denne, ikke vinduet.
 * Uten ResizeObserver (jsdom) brukes rot-bredden én gang.
 */
export function observeMobile(el: HTMLElement, destroyRef: DestroyRef): WritableSignal<boolean> {
  const w0 = el.getBoundingClientRect().width;
  const s = signal((w0 > 0 ? w0 : measureRoot()) < MOBILE_BREAKPOINT);
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) s.set(w < MOBILE_BREAKPOINT);
    });
    ro.observe(el);
    destroyRef.onDestroy(() => ro.disconnect());
  }
  return s;
}
