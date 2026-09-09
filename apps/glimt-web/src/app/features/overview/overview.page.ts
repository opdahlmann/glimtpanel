import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, OnInit } from '@angular/core';
import { DatePipe } from '@angular/common';
import { LiveService } from '@core/live.service';

/**
 * Midlertidig oversikt for det gående skjelettet (IMPLEMENTERINGSPLAN steg 0.9).
 * Erstattes av serverkort og layout-skall i fase 3–4, men bruker allerede tokens og gp-prefiks.
 */
@Component({
  selector: 'gp-overview-page',
  imports: [DatePipe],
  templateUrl: './overview.page.html',
  styleUrl: './overview.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OverviewPage implements OnInit {
  private readonly live = inject(LiveService);

  readonly state = this.live.state;
  readonly servers = this.live.servers;
  readonly connected = computed(() => this.state() === 'connected');

  constructor() {
    inject(DestroyRef).onDestroy(() => void this.live.stop());
  }

  ngOnInit(): void {
    void this.live.start();
  }

  /** Bytes -> GB med én desimal, f.eks. 8589934592 -> "8.0". */
  gigabytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return '0';
    }
    return (bytes / 1024 ** 3).toFixed(1);
  }
}
