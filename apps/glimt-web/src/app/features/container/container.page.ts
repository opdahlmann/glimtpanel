import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ActivityService } from '@core/activity.service';
import { ApiError, ApiService } from '@core/api.service';
import { I18nService } from '@core/i18n.service';
import { LiveService } from '@core/live.service';
import { LiveStore } from '@core/live.store';
import { ContainerInfo, ServerDto } from '@core/live.types';
import { ServerListService } from '@core/server-list.service';
import { TPipe } from '@core/t.pipe';
import { BadgeComponent } from '@shared/badge/badge.component';
import { ButtonComponent } from '@shared/button/button.component';
import { LiveDotComponent } from '@shared/live-dot/live-dot.component';
import { LogLine, LogViewComponent } from '@shared/log-view/log-view.component';
import { TitleService } from '../../shell/title.service';
import { HistoryChartComponent } from '../server/history-chart.component';
import { toLogLine } from '../server/panels/logs-panel.component';
import { containerView } from '../server/server-view';

/** Linjer ved start og maks i visningen (steg 5.13). */
export const CONTAINER_LOG_TAIL = 200;
export const CONTAINER_LOG_MAX = 300;

/** Finner containeren på full id, kort id (12 tegn) eller navn. */
export function findContainer(server: ServerDto | null, cid: string): ContainerInfo | null {
  const list = server?.containers ?? [];
  return list.find((c) => c.id === cid) ?? list.find((c) => c.id.startsWith(cid) || cid.startsWith(c.id)) ?? list.find((c) => c.name === cid) ?? null;
}

/**
 * Containerdetalj (steg 5.13, skjerm 6): «‹ servernavn», h1 med statusprikk og image-badge, meta-linje (restarts,
 * image age, health, compose), CPU- og minnekurve 1 t / 24 t fra `history?metric=cont:<id>[:mem]`, porter som chips,
 * volumer i monospace, og loggseksjon som starter en `container`-strøm med `tail: 200` ved inngang, med Pause/Resume
 * (holder bufferen, teller nye linjer i knappen) og «Open full log view».
 */
@Component({
  selector: 'gp-container-page',
  imports: [RouterLink, TPipe, BadgeComponent, ButtonComponent, LiveDotComponent, LogViewComponent, HistoryChartComponent],
  templateUrl: './container.page.html',
  styleUrl: './container.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContainerPage {
  readonly id = input.required<string>();
  readonly cid = input.required<string>();

  private readonly live = inject(LiveService);
  private readonly store = inject(LiveStore);
  private readonly api = inject(ApiService);
  private readonly i18n = inject(I18nService);
  private readonly serverList = inject(ServerListService);
  private readonly activity = inject(ActivityService);
  private readonly router = inject(Router);
  private readonly title = inject(TitleService);

  readonly server = computed<ServerDto | null>(() => this.store.server(this.id())());
  readonly container = computed(() => findContainer(this.server(), this.cid()));
  /** Containeren er en egen containernode (steg 12.6): lenke til noden. */
  readonly nodeId = computed(() => this.server()?.linkedNodes?.[this.cid()] ?? null);
  /** Bare id-en, så loggeffekten ikke kjører på nytt for hver `Server`-melding (nytt containerobjekt hvert sekund). */
  readonly containerId = computed(() => this.container()?.id ?? null);
  readonly notFound = signal(false);
  private readonly texts = computed(() => {
    this.i18n.lang();
    this.i18n.timeZone();
    return this.i18n;
  });
  readonly view = computed(() => {
    const c = this.container();
    return c ? containerView(c, this.texts(), Date.now()) : null;
  });
  readonly serverName = computed(() => this.server()?.name ?? this.serverList.byId().get(this.id())?.name ?? '');
  readonly down = computed(() => this.server()?.status === 'down');
  readonly cpuMetric = computed(() => `cont:${this.container()?.id ?? this.cid()}`);
  readonly memMetric = computed(() => `${this.cpuMetric()}:mem`);
  readonly timeZone = computed(() => this.i18n.timeZone() ?? undefined);

  // ---- logg ----------------------------------------------------------------------------------------
  readonly lines = signal<LogLine[]>([]);
  readonly paused = signal(false);
  readonly pending = signal<LogLine[]>([]);
  readonly ended = signal<string | null>(null);
  readonly streaming = computed(() => this.streamActive() && !this.paused());
  readonly logStatus = computed(() => {
    const t = this.texts();
    if (this.down()) return t.t('notAvailableDown');
    if (this.paused()) return t.t('pausedLog');
    if (this.ended()) return t.t('logEnded');
    return this.streamActive() ? t.t('streaming') : t.t('loading');
  });
  readonly pauseLabel = computed(() => {
    const t = this.texts();
    if (!this.paused()) return t.t('pause');
    const n = this.pending().length;
    return n > 0 ? `${t.t('resume')} · ${n} ${t.t('newLines')}` : t.t('resume');
  });
  private readonly streamActive = signal(false);
  private streamId: string | null = null;
  private starting = false;
  private seq = 0;
  private unsubscribe: (() => void) | null = null;

  constructor() {
    const destroyRef = inject(DestroyRef);
    effect(() => {
      const id = this.id();
      untracked(() => this.enter(id));
    });
    effect(() => {
      const name = this.container()?.name ?? this.cid();
      untracked(() => this.title.set(name));
    });
    // Loggstrømmen følger containeren, fanen og forbindelsen; pause holder strømmen åpen og samler linjer.
    // En strøm huben eller agenten har avsluttet (eof for en stoppet container, unavailable) startes ikke på nytt.
    effect(() => {
      const serverId = this.id();
      const cid = this.containerId();
      const want = !!cid && !this.down() && !this.ended() && this.activity.mode() !== 'hidden' && this.live.state() === 'connected';
      untracked(() => (want && cid ? this.startLog(serverId, cid) : this.stopLog()));
    });
    destroyRef.onDestroy(() => {
      this.stopLog();
      this.unsubscribe?.();
    });
  }

  private async loadSnapshot(id: string): Promise<void> {
    try {
      const dto = await this.api.get<ServerDto | undefined>(`/servers/${encodeURIComponent(id)}/snapshot`);
      if (dto && this.id() === id && !this.store.server(id)()) this.store.applyServer(dto);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 403)) this.notFound.set(true);
      else console.warn('[container] could not load the snapshot', err);
    }
  }

  private async startLog(serverId: string, containerId: string): Promise<void> {
    if (this.streamId || this.starting) return;
    this.starting = true;
    const seq = ++this.seq;
    try {
      const streamId = await this.live.startLog(
        { serverId, source: 'container', container: containerId, tail: CONTAINER_LOG_TAIL },
        {
          lines: (lines) => this.receive(lines.map(toLogLine)),
          ended: (reason) => {
            this.streamId = null;
            this.streamActive.set(false);
            if (reason !== 'hidden' && reason !== 'reconnecting' && reason !== 'disconnected') this.ended.set(reason);
          },
        },
      );
      if (seq !== this.seq) {
        void this.live.stopLog(streamId);
        return;
      }
      this.streamId = streamId;
      this.streamActive.set(true);
    } catch (err) {
      console.warn('[container] could not start the log stream', err);
    } finally {
      this.starting = false;
    }
  }

  private receive(lines: LogLine[]): void {
    if (this.paused()) {
      this.pending.update((p) => [...lines, ...p].slice(0, CONTAINER_LOG_MAX));
      return;
    }
    this.lines.update((prev) => [...lines, ...prev].slice(0, CONTAINER_LOG_MAX));
  }

  private stopLog(): void {
    this.seq++;
    const id = this.streamId;
    this.streamId = null;
    this.streamActive.set(false);
    if (id) void this.live.stopLog(id);
  }

  private enter(id: string): void {
    this.unsubscribe?.();
    this.notFound.set(false);
    this.lines.set([]);
    this.pending.set([]);
    this.paused.set(false);
    this.ended.set(null);
    this.unsubscribe = this.live.subscribeServer(id);
    if (!this.serverList.loaded()) void this.serverList.load().catch(() => undefined);
    void this.loadSnapshot(id);
  }

  togglePause(): void {
    if (this.paused()) {
      const pending = this.pending();
      this.pending.set([]);
      this.lines.update((prev) => [...pending, ...prev].slice(0, CONTAINER_LOG_MAX));
      this.paused.set(false);
    } else {
      this.paused.set(true);
    }
  }

  backToServer(): void {
    void this.router.navigate(['/servers', this.id()], { fragment: 'cont' });
  }

  openFull(): void {
    void this.router.navigate(['/logs'], { queryParams: { server: this.id(), source: 'container', container: this.container()?.id ?? this.cid() } });
  }
}
