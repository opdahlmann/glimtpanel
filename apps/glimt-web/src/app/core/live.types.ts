/** Tilstanden til SignalR-forbindelsen mot /hub/live. */
export type LiveState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

/** Hub → klient `ServerStatus(dto)` (IMPLEMENTERINGSPLAN 4.3, skjelettet i steg 0.9). */
export interface ServerStatusDto {
  id: string;
  name: string;
  hostname: string;
  status: 'up' | 'down';
  /** ISO 8601 eller null hvis agenten aldri har meldt seg. */
  lastSeenAt: string | null;
  connected: boolean;
  agentVersion: string;
  os: string;
  arch: string;
  cores: number;
  ramBytes: number;
}
