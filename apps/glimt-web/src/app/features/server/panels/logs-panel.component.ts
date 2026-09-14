import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { ActivityService } from '@core/activity.service';
import { I18nService } from '@core/i18n.service';
import { LiveService } from '@core/live.service';
import { LogLineDto, LogRequest, NodeKind } from '@core/live.types';
import { ButtonComponent } from '@shared/button/button.component';
import { LogLine, LogViewComponent } from '@shared/log-view/log-view.component';

/** Antall linjer i panelet (steg 5.12). */
export const LOG_PANEL_TAIL = 10;

/** Hubens `priority` («err», «warn», «info» eller tom) → loggboksens. */
export function toLogLine(l: LogLineDto): LogLine {
  const p = l.priority === 'err' || l.priority === 'warn' ? l.priority : 'info';
  return { ts: l.ts, unit: l.unit ?? undefined, container: l.container ?? undefined, priority: p, message: l.message };
}

/** Kildene i containernodens loggpanel (steg 12.9): én chip per fil fra GLIMT_LOG_PATHS og «stdout (via host)» når lenket. */
export const STDOUT_SOURCE = 'stdout';

/**
 * Loggpanelet (steg 5.12): starter en `journal`-strøm med `tail: 10` når panelet er åpent og fanen synlig, stopper
 * når det lukkes eller siden forlates. Gjenstartes selv etter «hidden» og gjenoppkobling; en strøm huben avslutter
 * (agenten borte) vises som avsluttet. For containernoder (steg 12.9) velger chips mellom filene i `logPaths`
 * (`source: file`) og stdout gjennom verten (`source: container`); uten begge vises et hint.
 */
@Component({
  selector: 'gp-logs-panel',
  imports: [LogViewComponent, ButtonComponent],
  template: `
    @if (down()) {
      <div class="empty">{{ i18n.t('notAvailableDown') }}</div>
    } @else {
      @if (kind() === 'container') {
        <div class="chips" role="group" [attr.aria-label]="i18n.t('logs')" data-testid="log-sources">
          @for (p of logPaths(); track p) {
            <button type="button" class="chip mono" [class.on]="selected() === p" [attr.aria-pressed]="selected() === p" (click)="select(p)">{{ p }}</button>
          }
          @if (linked()) {
            <button type="button" class="chip" [class.on]="selected() === STDOUT" [attr.aria-pressed]="selected() === STDOUT" (click)="select(STDOUT)">{{ i18n.t('stdoutViaHost') }}</button>
          }
        </div>
      }
      @if (request(); as req) {
        <gp-log-view [lines]="lines()" [maxLines]="tail" [timeZone]="timeZone()" [label]="i18n.t('logs')" [emptyText]="ended() ? i18n.t('logEnded') : i18n.t('loading')" />
        <gp-button variant="ghost" size="md" class="open" (click)="openFull(req)">{{ i18n.t('openLogs') }}</gp-button>
      } @else {
        <div class="empty">{{ i18n.t(linked() ? 'chooseContainers' : 'noLogPaths') }}</div>
      }
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
    .open { align-self: flex-start; }
    .empty { font-size: 12px; color: var(--w-45); padding: 6px 2px; }
    .chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .chip {
      display: inline-flex; align-items: center; min-height: 32px; padding: 0 12px; border-radius: var(--radius-pill); border: 1px solid var(--s-14);
      background: transparent; color: var(--w-60); font-size: 11px; font-weight: 600; cursor: pointer; max-width: 100%; overflow: hidden; text-overflow: ellipsis;
      transition: background var(--t-hover), color var(--t-hover), border-color var(--t-hover);
    }
    .chip:hover { color: var(--w-85); background: var(--s-5); }
    .chip.on { background: var(--w-100); color: var(--color-ink); border-color: var(--w-100); }
    .mono { font-family: var(--font-mono); font-weight: 400; }
    @media (pointer: coarse) { .chip { min-height: 44px; } }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogsPanelComponent {
  readonly serverId = input.required<string>();
  readonly down = input(false);
  readonly kind = input<NodeKind>('server');
  readonly logPaths = input<string[]>([]);
  readonly linked = input(false);
  readonly i18n = inject(I18nService);
  private readonly live = inject(LiveService);
  private readonly activity = inject(ActivityService);
  private readonly router = inject(Router);

  readonly tail = LOG_PANEL_TAIL;
  readonly STDOUT = STDOUT_SOURCE;
  readonly lines = signal<LogLine[]>([]);
  readonly ended = signal(false);
  readonly timeZone = computed(() => this.i18n.timeZone() ?? undefined);
  /** Valgt chip (containernoder): en sti, eller stdout. */
  readonly chosen = signal<string | null>(null);
  readonly selected = computed(() => {
    if (this.kind() !== 'container') return null;
    const c = this.chosen();
    if (c === STDOUT_SOURCE && this.linked()) return c;
    if (c && this.logPaths().includes(c)) return c;
    return this.logPaths()[0] ?? (this.linked() ? STDOUT_SOURCE : null);
  });
  /** Strømmen panelet ber om; null når containernoden verken har filer eller vert. */
  readonly request = computed<LogRequest | null>(() => {
    const serverId = this.serverId();
    if (this.kind() !== 'container') return { serverId, source: 'journal', tail: LOG_PANEL_TAIL };
    const sel = this.selected();
    if (sel === null) return null;
    return sel === STDOUT_SOURCE ? { serverId, source: 'container', tail: LOG_PANEL_TAIL } : { serverId, source: 'file', path: sel, tail: LOG_PANEL_TAIL };
  });

  private streamId: string | null = null;
  private starting = false;
  private seq = 0;

  constructor() {
    effect(() => {
      const req = this.request();
      const want = req !== null && !this.down() && this.activity.mode() !== 'hidden' && this.live.state() === 'connected';
      untracked(() => {
        this.stop();
        this.lines.set([]);
        if (want && req) void this.start(req);
      });
    });
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  select(source: string): void {
    this.chosen.set(source);
  }

  private async start(req: LogRequest): Promise<void> {
    if (this.streamId || this.starting) return;
    this.starting = true;
    const seq = ++this.seq;
    this.ended.set(false);
    try {
      const streamId = await this.live.startLog(req, {
        lines: (lines) => this.lines.update((prev) => [...lines.map(toLogLine), ...prev].slice(0, LOG_PANEL_TAIL * 3)),
        ended: (reason) => {
          this.streamId = null;
          // Klientsidige avbrudd (skjult fane, gjenoppkobling) startes på nytt av effekten; hubens avslutning vises.
          if (reason !== 'hidden' && reason !== 'reconnecting' && reason !== 'disconnected') this.ended.set(true);
        },
      });
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

  openFull(req: LogRequest): void {
    const queryParams: Record<string, string> = { server: this.serverId() };
    if (req.source === 'file' && req.path) {
      queryParams['source'] = 'file';
      queryParams['path'] = req.path;
    } else if (req.source === 'container') {
      queryParams['source'] = 'container';
    }
    void this.router.navigate(['/logs'], { queryParams });
  }
}
