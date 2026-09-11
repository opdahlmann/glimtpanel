import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { ActivityService } from '@core/activity.service';
import { I18nService } from '@core/i18n.service';
import { LiveService } from '@core/live.service';
import { LogLineDto } from '@core/live.types';
import { ButtonComponent } from '@shared/button/button.component';
import { LogLine, LogViewComponent } from '@shared/log-view/log-view.component';

/** Antall linjer i panelet (steg 5.12). */
export const LOG_PANEL_TAIL = 10;

/** Hubens `priority` («err», «warn», «info» eller tom) → loggboksens. */
export function toLogLine(l: LogLineDto): LogLine {
  const p = l.priority === 'err' || l.priority === 'warn' ? l.priority : 'info';
  return { ts: l.ts, unit: l.unit ?? undefined, container: l.container ?? undefined, priority: p, message: l.message };
}

/**
 * Loggpanelet (steg 5.12): starter en `journal`-strøm med `tail: 10` når panelet er åpent og fanen synlig, stopper
 * når det lukkes eller siden forlates. Gjenstartes selv etter «hidden» og gjenoppkobling; en strøm huben avslutter
 * (agenten borte) vises som avsluttet.
 */
@Component({
  selector: 'gp-logs-panel',
  imports: [LogViewComponent, ButtonComponent],
  template: `
    @if (down()) {
      <div class="empty">{{ i18n.t('notAvailableDown') }}</div>
    } @else {
      <gp-log-view [lines]="lines()" [maxLines]="tail" [timeZone]="timeZone()" [label]="i18n.t('logs')" [emptyText]="ended() ? i18n.t('logEnded') : i18n.t('loading')" />
      <gp-button variant="ghost" size="md" class="open" (click)="openFull()">{{ i18n.t('openLogs') }}</gp-button>
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
    .open { align-self: flex-start; }
    .empty { font-size: 12px; color: var(--w-45); padding: 6px 2px; }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogsPanelComponent {
  readonly serverId = input.required<string>();
  readonly down = input(false);
  readonly i18n = inject(I18nService);
  private readonly live = inject(LiveService);
  private readonly activity = inject(ActivityService);
  private readonly router = inject(Router);

  readonly tail = LOG_PANEL_TAIL;
  readonly lines = signal<LogLine[]>([]);
  readonly ended = signal(false);
  readonly timeZone = computed(() => this.i18n.timeZone() ?? undefined);

  private streamId: string | null = null;
  private starting = false;
  private seq = 0;

  constructor() {
    effect(() => {
      const id = this.serverId();
      const want = !this.down() && this.activity.mode() !== 'hidden' && this.live.state() === 'connected';
      untracked(() => (want ? this.start(id) : this.stop()));
    });
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  private async start(serverId: string): Promise<void> {
    if (this.streamId || this.starting) return;
    this.starting = true;
    const seq = ++this.seq;
    this.ended.set(false);
    try {
      const streamId = await this.live.startLog(
        { serverId, source: 'journal', tail: LOG_PANEL_TAIL },
        {
          lines: (lines) => this.lines.update((prev) => [...lines.map(toLogLine), ...prev].slice(0, LOG_PANEL_TAIL * 3)),
          ended: (reason) => {
            this.streamId = null;
            // Klientsidige avbrudd (skjult fane, gjenoppkobling) startes på nytt av effekten; hubens avslutning vises.
            if (reason !== 'hidden' && reason !== 'reconnecting' && reason !== 'disconnected') this.ended.set(true);
          },
        },
      );
      if (seq !== this.seq) {
        void this.live.stopLog(streamId);
        return;
      }
      this.streamId = streamId;
    } catch (err) {
      console.warn('[logs-panel] could not start the stream', err);
    } finally {
      this.starting = false;
    }
  }

  private stop(): void {
    this.seq++;
    const id = this.streamId;
    this.streamId = null;
    if (id) void this.live.stopLog(id);
  }

  openFull(): void {
    void this.router.navigate(['/logs'], { queryParams: { server: this.serverId() } });
  }
}
