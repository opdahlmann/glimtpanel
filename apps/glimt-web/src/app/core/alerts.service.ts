import { inject, Injectable } from '@angular/core';
import { AlertStore } from './alert.store';
import { ApiService } from './api.service';
import { AlertSettingsDto, DigestDto, RuleSettingDto, ServerAlertSettingsDto, SilenceChoice } from './live.types';

export interface PutChannelsRequest {
  push?: boolean;
  email?: boolean;
  webhookUrl?: string;
  digest?: DigestDto;
  rotateWebhookSecret?: boolean;
}

export interface PutServerAlertSettingsRequest {
  useAccountDefaults?: boolean;
  muted?: boolean;
  clearSilence?: boolean;
  rules?: Record<string, RuleSettingDto>;
}

/** REST for varsler og varselinnstillinger (IMPLEMENTERINGSPLAN 4.3): stille, kontoinnstillinger, kanaler, per server, push-abonnementer. */
@Injectable({ providedIn: 'root' })
export class AlertsService {
  private readonly api = inject(ApiService);
  private readonly store = inject(AlertStore);

  async silence(serverId: string, until: SilenceChoice): Promise<string | null> {
    const res = await this.api.post<{ serverId: string; silencedUntil: string | null }>('/alerts/silence', { serverId, until });
    this.store.markSilenced(serverId, true);
    return res.silencedUntil;
  }

  getSettings(): Promise<AlertSettingsDto> {
    return this.api.get<AlertSettingsDto>('/alert-settings');
  }

  putRules(rules: Record<string, RuleSettingDto>): Promise<AlertSettingsDto> {
    return this.api.put<AlertSettingsDto>('/alert-settings', { rules });
  }

  putChannels(request: PutChannelsRequest): Promise<AlertSettingsDto> {
    return this.api.put<AlertSettingsDto>('/channels', request);
  }

  testWebhook(): Promise<{ ok: boolean; status: number | null }> {
    return this.api.post<{ ok: boolean; status: number | null }>('/channels/webhook-test');
  }

  getServerSettings(serverId: string): Promise<ServerAlertSettingsDto> {
    return this.api.get<ServerAlertSettingsDto>(`/servers/${encodeURIComponent(serverId)}/alert-settings`);
  }

  putServerSettings(serverId: string, request: PutServerAlertSettingsRequest): Promise<ServerAlertSettingsDto> {
    return this.api.put<ServerAlertSettingsDto>(`/servers/${encodeURIComponent(serverId)}/alert-settings`, request);
  }

  addPushSubscription(endpoint: string, keys: { p256dh: string; auth: string }, device: string): Promise<void> {
    return this.api.post<void>('/push-subscriptions', { endpoint, keys, device });
  }

  removePushSubscription(endpoint: string): Promise<void> {
    return this.api.delete<void>('/push-subscriptions', { endpoint });
  }
}
