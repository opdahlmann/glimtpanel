import { computed, inject, Injectable } from '@angular/core';
import { ConfigService } from './config.service';

/** Flaggene fra GLIMT_FEATURE_FLAGS (example.env): textmode,snapshot,share,compact,groups,whatsnew,certs,containersPage,crossLogs. */
export type FeatureFlag = 'textmode' | 'snapshot' | 'share' | 'compact' | 'groups' | 'whatsnew' | 'certs' | 'containersPage' | 'crossLogs';

@Injectable({ providedIn: 'root' })
export class FeatureFlags {
  private readonly config = inject(ConfigService);

  readonly all = computed(() => new Set(this.config.config().featureFlags));
  readonly containersPage = computed(() => this.all().has('containersPage'));
  readonly textMode = computed(() => this.all().has('textmode'));
  readonly snapshot = computed(() => this.all().has('snapshot'));
  readonly share = computed(() => this.all().has('share'));
  readonly compact = computed(() => this.all().has('compact'));
  readonly groups = computed(() => this.all().has('groups'));
  readonly whatsNew = computed(() => this.all().has('whatsnew'));
  readonly certs = computed(() => this.all().has('certs'));
  readonly crossLogs = computed(() => this.all().has('crossLogs'));

  has(flag: FeatureFlag | string): boolean {
    return this.all().has(flag);
  }
}
