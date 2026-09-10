import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, signal, untracked } from '@angular/core';
import { ApiService, errorKey } from '@core/api.service';
import { ClipboardService } from '@core/clipboard.service';
import { I18nKey, I18nService } from '@core/i18n.service';
import { TPipe } from '@core/t.pipe';
import { ButtonComponent } from '@shared/button/button.component';
import { SegmentComponent, SegmentOption } from '@shared/segment/segment.component';

/** `POST /api/servers/enrol-key` (hub: EnrolKeyResponse). */
export interface EnrolKey {
  key: string;
  command: string;
  /** ISO 8601. */
  expiresAt: string;
  dockerMode: string;
}

export type DockerMode = 'proxy' | 'simple';

/** «Copied» vises så lenge på knappen (steg 4.3). */
export const COPIED_MS = 1800;

const pad = (n: number): string => String(n).padStart(2, '0');

/** Sekunder → "59:42" (eller "1:02:10" over en time). */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/**
 * «Kjør dette på serveren» (steg 4.3, skjerm 3 og dialogens trinn 0): henter engangsnøkkelen ved visning, teller ned
 * fra `expiresAt`, gir ny nøkkel med én knapp når den er utløpt, Docker-segmentet (Secure / Simple) henter en ny nøkkel
 * med det valget (huben lagrer valget på nøkkelen), Copy via ClipboardService, «kun lesing»-løftet og «Waiting for the agent…».
 */
@Component({
  selector: 'gp-enrol-panel',
  imports: [SegmentComponent, ButtonComponent, TPipe],
  templateUrl: './enrol-panel.component.html',
  styleUrl: './enrol-panel.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EnrolPanelComponent {
  private readonly api = inject(ApiService);
  private readonly clipboard = inject(ClipboardService);
  private readonly i18n = inject(I18nService);

  readonly mode = signal<DockerMode>('proxy');
  readonly key = signal<EnrolKey | null>(null);
  readonly loading = signal(false);
  readonly error = signal<I18nKey | null>(null);
  readonly copied = signal(false);
  private readonly now = signal(Date.now());

  readonly remainingMs = computed(() => {
    const k = this.key();
    return k ? Date.parse(k.expiresAt) - this.now() : 0;
  });
  readonly expired = computed(() => this.key() !== null && this.remainingMs() <= 0);
  readonly countdown = computed(() => formatCountdown(this.remainingMs()));
  readonly dockerOptions = computed<SegmentOption<DockerMode>[]>(() => [
    { value: 'proxy', label: this.i18n.t('secure') },
    { value: 'simple', label: this.i18n.t('simple') },
  ]);
  readonly dockerNote = computed(() => this.i18n.t(this.mode() === 'proxy' ? 'dockerSecure' : 'dockerSimple'));

  private ticker: ReturnType<typeof setInterval> | null = null;
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;
  private requestSeq = 0;

  constructor() {
    // Første kjøring henter nøkkelen; hvert bytte av Docker-valg henter en ny med det valget.
    effect(() => {
      const mode = this.mode();
      untracked(() => void this.request(mode));
    });
    this.ticker = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => {
      if (this.ticker) clearInterval(this.ticker);
      if (this.copiedTimer) clearTimeout(this.copiedTimer);
    });
  }

  onMode(mode: DockerMode | null): void {
    if (mode && mode !== this.mode()) this.mode.set(mode);
  }

  renew(): void {
    void this.request(this.mode());
  }

  async copy(): Promise<void> {
    const k = this.key();
    if (!k || this.expired()) return;
    if (!(await this.clipboard.copy(k.command))) return;
    this.copied.set(true);
    if (this.copiedTimer) clearTimeout(this.copiedTimer);
    this.copiedTimer = setTimeout(() => this.copied.set(false), COPIED_MS);
  }

  private async request(mode: DockerMode): Promise<void> {
    const seq = ++this.requestSeq;
    this.loading.set(true);
    this.error.set(null);
    try {
      const k = await this.api.post<EnrolKey>('/servers/enrol-key', { dockerMode: mode });
      if (seq !== this.requestSeq) return;
      this.now.set(Date.now());
      this.key.set(k);
    } catch (err) {
      if (seq !== this.requestSeq) return;
      this.error.set(errorKey(err));
    } finally {
      if (seq === this.requestSeq) this.loading.set(false);
    }
  }
}
