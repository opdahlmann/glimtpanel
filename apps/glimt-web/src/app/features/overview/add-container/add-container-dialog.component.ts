import { ChangeDetectionStrategy, Component, computed, effect, inject, input, model, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, errorKey } from '@core/api.service';
import { ClipboardService } from '@core/clipboard.service';
import { I18nKey, I18nService } from '@core/i18n.service';
import { LiveStore } from '@core/live.store';
import { CreateNodeResponse } from '@core/live.types';
import { ServerListService } from '@core/server-list.service';
import { TPipe } from '@core/t.pipe';
import { ButtonComponent } from '@shared/button/button.component';
import { InputComponent } from '@shared/input/input.component';
import { ModalComponent } from '@shared/modal/modal.component';
import { SegmentComponent, SegmentOption } from '@shared/segment/segment.component';
import { AutofocusDirective } from '@shared/util/autofocus.directive';
import { MAX_TAGS, normalizeTag } from '../add-server/add-server-dialog.component';
import { applyOptions, SnippetVariant } from './snippets';

export type AddContainerStep = 0 | 1 | 2;

/**
 * «Legg til container» (steg 12.10, skjerm 22): `gp-modal` 560 px i tre trinn. (0) navn og «Create» →
 * `POST /api/servers { kind: container, name }`; (1) tokenet vist én gang i `<code>` med Copy og «shown only once»,
 * segmentet Sidecar (Compose) / In your image bytter snutt, valgfrie felt fyller `GLIMT_HEALTH_URL`, `GLIMT_CHECKS` og
 * `GLIMT_LOG_PATHS` inn i snutten, og «Waiting for the container…» til kortets status blir `up` (ServerStatus);
 * (2) tagger og «Done» (PATCH /api/servers/{id}). Kan lukkes når som helst; tokenet er da borte fra skjermen.
 */
@Component({
  selector: 'gp-add-container-dialog',
  imports: [ModalComponent, InputComponent, ButtonComponent, SegmentComponent, AutofocusDirective, FormsModule, TPipe],
  templateUrl: './add-container-dialog.component.html',
  styleUrls: ['../add-server/add-server-dialog.component.css', './add-container-dialog.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AddContainerDialogComponent {
  readonly open = model(false);
  readonly step = model<AddContainerStep>(0);
  readonly existingTags = input<string[]>([]);

  private readonly api = inject(ApiService);
  private readonly i18n = inject(I18nService);
  private readonly clipboard = inject(ClipboardService);
  private readonly store = inject(LiveStore);
  private readonly serverList = inject(ServerListService);

  readonly name = signal('');
  readonly creating = signal(false);
  readonly error = signal<I18nKey | null>(null);
  readonly created = signal<CreateNodeResponse | null>(null);
  readonly variant = signal<SnippetVariant>('compose');
  readonly healthUrl = signal('');
  readonly checks = signal('');
  readonly logPaths = signal('');
  readonly copiedToken = signal(false);
  readonly copiedSnippet = signal(false);

  readonly tags = signal<string[]>([]);
  readonly addingTag = signal(false);
  readonly newTag = signal('');
  readonly tagError = signal<I18nKey | null>(null);
  readonly saving = signal(false);

  readonly variantOptions = computed<SegmentOption<SnippetVariant>[]>(() => {
    this.i18n.lang();
    return [
      { value: 'compose', label: this.i18n.t('sidecarCompose') },
      { value: 'dockerfile', label: this.i18n.t('inYourImage') },
    ];
  });
  readonly snippet = computed(() => {
    const c = this.created();
    if (!c) return '';
    const raw = this.variant() === 'compose' ? c.compose : c.dockerfile;
    return applyOptions(raw, this.variant(), { healthUrl: this.healthUrl(), checks: this.checks(), logPaths: this.logPaths() });
  });
  /** Kortet til den nye noden: `ServerStatus` gir `up` når sidecaren kobler til. */
  readonly card = computed(() => {
    const c = this.created();
    return c ? this.store.card(c.id)() : null;
  });
  readonly connected = computed(() => this.card()?.status === 'up');
  readonly allTags = computed(() => [...new Set([...this.existingTags(), ...this.tags()])]);
  readonly canAddTag = computed(() => this.tags().length < MAX_TAGS);
  readonly canCreate = computed(() => this.name().trim().length > 0 && !this.creating());

  constructor() {
    effect(() => {
      if (this.step() === 1 && this.connected()) untracked(() => this.step.set(2));
    });
    effect(() => {
      if (!this.open()) untracked(() => this.reset());
    });
  }

  private reset(): void {
    this.step.set(0);
    this.name.set('');
    this.created.set(null);
    this.error.set(null);
    this.creating.set(false);
    this.variant.set('compose');
    this.healthUrl.set('');
    this.checks.set('');
    this.logPaths.set('');
    this.copiedToken.set(false);
    this.copiedSnippet.set(false);
    this.tags.set([]);
    this.addingTag.set(false);
    this.newTag.set('');
    this.tagError.set(null);
    this.saving.set(false);
  }

  // ---- trinn 0 -------------------------------------------------------------------------------------

  async create(): Promise<void> {
    const name = this.name().trim();
    if (!name || this.creating()) return;
    this.creating.set(true);
    this.error.set(null);
    try {
      const res = await this.api.post<CreateNodeResponse>('/servers', { kind: 'container', name });
      this.created.set(res);
      this.step.set(1);
      void this.serverList.load().catch(() => undefined);
    } catch (err) {
      this.error.set(errorKey(err));
    } finally {
      this.creating.set(false);
    }
  }

  // ---- trinn 1 -------------------------------------------------------------------------------------

  onVariant(v: SnippetVariant | null): void {
    if (v) this.variant.set(v);
  }

  async copyToken(): Promise<void> {
    const c = this.created();
    if (!c) return;
    this.copiedToken.set(await this.clipboard.copy(c.token));
    setTimeout(() => this.copiedToken.set(false), 1500);
  }

  async copySnippet(): Promise<void> {
    if (!this.snippet()) return;
    this.copiedSnippet.set(await this.clipboard.copy(this.snippet()));
    setTimeout(() => this.copiedSnippet.set(false), 1500);
  }

  // ---- trinn 2: tagger som i «Legg til server» ---------------------------------------------------

  hasTag(tag: string): boolean {
    return this.tags().includes(tag);
  }

  toggleTag(tag: string): void {
    this.tags.update((tags) => (tags.includes(tag) ? tags.filter((t) => t !== tag) : tags.length < MAX_TAGS ? [...tags, tag] : tags));
  }

  startTag(): void {
    this.newTag.set('');
    this.tagError.set(null);
    this.addingTag.set(true);
  }

  onTagInput(e: Event): void {
    this.newTag.set((e.target as HTMLInputElement).value);
    this.tagError.set(null);
  }

  onTagKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.commitTag();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.addingTag.set(false);
    }
  }

  commitTag(): void {
    const raw = this.newTag();
    if (!raw.trim()) {
      this.addingTag.set(false);
      return;
    }
    const tag = normalizeTag(raw);
    if (!tag) {
      this.tagError.set('invalidTag');
      return;
    }
    if (!this.tags().includes(tag) && this.tags().length < MAX_TAGS) this.tags.update((t) => [...t, tag]);
    this.addingTag.set(false);
  }

  async done(): Promise<void> {
    const c = this.created();
    if (!c || this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      if (this.tags().length > 0) await this.api.patch(`/servers/${encodeURIComponent(c.id)}`, { tags: this.tags() });
      void this.serverList.load().catch(() => undefined);
      this.open.set(false);
    } catch (err) {
      this.error.set(errorKey(err));
    } finally {
      this.saving.set(false);
    }
  }
}
