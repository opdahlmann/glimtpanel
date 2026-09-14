import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, ElementRef, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiService } from '@core/api.service';
import { ClipboardService } from '@core/clipboard.service';
import { FeatureFlags } from '@core/feature-flags';
import { I18nKey, I18nService } from '@core/i18n.service';
import { ContainerInfo, LogRequest, ServerDto } from '@core/live.types';
import { CONTAINER_COLORS, LogStreamService } from '@core/log-stream.service';
import { ServerListService } from '@core/server-list.service';
import { TPipe } from '@core/t.pipe';
import { ButtonComponent } from '@shared/button/button.component';
import { InputComponent } from '@shared/input/input.component';
import { LogLine, LogViewComponent } from '@shared/log-view/log-view.component';
import { SegmentComponent, SegmentOption } from '@shared/segment/segment.component';
import { SelectComponent, SelectOption } from '@shared/select/select.component';
import { BreakpointService } from '@shared/util/breakpoint.service';
import { formatTime } from '@shared/util/format';
import { TitleService } from '../../shell/title.service';

/**
 * Kildene i segmentet (steg 6.1) → hubens `source` (packages/protocol). «Files» (`file`, steg 12.9) finnes bare for
 * containernoder, som til gjengjeld mangler serverkildene; «Containers» er der stdout via verten.
 */
export const SOURCES = [
  { ui: 'system', hub: 'journal', label: 'sysLog', hint: 'hint_system' },
  { ui: 'auth', hub: 'auth', label: 'authLog', hint: 'hint_auth' },
  { ui: 'kern', hub: 'kernel', label: 'kernLog', hint: 'hint_kern' },
  { ui: 'pkg', hub: 'packages', label: 'pkgLog', hint: 'hint_pkg' },
  { ui: 'web', hub: 'web', label: 'webLog', hint: 'hint_web' },
  { ui: 'fw', hub: 'firewall', label: 'fwLog', hint: 'hint_fw' },
  { ui: 'cont', hub: 'container', label: 'contLog', hint: 'hint_cont' },
  { ui: 'files', hub: 'file', label: 'files', hint: 'hint_files' },
] as const;
export const CONTAINER_NODE_SOURCES: readonly SourceUi[] = ['files', 'cont'];
export const MAX_PATHS = 4;
export type SourceUi = (typeof SOURCES)[number]['ui'];
export type HubSource = (typeof SOURCES)[number]['hub'];

export type Priority = '' | 'err' | 'warn' | 'info';
export type Range = '15m' | '1h' | '24h';
export const RANGE_MS: Record<Range, number> = { '15m': 15 * 60_000, '1h': 3_600_000, '24h': 86_400_000 };
export const LOG_TAIL = 200;
/** Tekstfilteret venter så lenge (steg 6.1). */
export const FILTER_DEBOUNCE_MS = 100;
/** «Copy lines» uten markering kopierer de nyeste. */
export const COPY_NEWEST = 50;
export const MAX_CONTAINERS = 4;
export const SIDE_BY_SIDE_MAX = 3;

export function hubSource(ui: string | null | undefined): HubSource {
  return SOURCES.find((s) => s.ui === ui || s.hub === ui)?.hub ?? 'journal';
}

export function uiSource(source: string | null | undefined): SourceUi {
  return SOURCES.find((s) => s.hub === source || s.ui === source)?.ui ?? 'system';
}

/** Linjene som tekst til utklippstavlen: «08:14:05 sshd: melding». */
export function linesToText(lines: LogLine[], timeZone?: string): string {
  return lines
    .filter((l) => !l.dropped)
    .map((l) => `${formatTime(l.ts, { seconds: true, timeZone })} ${l.container ?? l.unit ?? ''}: ${l.message}`.replace(' : ', ' '))
    .join('\n');
}

/** Tekstfilteret: navn, enhet, container eller melding inneholder søket (uavhengig av store/små bokstaver). */
export function matchesFilter(l: LogLine, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return !!l.dropped || l.message.toLowerCase().includes(needle) || (l.unit ?? '').toLowerCase().includes(needle) || (l.container ?? '').toLowerCase().includes(needle);
}

/**
 * Loggsiden (fase 6, skjerm 7). Alt lever i spørreparametrene `server`, `source`, `unit`, `container`, `priority`,
 * `range` og `q`, så dyplenker fra tjenestepanelet, loggpanelet, containerpanelet og containersiden lander med riktig
 * filter og siden kan deles internt. Én `LogStreamService` per side holder strømmene: bytte av server, kilde, enhet,
 * container, prioritet eller tidsrom er StopLog + StartLog; tekstfilteret filtrerer det som er lastet.
 */
@Component({
  selector: 'gp-logs-page',
  imports: [FormsModule, TPipe, SelectComponent, InputComponent, SegmentComponent, ButtonComponent, LogViewComponent],
  providers: [LogStreamService],
  templateUrl: './logs.page.html',
  styleUrl: './logs.page.css',
  host: { '[class.mobile]': 'isMobile()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogsPage {
  // Spørreparametrene (withComponentInputBinding).
  readonly server = input<string | undefined>();
  readonly source = input<string | undefined>();
  readonly unit = input<string | undefined>();
  readonly container = input<string | undefined>();
  readonly priority = input<string | undefined>();
  readonly range = input<string | undefined>();
  readonly q = input<string | undefined>();
  /** `source: file`: kommaseparerte stier fra nodens `logPaths` (steg 12.9). */
  readonly path = input<string | undefined>();

  readonly stream = inject(LogStreamService);
  private readonly serverList = inject(ServerListService);
  private readonly api = inject(ApiService);
  private readonly i18n = inject(I18nService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly clipboard = inject(ClipboardService);
  private readonly flags = inject(FeatureFlags);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly isMobile = inject(BreakpointService).isMobile;

  readonly servers = this.serverList.servers;
  readonly listLoaded = this.serverList.loaded;
  readonly serverId = computed(() => {
    const wanted = this.server();
    const list = this.servers();
    if (wanted && (list.some((s) => s.id === wanted) || !this.listLoaded())) return wanted;
    return list[0]?.id ?? null;
  });
  readonly serverOptions = computed<SelectOption[]>(() => this.servers().map((s) => ({ value: s.id, label: s.name })));
  /** Containernode (steg 12.9): bare «Files» og «Containers» (stdout via verten), standard Files. */
  readonly isContainerNode = computed(() => this.servers().find((s) => s.id === this.serverId())?.kind === 'container');
  readonly src = computed<SourceUi>(() => {
    const ui = uiSource(this.source());
    if (this.isContainerNode()) return CONTAINER_NODE_SOURCES.includes(ui) ? ui : 'files';
    return ui === 'files' ? 'system' : ui;
  });
  readonly hub = computed<HubSource>(() => hubSource(this.src()));
  readonly selectedPaths = computed(() =>
    (this.path() ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAX_PATHS),
  );
  readonly logPaths = signal<string[]>([]);
  readonly linked = signal(false);
  readonly pri = computed<Priority>(() => {
    const p = this.priority();
    return p === 'err' || p === 'warn' || p === 'info' ? p : '';
  });
  readonly rng = computed<Range>(() => {
    const r = this.range();
    return r === '15m' || r === '24h' ? r : '1h';
  });
  readonly selectedContainers = computed(() =>
    (this.container() ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAX_CONTAINERS),
  );
  readonly crossLogs = this.flags.crossLogs;

  /** Tidsrommets startpunkt: settes når server/kilde/enhet/containere/prioritet/tidsrom endres, ikke hvert sekund. */
  private readonly anchor = signal(Date.now());
  readonly requests = computed<LogRequest[]>(() => {
    const serverId = this.serverId();
    if (!serverId) return [];
    const base = { serverId, priority: this.pri() || null, sinceMs: this.anchor() - RANGE_MS[this.rng()], tail: LOG_TAIL };
    if (this.hub() === 'file') return this.selectedPaths().map((p) => ({ ...base, source: 'file', path: p }));
    // En containernodes stdout går gjennom verten: huben ruter `source: container` uten containernavn (steg 12.6).
    if (this.hub() === 'container' && this.isContainerNode()) return [{ ...base, source: 'container' }];
    if (this.hub() === 'container') return this.selectedContainers().map((c) => ({ ...base, source: 'container', container: c }));
    return [{ ...base, source: this.hub(), unit: this.unit() || null }];
  });

  // ---- tekstfilter -------------------------------------------------------------------------------
  readonly filterText = signal(this.q() ?? '');
  private readonly debounced = signal(this.q() ?? '');
  private filterTimer: ReturnType<typeof setTimeout> | null = null;
  readonly filtered = computed(() => {
    const q = this.debounced().trim();
    return q ? this.stream.lines().filter((l) => matchesFilter(l, q)) : this.stream.lines();
  });

  // ---- containere (steg 6.3) ---------------------------------------------------------------------
  readonly containers = signal<ContainerInfo[]>([]);
  readonly containersLoaded = signal(false);
  readonly colorByContainer = computed(() => new Map(this.selectedContainers().map((c, i) => [c, CONTAINER_COLORS[i % CONTAINER_COLORS.length]])));
  readonly layout = signal<'merged' | 'side'>('merged');
  readonly layoutOptions = computed<SegmentOption<'merged' | 'side'>[]>(() => [
    { value: 'merged', label: this.i18n.t('merged') },
    { value: 'side', label: this.i18n.t('sideBySide') },
  ]);
  readonly showLayout = computed(() => this.src() === 'cont' && this.selectedContainers().length >= 2 && !this.isMobile());
  readonly columns = computed(() => (this.showLayout() && this.layout() === 'side' ? this.selectedContainers().slice(0, SIDE_BY_SIDE_MAX) : null));

  // ---- segmenter og tekster ----------------------------------------------------------------------
  private readonly texts = computed(() => {
    this.i18n.lang();
    return this.i18n;
  });
  readonly sourceOptions = computed<SegmentOption<SourceUi>[]>(() =>
    SOURCES.filter((s) => (this.isContainerNode() ? CONTAINER_NODE_SOURCES.includes(s.ui) : s.ui !== 'files')).map((s) => ({ value: s.ui, label: this.texts().t(s.label) })),
  );
  readonly priorityOptions = computed<SegmentOption<Priority>[]>(() => [
    { value: '', label: this.texts().t('all') },
    { value: 'err', label: this.texts().t('errors') },
    { value: 'warn', label: this.texts().t('warnings') },
    { value: 'info', label: this.texts().t('info') },
  ]);
  readonly rangeOptions = computed<SegmentOption<Range>[]>(() => [
    { value: '15m', label: this.texts().t('range15') },
    { value: '1h', label: this.texts().t('range1h') },
    { value: '24h', label: this.texts().t('range24') },
  ]);
  readonly scopeOptions = computed<SegmentOption<'one' | 'all'>[]>(() => [
    { value: 'one', label: this.texts().t('oneServer') },
    { value: 'all', label: this.texts().t('crossServer') },
  ]);
  readonly hint = computed(() => this.texts().t(SOURCES.find((s) => s.ui === this.src())?.hint ?? 'hint_system'));
  readonly timeZone = computed(() => this.i18n.timeZone() ?? undefined);

  /** «streaming · nothing is stored» / «paused» / «Not found on this server» / «The log stream ended». */
  readonly statusText = computed(() => {
    const t = this.texts();
    if (this.stream.paused()) return t.t('pausedLog');
    if (this.stream.allEnded()) {
      const s = this.stream.statuses()[0];
      return s?.reason === 'unavailable' ? t.t('notOnServer') : t.t('logEnded');
    }
    if (this.stream.streaming()) return t.t('streaming');
    return this.requests().length ? t.t('loading') : t.t('noServersYet');
  });
  readonly dot = computed<'up' | 'paused' | 'down' | 'connecting'>(() => (this.stream.paused() ? 'paused' : this.stream.allEnded() ? 'down' : this.stream.streaming() ? 'up' : 'connecting'));
  readonly countText = computed(() => `${this.filtered().filter((l) => !l.dropped).length} ${this.texts().t('lines')}`);
  readonly pauseLabel = computed(() => {
    const t = this.texts();
    if (!this.stream.paused()) return t.t('pause');
    const n = this.stream.pendingCount();
    return n > 0 ? `${t.t('resume')} · ${n}` : t.t('resume');
  });
  readonly emptyText = computed(() => {
    const t = this.texts();
    if (this.src() === 'cont' && !this.isContainerNode() && this.selectedContainers().length === 0) return t.t('chooseContainers');
    if (this.src() === 'files' && this.selectedPaths().length === 0) return t.t(this.logPaths().length ? 'chooseContainers' : 'noLogPaths');
    if (this.src() === 'cont' && this.isContainerNode() && !this.linked() && this.stream.allEnded()) return t.t('stdoutNeedsHost');
    if (this.debounced().trim() && this.stream.lines().length) return t.t('logEmptyFilter');
    return this.statusText();
  });

  constructor() {
    inject(TitleService).setKey('logs');
    const destroyRef = inject(DestroyRef);
    if (!this.serverList.loaded()) void this.serverList.load().catch((err: unknown) => console.warn('[logs] could not load the server list', err));
    // Nytt tidsrom-anker for hvert bytte som gir ny strøm.
    effect(() => {
      this.serverId();
      this.hub();
      this.unit();
      this.selectedContainers();
      this.selectedPaths();
      this.pri();
      this.rng();
      untracked(() => this.anchor.set(Date.now()));
    });
    effect(() => {
      const requests = this.requests();
      untracked(() => this.stream.configure(requests));
    });
    // Tekstfilteret fra URL-en.
    effect(() => {
      const q = this.q() ?? '';
      untracked(() => {
        if (q !== this.filterText()) {
          this.filterText.set(q);
          this.debounced.set(q);
        }
      });
    });
    // Containerlisten for valgt server når kilden er Containers (og filstiene/verten for en containernode).
    effect(() => {
      const serverId = this.serverId();
      const wanted = this.src() === 'cont' || this.src() === 'files';
      untracked(() => void this.loadContainers(wanted ? serverId : null));
    });
    destroyRef.onDestroy(() => {
      if (this.filterTimer) clearTimeout(this.filterTimer);
    });
  }

  private containersFor: string | null = null;

  private async loadContainers(serverId: string | null): Promise<void> {
    if (!serverId || this.containersFor === serverId) return;
    this.containersFor = serverId;
    this.containersLoaded.set(false);
    try {
      const dto = await this.api.get<ServerDto | undefined>(`/servers/${encodeURIComponent(serverId)}/snapshot`);
      if (this.containersFor === serverId) {
        this.containers.set(dto?.containers ?? []);
        this.logPaths.set(dto?.logPaths ?? []);
        this.linked.set(!!dto?.hostServer);
      }
    } catch (err) {
      console.warn('[logs] could not load containers', err);
      if (this.containersFor === serverId) this.containers.set([]);
    } finally {
      if (this.containersFor === serverId) this.containersLoaded.set(true);
    }
  }

  // ---- handlinger (alt går via URL-en) ------------------------------------------------------------

  /** Bygger hele spørrestrengen fra sidens egne verdier (ikke rutens øyeblikksbilde, som kan henge etter ved raske klikk). */
  private go(patch: Record<string, string | null>): void {
    const current: Record<string, string | null> = {
      server: this.server() ?? null,
      source: this.source() ?? null,
      unit: this.unit() ?? null,
      container: this.container() ?? null,
      priority: this.priority() ?? null,
      range: this.range() ?? null,
      q: this.q() ?? null,
      path: this.path() ?? null,
      ...patch,
    };
    const queryParams: Record<string, string> = {};
    for (const [k, v] of Object.entries(current)) if (v) queryParams[k] = v;
    void this.router.navigate([], { relativeTo: this.route, queryParams, replaceUrl: true });
  }

  onServer(id: string): void {
    if (id && id !== this.serverId()) this.go({ server: id, container: null, unit: null, path: null });
  }

  onSource(ui: SourceUi | null): void {
    if (!ui || ui === this.src()) return;
    this.go({ source: hubSource(ui), unit: null, container: ui === 'cont' ? this.container() ?? null : null, path: ui === 'files' ? this.path() ?? null : null });
  }

  togglePath(p: string): void {
    const sel = this.selectedPaths();
    const next = sel.includes(p) ? sel.filter((x) => x !== p) : sel.length < MAX_PATHS ? [...sel, p] : sel;
    if (next.join(',') !== sel.join(',')) this.go({ path: next.join(',') || null });
  }

  isPathSelected(p: string): boolean {
    return this.selectedPaths().includes(p);
  }

  onPriority(p: Priority | null): void {
    this.go({ priority: p || null });
  }

  onRange(r: Range | null): void {
    if (r) this.go({ range: r === '1h' ? null : r });
  }

  clearUnit(): void {
    this.go({ unit: null });
  }

  onFilter(value: string): void {
    this.filterText.set(value);
    if (this.filterTimer) clearTimeout(this.filterTimer);
    this.filterTimer = setTimeout(() => {
      this.filterTimer = null;
      this.debounced.set(value);
      this.go({ q: value.trim() || null });
    }, FILTER_DEBOUNCE_MS);
  }

  toggleContainer(name: string): void {
    const sel = this.selectedContainers();
    const next = sel.includes(name) ? sel.filter((c) => c !== name) : sel.length < MAX_CONTAINERS ? [...sel, name] : sel;
    if (next.join(',') !== sel.join(',')) this.go({ container: next.join(',') || null });
  }

  isSelected(name: string): boolean {
    return this.selectedContainers().includes(name);
  }

  containerColor(name: string): string | null {
    return this.colorByContainer().get(name) ?? null;
  }

  linesFor(container: string): LogLine[] {
    return this.filtered().filter((l) => l.container === container || !!l.dropped);
  }

  togglePause(): void {
    this.stream.togglePause();
  }

  /** Markerte linjer i loggboksen, ellers de 50 nyeste. */
  copyLines(): void {
    const selection = typeof window !== 'undefined' ? window.getSelection() : null;
    const box = this.host.nativeElement.querySelector('.logbox');
    const selected = selection && !selection.isCollapsed && box && selection.anchorNode && box.contains(selection.anchorNode) ? selection.toString().trim() : '';
    const text = selected || linesToText(this.filtered().slice(0, COPY_NEWEST), this.timeZone());
    void this.clipboard.copy(text);
  }

  t(key: I18nKey): string {
    return this.texts().t(key);
  }
}
