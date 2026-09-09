import { ChangeDetectionStrategy, Component, input } from '@angular/core';

let seq = 0;

/** Logoen fra apps/glimt-site (6.3): 64×64 rx=14 gradient, spor r=16.5, tre buer blå/grønn/cyan. Størrelser 24, 28, 36, 56. */
@Component({
  selector: 'gp-logo',
  template: `
    <svg [attr.width]="size()" [attr.height]="size()" viewBox="0 0 64 64" [attr.aria-hidden]="label() ? null : 'true'" [attr.role]="label() ? 'img' : null" [attr.aria-label]="label() || null">
      <defs>
        <linearGradient [attr.id]="gid" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#3a3f4b" />
          <stop offset="1" stop-color="#23252b" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" [attr.fill]="'url(#' + gid + ')'" />
      <g fill="none" stroke-width="4.5" stroke-linecap="round" transform="rotate(-90 32 32)">
        <circle cx="32" cy="32" r="16.5" stroke="rgba(255,255,255,.14)" />
        <circle cx="32" cy="32" r="16.5" stroke="#0a84ff" stroke-dasharray="28 75.7" />
        <circle cx="32" cy="32" r="16.5" stroke="#30d158" stroke-dasharray="28 75.7" stroke-dashoffset="-34.6" />
        <circle cx="32" cy="32" r="16.5" stroke="#64d2ff" stroke-dasharray="28 75.7" stroke-dashoffset="-69.1" />
      </g>
    </svg>
  `,
  styles: `:host { display: inline-flex; flex: none; } svg { display: block; }`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogoComponent {
  readonly size = input<24 | 28 | 36 | 56>(28);
  readonly label = input('');
  readonly gid = `gp-logo-g${++seq}`;
}
