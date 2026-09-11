import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { formatTime } from '../util/format';

export type LogPriority = 'err' | 'warn' | 'info';

export interface LogLine {
  ts: number;
  unit?: string;
  container?: string;
  server?: string;
  priority?: LogPriority;
  message: string;
  /** Markør «n lines dropped» (steg 6.2): grå linje uten enhet. */
  dropped?: number;
}

export type UnitColor = Map<string, string> | ((unit: string) => string | undefined) | null;

/**
 * Loggboks (6.3): `--color-ink`, radius 8, `padding 10px 12px`, monospace 12 px, `line-height 1.6`. Linjer `flex; gap 10px`
 * med tid `--w-40`, enhet `--w-50` (eller containerfarge), melding i prioritetsfarge. Nyeste øverst. Enkel `@for` (maks 300).
 */
@Component({
  selector: 'gp-log-view',
  template: `
    <div class="box" role="log" [attr.aria-label]="label() || null">
      @for (l of shown(); track l.ts + ':' + $index) {
        @if (l.dropped) {
          <div class="line dropped"><span class="time num">{{ time(l.ts) }}</span><span class="msg">{{ l.dropped }} {{ droppedText() }}</span></div>
        } @else {
        <div class="line" [class]="'line ' + (l.priority ?? 'info')">
          <span class="time num">{{ time(l.ts) }}</span>
          @if (showServer() && l.server) {
            <span class="server">{{ l.server }}</span>
          }
          @if (l.unit || l.container; as u) {
            <span class="unit" [style.color]="unitColor(u)">{{ u }}</span>
          }
          <span class="msg">{{ l.message }}</span>
        </div>
        }
      } @empty {
        <div class="empty">{{ emptyText() }}</div>
      }
    </div>
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .box {
      display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border-radius: var(--radius-chip);
      background: var(--color-ink); font-family: var(--font-mono); font-size: 12px; line-height: 1.6; overflow: auto;
    }
    .line { display: flex; gap: 10px; word-break: break-word; color: var(--w-70); }
    .line.err { color: var(--color-crit); }
    .line.warn { color: var(--color-warn); }
    .line.dropped { color: var(--w-40); font-style: italic; }
    .time { flex: none; color: var(--w-40); }
    .server { flex: none; color: var(--w-60); }
    .unit { flex: none; color: var(--w-50); }
    .msg { min-width: 0; }
    .empty { color: var(--w-45); }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogViewComponent {
  readonly lines = input<LogLine[]>([]);
  readonly showServer = input(false);
  readonly colorByUnit = input<UnitColor>(null);
  readonly maxLines = input(300);
  readonly newestFirst = input(true);
  readonly timeZone = input<string | undefined>(undefined);
  readonly label = input('');
  readonly emptyText = input('No lines');
  readonly droppedText = input('lines dropped');

  readonly shown = computed(() => {
    const all = this.lines();
    const max = Math.max(0, this.maxLines());
    const sorted = [...all].sort((a, b) => (this.newestFirst() ? b.ts - a.ts : a.ts - b.ts));
    return sorted.slice(0, max);
  });

  time(ts: number): string {
    return formatTime(ts, { seconds: true, timeZone: this.timeZone() });
  }

  unitColor(unit: string): string | null {
    const c = this.colorByUnit();
    if (!c) return null;
    return (c instanceof Map ? c.get(unit) : c(unit)) ?? null;
  }
}
