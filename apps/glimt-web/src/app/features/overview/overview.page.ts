import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, ElementRef, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { ClockService } from '@core/clock.service';
import { ConnectionService } from '@core/connection.service';
import { FeatureFlags } from '@core/feature-flags';
import { GroupsStore } from '@core/groups.store';
import { I18nService } from '@core/i18n.service';
import { LiveService } from '@core/live.service';
import { LiveStore } from '@core/live.store';
import { CardDto } from '@core/live.types';
import { OverviewFilters, PrefsService, SORT_KEYS, SortKey, ViewKey } from '@core/prefs.service';
import { ServerListService } from '@core/server-list.service';
import { SessionService } from '@core/session.service';
import { TPipe } from '@core/t.pipe';
import { ButtonComponent } from '@shared/button/button.component';
import { InputComponent } from '@shared/input/input.component';
import { SegmentComponent, SegmentOption } from '@shared/segment/segment.component';
import { SelectComponent, SelectOption } from '@shared/select/select.component';
import { TitleService } from '../../shell/title.service';
import { AddContainerDialogComponent, AddContainerStep } from './add-container/add-container-dialog.component';
import { AddServerDialogComponent, AddStep } from './add-server/add-server-dialog.component';
import { ContainerCardComponent } from './container-card/container-card.component';
import { EnrolPanelComponent } from './enrol/enrol-panel.component';
import { GroupCardComponent } from './group-card/group-card.component';
import { clearFilters, collectTags, countByStatus, filterCards, isAllActive, sortCards, toggleAlert, toggleKind, toggleStatus, toggleTag } from './overview.model';
import { ServerCardComponent } from './server-card/server-card.component';

/** Søket venter så lenge før listen filtreres (steg 4.1). */
export const SEARCH_DEBOUNCE_MS = 150;

const SORT_LABEL_KEYS = { name: 'name', cpu: 'cpu', mem: 'memory', disk: 'disk', status: 'status', tag: 'tag' } as const;

/**
 * Oversikten (steg 4.1–4.4, skjerm 3, 4, 16 og 18; steg 12.8, skjerm 20): tittel («Nodes» når kontoen har
 * containernoder) og sammendragslinje bygget av deler, «+ Add» med menyen Server/Container kun for eiere, verktøylinje (søk med 150 ms debounce, sortering som `<select>`, visningssegment kun når flere visninger er
 * slått på), filterchips (All, tagger, up/down/paused, Has alert), kortgrid, tom-tilstand med innrulleringskortet for
 * eiere uten servere og «no access yet» for lesere. PrefsService husker sortering, filter og visning.
 * Piltaster mellom kort, Enter åpner, `/` fokuserer søket.
 */
@Component({
  selector: 'gp-overview-page',
  imports: [FormsModule, InputComponent, SelectComponent, SegmentComponent, ButtonComponent, ServerCardComponent, ContainerCardComponent, GroupCardComponent, EnrolPanelComponent, AddServerDialogComponent, AddContainerDialogComponent, TPipe],
  templateUrl: './overview.page.html',
  styleUrl: './overview.page.css',
  host: { '(document:keydown)': 'onDocumentKeydown($event)', '(document:click)': 'onDocumentClick($event)' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OverviewPage {
  private readonly live = inject(LiveService);
  private readonly store = inject(LiveStore);
  private readonly i18n = inject(I18nService);
  private readonly prefs = inject(PrefsService);
  private readonly session = inject(SessionService);
  private readonly serverList = inject(ServerListService);
  private readonly flags = inject(FeatureFlags);
  private readonly conn = inject(ConnectionService);
  private readonly clock = inject(ClockService);
  private readonly groupsStore = inject(GroupsStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  private readonly searchField = viewChild<InputComponent, ElementRef<HTMLElement>>(InputComponent, { read: ElementRef });
  private readonly grid = viewChild<ElementRef<HTMLElement>>('grid');

  readonly state = this.live.state;
  readonly cards = this.store.cards;
  readonly sort = this.prefs.sort.value;
  readonly filters = this.prefs.filters.value;
  readonly view = this.prefs.view.value;

  readonly search = signal('');
  private readonly debouncedSearch = signal('');
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  readonly counts = computed(() => countByStatus(this.cards()));
  /** Minst én containernode: tittelen sier «Nodes» og sammendraget teller begge typer (steg 12.8). */
  readonly hasNodes = computed(() => this.counts().containers > 0);
  readonly titleKey = computed<'nodes' | 'servers'>(() => (this.hasNodes() ? 'nodes' : 'servers'));
  readonly tags = computed(() => collectTags(this.cards()));
  /** `?group=id` (fase 13, «Show as cards»): kortvisningen begrenset til gruppens medlemmer, vist som chip «Group: Acme ×». */
  private readonly groupParam = toSignal(this.route.queryParamMap, { initialValue: this.route.snapshot.queryParamMap });
  readonly groupFilter = computed(() => {
    const id = this.groupParam()?.get('group');
    return id ? (this.groupsStore.byId().get(id) ?? null) : null;
  });
  readonly groups = this.groupsStore.groups;
  readonly visibleCards = computed(() => {
    const group = this.groupFilter();
    const cards = group ? this.cards().filter((c) => group.memberIds.includes(c.id)) : this.cards();
    return sortCards(filterCards(cards, this.debouncedSearch(), this.filters()), this.sort());
  });
  readonly allActive = computed(() => isAllActive(this.filters()) && !this.groupFilter());

  readonly sortOptions = computed<SelectOption<SortKey>[]>(() => SORT_KEYS.map((k) => ({ value: k, label: `${this.i18n.t('sort')}: ${this.i18n.t(SORT_LABEL_KEYS[k])}` })));
  readonly viewOptions = computed<SegmentOption<ViewKey>[]>(() => {
    const opts: SegmentOption<ViewKey>[] = [{ value: 'cards', label: this.i18n.t('cards') }];
    if (this.flags.compact()) opts.push({ value: 'compact', label: this.i18n.t('compact') });
    // Grupper er levert (fase 13): visningen finnes alltid.
    opts.push({ value: 'groups', label: this.i18n.t('groups') });
    return opts;
  });
  /** Segmentet rendres når flere visninger finnes (alltid fra fase 13). */
  readonly showViewSegment = computed(() => this.viewOptions().length > 1);
  readonly groupsView = computed(() => this.view() === 'groups');

  /** Klokken i sammendraget («live · 08:14:05»), fra den delte sekundklokken (steg 9.2). */
  private readonly now = computed(() => this.clock.second());
  /** Skjermleser-versjonen av sammendraget: oppdateres høyst hvert 30. s, uten klokken (steg 9.3). */
  readonly summaryLive = computed(() => {
    const c = this.counts();
    const t = (k: Parameters<I18nService['t']>[0]) => this.i18n.t(k);
    const tick = Math.floor(this.clock.second() / 30_000);
    void tick;
    return `${c.total} ${t(this.hasNodes() ? 'nodes' : 'servers').toLowerCase()} · ${c.up} ${t('up')} · ${c.down} ${t('down')}`;
  });
  readonly summary = computed(() => {
    const c = this.counts();
    const t = (k: Parameters<I18nService['t']>[0]) => this.i18n.t(k);
    const tail = this.conn.offline()
      ? t('offline').toLowerCase()
      : this.state() === 'connected'
        ? `${t('liveLabel')} · ${this.i18n.formatClock(this.now())}`
        : t(this.state() === 'reconnecting' ? 'reconnect' : 'loading').toLowerCase();
    if (!this.hasNodes()) return `${c.total} ${t('servers').toLowerCase()} · ${c.up} ${t('up')} · ${c.down} ${t('down')} · ${c.paused} ${t('paused')} · ${tail}`;
    return `${c.total} ${t('nodes').toLowerCase()} · ${c.servers} ${t('servers').toLowerCase()} · ${c.containers} ${t('containers').toLowerCase()} · ${c.up} ${t('up')} · ${c.down} ${t('down')} · ${c.sleeping} ${t('sleeping')} · ${c.paused} ${t('paused')} · ${tail}`;
  });

  readonly addOpen = signal(false);
  readonly addStep = signal<AddStep>(0);
  readonly addedCard = signal<CardDto | null>(null);
  /** «+ Add»-menyen (Server / Container) og containerdialogen (steg 12.10). */
  readonly addMenuOpen = signal(false);
  readonly addContainerOpen = signal(false);
  readonly addContainerStep = signal<AddContainerStep>(0);

  /** Leser uten egne servere: ingen «Add server», og en annen tom-tilstand. */
  /** Lesere (og demoen, steg 10.1) kan ikke legge til noder. */
  readonly isReader = computed(() => this.session.demoMode() || (!this.session.ownsAnyServer() && (this.session.user()?.readerOf ?? 0) > 0));
  readonly canAdd = computed(() => !this.isReader());
  readonly listLoaded = this.serverList.loaded;
  /** Ingen servere ifølge GET /api/servers. Kortene sjekkes ikke her: ServerAdded legger kortet i lageret før siden får beskjed. */
  private readonly listEmpty = computed(() => this.listLoaded() && this.serverList.servers().length === 0);
  /** Tom-tilstanden: listen er tom og ingen levende kort har kommet. */
  readonly noServers = computed(() => this.listEmpty() && this.cards().length === 0);
  readonly emptyOwner = computed(() => this.noServers() && !this.isReader());
  readonly emptyReader = computed(() => this.noServers() && this.isReader());
  /** Vi venter på en agent: skjerm 3 for en eier, eller dialogen på trinn 0. */
  readonly waitingForAgent = computed(() => (this.listEmpty() && !this.isReader()) || (this.addOpen() && this.addStep() === 0));

  constructor() {
    const title = inject(TitleService);
    effect(() => title.setKey(this.titleKey()));
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(this.live.subscribeOverview());
    void this.serverList.load().catch((err: unknown) => console.warn('[overview] could not load the server list', err));
    void this.groupsStore.load().catch((err: unknown) => console.warn('[overview] could not load the groups', err));
    destroyRef.onDestroy(
      this.live.onServerAdded((card) => {
        // Skjerm 3: mens vi venter (tom-tilstanden eller dialogens trinn 0) hopper dialogen til trinn 2 (indeks 1).
        if (this.waitingForAgent()) {
          this.addedCard.set(card);
          this.addStep.set(1);
          this.addOpen.set(true);
        }
        void this.serverList.load().catch(() => undefined);
      }),
    );
    destroyRef.onDestroy(this.live.onServerRemoved(() => void this.serverList.load().catch(() => undefined)));
    destroyRef.onDestroy(() => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
    });
  }

  // ---- verktøylinje og filter ---------------------------------------------------------------------

  onSearch(value: string): void {
    this.search.set(value);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      this.debouncedSearch.set(value);
    }, SEARCH_DEBOUNCE_MS);
  }

  onSort(value: SortKey | ''): void {
    if (value && SORT_KEYS.includes(value)) this.prefs.sort.set(value);
  }

  onView(value: ViewKey | null): void {
    if (value) this.prefs.view.set(value);
  }

  clearAll(): void {
    this.prefs.filters.set(clearFilters());
    if (this.groupFilter()) this.clearGroupFilter();
  }

  clearGroupFilter(): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: { group: null }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  // ---- grupper (fase 13) ---------------------------------------------------------------------------

  /** «Show as cards» på gruppekortet: kortvisningen med `?group=id`. */
  showGroupAsCards(id: string): void {
    this.prefs.view.set('cards');
    void this.router.navigate([], { relativeTo: this.route, queryParams: { group: id }, queryParamsHandling: 'merge' });
  }

  moveGroup(id: string, dir: -1 | 1): void {
    void this.groupsStore.move(id, dir).catch((err: unknown) => console.warn('[overview] could not move the group', err));
  }

  toggleTag(tag: string): void {
    this.prefs.filters.update((f) => toggleTag(f, tag));
  }

  toggleStatus(status: Exclude<OverviewFilters['status'], ''>): void {
    this.prefs.filters.update((f) => toggleStatus(f, status));
  }

  toggleAlert(): void {
    this.prefs.filters.update(toggleAlert);
  }

  toggleKind(kind: 'server' | 'container'): void {
    this.prefs.filters.update((f) => toggleKind(f, kind));
  }

  // ---- legg til server / container -----------------------------------------------------------------

  toggleAddMenu(): void {
    this.addMenuOpen.update((v) => !v);
  }

  openAdd(): void {
    this.addMenuOpen.set(false);
    this.addedCard.set(null);
    this.addStep.set(0);
    this.addOpen.set(true);
  }

  openAddContainer(): void {
    this.addMenuOpen.set(false);
    this.addContainerStep.set(0);
    this.addContainerOpen.set(true);
  }

  /** Klikk utenfor «+ Add»-menyen lukker den. */
  onDocumentClick(e: MouseEvent): void {
    if (!this.addMenuOpen()) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('[data-add-menu]')) return;
    this.addMenuOpen.set(false);
  }

  // ---- tastatur (FB 13.6) -------------------------------------------------------------------------

  /** `/` fokuserer søket når ingen skjemafelt har fokus. */
  onDocumentKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && this.addMenuOpen()) {
      this.addMenuOpen.set(false);
      return;
    }
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || this.addOpen() || this.addContainerOpen()) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.closest('input, textarea, select, [contenteditable="true"]') || target.isContentEditable)) return;
    const input = this.searchField()?.nativeElement.querySelector<HTMLInputElement>('input');
    if (!input) return;
    e.preventDefault();
    input.focus();
    input.select();
  }

  /** Piltaster flytter fokus mellom kortene; Enter åpner (håndteres av kortet). */
  onGridKeydown(e: KeyboardEvent): void {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const grid = this.grid()?.nativeElement;
    if (!grid) return;
    const cards = Array.from(grid.querySelectorAll<HTMLElement>('gp-server-card, gp-container-card'));
    if (cards.length === 0) return;
    const active = (e.target as HTMLElement | null)?.closest<HTMLElement>('gp-server-card, gp-container-card');
    const i = active ? cards.indexOf(active) : -1;
    let next: number;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = cards.length - 1;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = i < 0 ? 0 : Math.min(cards.length - 1, i + 1);
    else next = i < 0 ? 0 : Math.max(0, i - 1);
    e.preventDefault();
    cards[next].focus();
  }
}
