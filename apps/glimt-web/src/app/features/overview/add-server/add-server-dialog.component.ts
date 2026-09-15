import { ChangeDetectionStrategy, Component, computed, effect, inject, input, model, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ApiService, errorKey } from '@core/api.service';
import { I18nKey, I18nService } from '@core/i18n.service';
import { CardDto, ServerListItem } from '@core/live.types';
import { ServerListService } from '@core/server-list.service';
import { TPipe } from '@core/t.pipe';
import { ButtonComponent } from '@shared/button/button.component';
import { InputComponent } from '@shared/input/input.component';
import { ModalComponent } from '@shared/modal/modal.component';
import { AutofocusDirective } from '@shared/util/autofocus.directive';
import { EnrolPanelComponent } from '../enrol/enrol-panel.component';
import { gbLabel } from '@shared/util/format';
import { osShort } from '../server-card/card-view';

export type AddStep = 0 | 1 | 2;

/** Samme regel som huben (ServerTags): 1–24 tegn a-z, 0-9 og bindestrek. */
export const TAG_PATTERN = /^[a-z0-9-]{1,24}$/;
export const MAX_TAGS = 10;

export function normalizeTag(raw: string): string | null {
  const tag = raw.trim().toLowerCase();
  return TAG_PATTERN.test(tag) ? tag : null;
}

/**
 * «Legg til server» (steg 4.4): `gp-modal` 560 px med tre trinn som i prototypen. (0) kommando, nøkkel, Docker-valg,
 * løfte, «venter» (gp-enrol-panel); (1) grønt kort «web-03 · connected · Ubuntu 24.04 · 2 cores · 4 GB», navnefelt
 * forhåndsutfylt med hostname, taggchips (eksisterende tagger + «+» for ny), «Next» lagrer med PATCH /api/servers/{id};
 * (2) forslag om appen med «Done» og «Show me» → /welcome. Kan lukkes når som helst; nøkkelen lever til den utløper.
 * Siden som eier dialogen flytter den til trinn 1 når `ServerAdded` kommer.
 */
@Component({
  selector: 'gp-add-server-dialog',
  imports: [ModalComponent, EnrolPanelComponent, InputComponent, ButtonComponent, AutofocusDirective, FormsModule, TPipe],
  templateUrl: './add-server-dialog.component.html',
  styleUrl: './add-server-dialog.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AddServerDialogComponent {
  readonly open = model(false);
  readonly step = model<AddStep>(0);
  /** Serveren som nettopp koblet til (trinn 1 og 2). */
  readonly server = input<CardDto | null>(null);
  /** Tagger fra brukerens andre servere, som chips. */
  readonly existingTags = input<string[]>([]);
  readonly saved = output<ServerListItem>();

  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly i18n = inject(I18nService);
  private readonly serverList = inject(ServerListService);

  readonly name = signal('');
  readonly tags = signal<string[]>([]);
  readonly addingTag = signal(false);
  readonly newTag = signal('');
  readonly tagError = signal<I18nKey | null>(null);
  readonly saving = signal(false);
  readonly error = signal<I18nKey | null>(null);

  readonly allTags = computed(() => {
    const seen = new Set<string>([...this.existingTags(), ...this.tags()]);
    return [...seen];
  });
  readonly canAddTag = computed(() => this.tags().length < MAX_TAGS);
  readonly connectedLine = computed(() => {
    const s = this.server();
    if (!s) return '';
    const parts = [this.i18n.t('connected'), osShort(s), s.cores ? `${s.cores} ${this.i18n.t('cores')}` : '', s.ramBytes ? `${gbLabel(s.ramBytes)} GB` : ''];
    return parts.filter(Boolean).join(' · ');
  });

  constructor() {
    effect(() => {
      const s = this.server();
      untracked(() => {
        this.name.set(s?.name ?? '');
        this.tags.set(s?.tags ?? []);
        this.addingTag.set(false);
        this.newTag.set('');
        this.tagError.set(null);
        this.error.set(null);
      });
    });
    effect(() => {
      if (!this.open()) untracked(() => this.step.set(0));
    });
  }

  hasTag(tag: string): boolean {
    return this.tags().includes(tag);
  }

  toggleTag(tag: string): void {
    this.tags.update((tags) => (tags.includes(tag) ? tags.filter((t) => t !== tag) : tags.length < MAX_TAGS ? [...tags, tag] : tags));
  }

  startTag(): void {
    this.addingTag.set(true);
    this.tagError.set(null);
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
    if (!this.tags().includes(tag) && this.tags().length < MAX_TAGS) this.tags.update((tags) => [...tags, tag]);
    this.newTag.set('');
    this.tagError.set(null);
    this.addingTag.set(false);
  }

  onTagInput(e: Event): void {
    this.newTag.set((e.target as HTMLInputElement).value);
  }

  onTagKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.commitTag();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.newTag.set('');
      this.addingTag.set(false);
    }
  }

  async next(): Promise<void> {
    const s = this.server();
    if (!s || this.saving()) return;
    const name = this.name().trim() || s.hostname;
    this.saving.set(true);
    this.error.set(null);
    try {
      const item = await this.api.patch<ServerListItem>(`/servers/${encodeURIComponent(s.id)}`, { name, tags: this.tags() });
      void this.serverList.load().catch(() => undefined);
      this.saved.emit(item);
      this.step.set(2);
    } catch (err) {
      this.error.set(errorKey(err));
    } finally {
      this.saving.set(false);
    }
  }

  done(): void {
    this.open.set(false);
  }

  showMe(): void {
    this.open.set(false);
    void this.router.navigate(['/welcome']);
  }
}
