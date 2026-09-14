import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, ElementRef, inject, input, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiError, ApiService } from '@core/api.service';
import { ClipboardService } from '@core/clipboard.service';
import { FeatureFlags } from '@core/feature-flags';
import { HistoryService } from '@core/history.service';
import { I18nService } from '@core/i18n.service';
import { LiveService } from '@core/live.service';
import { LiveStore } from '@core/live.store';
import { ServerDto } from '@core/live.types';
import { PrefsService } from '@core/prefs.service';
import { ServerListService } from '@core/server-list.service';
import { SessionService } from '@core/session.service';
import { TPipe } from '@core/t.pipe';
import { BadgeComponent } from '@shared/badge/badge.component';
import { ButtonComponent } from '@shared/button/button.component';
import { LiveDotComponent } from '@shared/live-dot/live-dot.component';
import { PanelComponent, PanelTone } from '@shared/panel/panel.component';
import { BreakpointService } from '@shared/util/breakpoint.service';
import { TitleService } from '../../shell/title.service';
import { PanelNavComponent, PanelNavItem } from './panel-nav.component';
import { ContPanelComponent } from './panels/cont-panel.component';
import { CpuPanelComponent } from './panels/cpu-panel.component';
import { DiskPanelComponent } from './panels/disk-panel.component';
import { HealthPanelComponent } from './panels/health-panel.component';
import { HostPanelComponent } from './panels/host-panel.component';
import { LogsPanelComponent } from './panels/logs-panel.component';
import { PortsPanelComponent } from './panels/ports-panel.component';
import { MaintPanelComponent } from './panels/maint-panel.component';
import { MemPanelComponent } from './panels/mem-panel.component';
import { NetPanelComponent } from './panels/net-panel.component';
import { ProcPanelComponent } from './panels/proc-panel.component';
import { SecPanelComponent } from './panels/sec-panel.component';
import { SvcPanelComponent } from './panels/svc-panel.component';
import { containersView, cpuView, diskView, headerView, healthView, hostView, maintView, memView, netView, procView, rememberPorts, securityView, servicesView, snapshotText } from './server-view';

/** Panelene i rekkefølge (steg 5.2). `cert` er Forslag og utelatt. `ports`, `health` og `host` er containernodens (steg 12.9). */
export const PANEL_KEYS = ['cpu', 'mem', 'disk', 'net', 'proc', 'cont', 'svc', 'maint', 'sec', 'logs', 'ports', 'health', 'host'] as const;
export type PanelKey = (typeof PANEL_KEYS)[number];
/** Serverens paneler (skjerm 5) og containernodens (skjerm 21): Volumes er diskpanelet, Host bare når lenket. */
export const SERVER_PANELS: readonly PanelKey[] = ['cpu', 'mem', 'disk', 'net', 'proc', 'cont', 'svc', 'maint', 'sec', 'logs'];
export const CONTAINER_PANELS: readonly PanelKey[] = ['cpu', 'mem', 'disk', 'net', 'proc', 'ports', 'health', 'host', 'logs'];

/** Panellisten etter nodetype; verten utelates når noden ikke er lenket (steg 12.9). */
export function panelsFor(kind: 'server' | 'container', linked: boolean): PanelKey[] {
  if (kind !== 'container') return [...SERVER_PANELS];
  return CONTAINER_PANELS.filter((k) => k !== 'host' || linked);
}
/** Kortets ringer bruker `#cpu`, `#mem`, `#disk`; alle panelnøklene godtas som fragment. */
export const PANEL_ID_PREFIX = 'panel-';
/** Panelet legges så langt under toppen (sticky panelnav) ved rulling. */
export const SCROLL_OFFSET = 70;

/**
 * Serversiden (fase 5, skjerm 5 og 16): `SubscribeServer(id)` ved inngang og `UnsubscribeServer` ved utgang,
 * `GET /api/servers/{id}/snapshot` først så siden tegnes uten å vente på strømmen, `history?range=1h` seeder
 * siste-time-ringen, toppen med status, tagger, infolinje, oppetid og EOL, sticky panelnav og ti paneler.
 * Lukkede paneler huskes i PrefsService. Fragment `#cpu` åpner panelet og ruller til det. Nede (skjerm 16):
 * rød prikk, «last seen», tall nedtonet, prosesser og logger «not available while the server is down».
 */
@Component({
  selector: 'gp-server-page',
  imports: [
    TPipe,
    BadgeComponent,
    ButtonComponent,
    LiveDotComponent,
    PanelComponent,
    PanelNavComponent,
    CpuPanelComponent,
    MemPanelComponent,
    DiskPanelComponent,
    NetPanelComponent,
    ProcPanelComponent,
    ContPanelComponent,
    SvcPanelComponent,
    MaintPanelComponent,
    SecPanelComponent,
    LogsPanelComponent,
    PortsPanelComponent,
    HealthPanelComponent,
    HostPanelComponent,
  ],
  templateUrl: './server.page.html',
  styleUrl: './server.page.css',
  host: { '[class.mobile]': 'isMobile()', '[attr.data-status]': 'header()?.status', '[attr.data-kind]': 'kind()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ServerPage {
  /** Fra ruten (`withComponentInputBinding`). */
  readonly id = input.required<string>();

  private readonly live = inject(LiveService);
  private readonly store = inject(LiveStore);
  private readonly api = inject(ApiService);
  private readonly history = inject(HistoryService);
  private readonly i18n = inject(I18nService);
  private readonly prefs = inject(PrefsService);
  private readonly session = inject(SessionService);
  private readonly serverList = inject(ServerListService);
  private readonly flags = inject(FeatureFlags);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly title = inject(TitleService);
  private readonly clipboard = inject(ClipboardService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly isMobile = inject(BreakpointService).isMobile;

  private readonly fragment = toSignal(this.route.fragment, { initialValue: null });
  readonly server = computed<ServerDto | null>(() => this.store.server(this.id())());
  readonly item = computed(() => this.serverList.byId().get(this.id()) ?? null);
  readonly hourChart = computed(() => this.store.hourChart(this.id())());
  readonly notFound = signal(false);
  readonly isOwner = computed(() => this.session.isOwnerOf(this.id()));
  readonly textMode = signal(false);
  readonly showAllServices = signal(false);
  readonly flagText = this.flags.textMode;
  readonly flagSnapshot = this.flags.snapshot;
  readonly flagShare = this.flags.share;
  readonly collapsed = this.prefs.collapsed.value;

  // ---- avledninger (rene funksjoner i server-view.ts) ----------------------------------------------
  private readonly texts = computed(() => {
    this.i18n.lang();
    this.i18n.timeZone();
    return this.i18n;
  });
  readonly header = computed(() => (this.server() ? headerView(this.server() as ServerDto, this.item(), this.texts()) : null));
  readonly down = computed(() => this.header()?.down ?? false);
  /** Nodetype fra strømmen, ellers listen (containernoden vises riktig også før første Server). */
  readonly kind = computed<'server' | 'container'>(() => this.server()?.kind ?? this.item()?.kind ?? 'server');
  readonly isContainer = computed(() => this.kind() === 'container');
  readonly health = computed(() => (this.server() ? healthView(this.server() as ServerDto, this.texts()) : null));
  readonly hostLink = computed(() => (this.server() ? hostView(this.server() as ServerDto, this.texts(), Date.now()) : null));
  readonly logPaths = computed(() => this.server()?.logPaths ?? []);
  /** `capabilities` (steg 12.9): paneler uten data sier «not readable on this platform». */
  readonly procReadable = computed(() => this.server()?.capabilities?.procAll !== false);
  readonly netReadable = computed(() => this.server()?.capabilities?.netns !== false);
  readonly panels = computed(() => panelsFor(this.kind(), this.hostLink() !== null));
  readonly cpu = computed(() => (this.server() ? cpuView(this.server() as ServerDto, this.texts()) : null));
  readonly mem = computed(() => (this.server() ? memView(this.server() as ServerDto, this.texts()) : null));
  readonly disk = computed(() => (this.server() ? diskView(this.server() as ServerDto, this.texts()) : null));
  readonly net = computed(() => (this.server() ? netView(this.server() as ServerDto) : null));
  readonly proc = computed(() => (this.server() ? procView(this.server() as ServerDto, this.texts(), Date.now()) : null));
  readonly containers = computed(() => (this.server() ? containersView(this.server() as ServerDto, this.texts(), Date.now()) : null));
  readonly services = computed(() => (this.server() ? servicesView(this.server() as ServerDto, this.texts(), this.showAllServices()) : null));
  readonly maint = computed(() => (this.server() ? maintView(this.server() as ServerDto, this.item(), this.texts()) : null));
  readonly security = computed(() => (this.server() ? securityView(this.server() as ServerDto, this.prefs.knownPorts.value()[this.id()] ?? {}, Date.now(), this.texts()) : null));

  readonly navItems = computed<PanelNavItem[]>(() => {
    const t = this.texts();
    const failed = (this.services()?.failed ?? 0) > 0;
    const neutral = 'var(--w-60)';
    if (this.isContainer()) {
      const healthTone = this.health()?.tone;
      const all: PanelNavItem[] = [
        { key: 'cpu', label: t.t('cpu'), color: 'var(--color-cpu)' },
        { key: 'mem', label: t.t('memory'), color: 'var(--color-ram)' },
        { key: 'disk', label: t.t('volumes'), color: 'var(--color-disk)' },
        { key: 'net', label: t.t('network'), color: 'var(--color-net)' },
        { key: 'proc', label: t.t('processes'), color: neutral },
        { key: 'ports', label: t.t('ports'), color: neutral },
        { key: 'health', label: t.t('healthChecks'), color: healthTone === 'crit' ? 'var(--color-crit)' : healthTone === 'ok' ? 'var(--color-ram)' : neutral },
        { key: 'host', label: t.t('host'), color: 'var(--color-swap)' },
        { key: 'logs', label: t.t('logs'), color: neutral },
      ];
      const keys = this.panels();
      return all.filter((i) => keys.includes(i.key as PanelKey));
    }
    return [
      { key: 'cpu', label: t.t('cpu'), color: 'var(--color-cpu)' },
      { key: 'mem', label: t.t('memory'), color: 'var(--color-ram)' },
      { key: 'disk', label: t.t('disk'), color: 'var(--color-disk)' },
      { key: 'net', label: t.t('network'), color: 'var(--color-net)' },
      { key: 'proc', label: t.t('processes'), color: neutral },
      { key: 'cont', label: t.t('containers'), color: 'var(--color-swap)' },
      { key: 'svc', label: t.t('services'), color: failed ? 'var(--color-crit)' : neutral },
      { key: 'maint', label: t.t('maintenance'), color: 'var(--color-warn)' },
      { key: 'sec', label: t.t('security'), color: neutral },
      { key: 'logs', label: t.t('logs'), color: neutral },
    ];
  });
  readonly svcTone = computed<PanelTone>(() => ((this.services()?.failed ?? 0) > 0 ? 'crit' : 'neutral'));
  readonly healthTone = computed<PanelTone>(() => {
    const tone = this.health()?.tone;
    return tone === 'crit' ? 'crit' : tone === 'ok' ? 'ram' : 'neutral';
  });
  readonly portsMeta = computed(() => String(this.security()?.ports?.length ?? 0));
  readonly logsMeta = computed(() => (this.isContainer() ? `${this.texts().t('files')} · ${this.texts().t('streaming')}` : `journald · ${this.texts().t('streaming')}`));
  readonly secMeta = computed(() => {
    const t = this.texts();
    return `${t.t('ports')} · ${t.t('loggedIn')} · SSH · ${t.t('firewall')}`;
  });
  readonly textLines = computed(() => (this.server() ? snapshotText(this.server() as ServerDto, this.item(), this.texts(), Date.now()) : ''));

  private unsubscribe: (() => void) | null = null;
  private scrolledTo: string | null = null;

  constructor() {
    const destroyRef = inject(DestroyRef);
    // Abonnement, snapshot og historikk følger id-en (samme komponent gjenbrukes mellom to servere).
    effect(() => {
      const id = this.id();
      untracked(() => this.enter(id));
    });
    // Tittelen i topplinjen (mobil) og document.title.
    effect(() => {
      const name = this.server()?.name ?? this.item()?.name;
      untracked(() => (name ? this.title.set(name) : this.title.setKey('server')));
    });
    // Kjente porter for «new»-badgen.
    effect(() => {
      const server = this.server();
      if (!server) return;
      untracked(() => {
        const id = server.id;
        const all = this.prefs.knownPorts.value();
        const known = all[id] ?? {};
        const next = rememberPorts(known, server, Date.now());
        if (next !== known) this.prefs.knownPorts.set({ ...all, [id]: next });
      });
    });
    // Fragment fra kortets ringer: åpne panelet og rull til det, én gang per fragment, når det finnes i DOM.
    effect(() => {
      const fragment = this.fragment();
      const ready = this.server() !== null;
      untracked(() => {
        if (!fragment || !ready || this.scrolledTo === fragment) return;
        if (!(PANEL_KEYS as readonly string[]).includes(fragment)) return;
        this.scrolledTo = fragment;
        this.open(fragment as PanelKey);
        setTimeout(() => this.scrollTo(fragment as PanelKey), 50);
      });
    });
    destroyRef.onDestroy(() => this.leave());
  }

  // ---- inn og ut ---------------------------------------------------------------------------------

  private enter(id: string): void {
    this.leave();
    this.notFound.set(false);
    this.scrolledTo = null;
    this.showAllServices.set(false);
    this.unsubscribe = this.live.subscribeServer(id);
    if (!this.serverList.loaded()) void this.serverList.load().catch((err: unknown) => console.warn('[server] could not load the server list', err));
    void this.loadSnapshot(id);
    void this.seedHour(id);
  }

  private leave(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Siste snapshot flettet med siste stream, slik at siden tegnes før første `Server` fra strømmen. */
  private async loadSnapshot(id: string): Promise<void> {
    try {
      const dto = await this.api.get<ServerDto | undefined>(`/servers/${encodeURIComponent(id)}/snapshot`);
      if (dto && this.id() === id && !this.store.server(id)()) this.store.applyServer(dto);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) this.notFound.set(true);
      else if (!(err instanceof ApiError && err.status === 403)) console.warn('[server] could not load the snapshot', err);
      if (err instanceof ApiError && err.status === 403) this.notFound.set(true);
    }
  }

  /** 1 t for CPU og minne fra bufferen (120 × 30 s) seeder ringen ved dyplenke. */
  private async seedHour(id: string): Promise<void> {
    try {
      const [cpu, mem] = await Promise.all([this.history.get(id, 'cpu', '1h'), this.history.get(id, 'mem', '1h')]);
      if (this.id() === id) this.store.seedHour(id, cpu.values ?? [], mem.values ?? []);
    } catch (err) {
      if (!(err instanceof ApiError && (err.status === 404 || err.status === 403))) console.warn('[server] could not load the last hour', err);
    }
  }

  // ---- paneler -----------------------------------------------------------------------------------

  isOpen(key: PanelKey): boolean {
    return !this.collapsed()[key];
  }

  setOpen(key: PanelKey, open: boolean): void {
    const c = this.collapsed();
    if (!!c[key] === !open) return;
    const next = { ...c };
    if (open) delete next[key];
    else next[key] = true;
    this.prefs.collapsed.set(next);
  }

  open(key: PanelKey): void {
    this.setOpen(key, true);
  }

  panelId(key: PanelKey): string {
    return PANEL_ID_PREFIX + key;
  }

  /** Panelnav: åpner (hvis lukket) og ruller panelet til 70 px under toppen. */
  goTo(key: string): void {
    if (!(PANEL_KEYS as readonly string[]).includes(key)) return;
    this.open(key as PanelKey);
    setTimeout(() => this.scrollTo(key as PanelKey), 0);
  }

  private scrollTo(key: PanelKey): void {
    const el = this.host.nativeElement.querySelector<HTMLElement>(`#${PANEL_ID_PREFIX}${key}`);
    if (!el || typeof window === 'undefined') return;
    const top = el.getBoundingClientRect().top + window.scrollY - SCROLL_OFFSET;
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: Math.max(0, top), behavior: reduced ? 'auto' : 'smooth' });
  }

  // ---- knapper -----------------------------------------------------------------------------------

  back(): void {
    void this.router.navigate(['/']);
  }

  openHost(): void {
    const link = this.header()?.onHost;
    if (link) void this.router.navigate(['/servers', link.serverId]);
  }

  alertSettings(): void {
    void this.router.navigate(['/settings', 'alerts'], { queryParams: { server: this.id() } });
  }

  toggleText(): void {
    this.textMode.update((v) => !v);
  }

  copySnapshot(): void {
    void this.clipboard.copy(this.textLines());
  }
}
