import { computed, inject, Injectable } from '@angular/core';
import { ConfigService } from './config.service';

/** Flaggene fra GLIMT_FEATURE_FLAGS (example.env): textmode,snapshot,share,compact,whatsnew,certs,containersPage,crossLogs. `groups` er levert (fase 13) og finnes ikke lenger som flagg. */
export type FeatureFlag = 'textmode' | 'snapshot' | 'share' | 'compact' | 'whatsnew' | 'certs' | 'containersPage' | 'crossLogs' | 'twofa' | 'pause';

@Injectable({ providedIn: 'root' })
export class FeatureFlags {
  private readonly config = inject(ConfigService);

  readonly all = computed(() => new Set(this.config.config().featureFlags));
  readonly containersPage = computed(() => this.all().has('containersPage'));
  readonly textMode = computed(() => this.all().has('textmode'));
  readonly snapshot = computed(() => this.all().has('snapshot'));
  readonly share = computed(() => this.all().has('share'));
  readonly compact = computed(() => this.all().has('compact'));
  readonly whatsNew = computed(() => this.all().has('whatsnew'));
  readonly certs = computed(() => this.all().has('certs'));
  readonly crossLogs = computed(() => this.all().has('crossLogs'));
  /** Fase 8: tofaktor og pause av noder er Neste og finnes bare bak flagg. */
  readonly twofa = computed(() => this.all().has('twofa'));
  readonly pause = computed(() => this.all().has('pause'));

  has(flag: FeatureFlag | string): boolean {
    return this.all().has(flag);
  }
}
