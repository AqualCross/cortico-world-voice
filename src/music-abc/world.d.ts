import type { ToolDef, WorldHost, WorldStreamSocket } from 'cortico/core/types.ts';

export const EVENT_TYPE: 'audio.abc_played';
export const TOOLS: ReadonlyArray<Omit<ToolDef, 'handler'>>;
export interface AbcConfig {
  enabled?: boolean;
  instrument: string;
  delivery: 'return' | 'event';
  eventDelivery: 'archive' | 'model';
}
export class AbcMusicWorld {
  constructor(options: {
    cfg: AbcConfig;
    dataDir: string;
    storageDir: string;
    worldId: string;
    botDir: string;
    packageDir: string;
    persist: (patch: Partial<AbcConfig>) => void;
  });
  tools(): ToolDef[];
  invoke(panel: string, method: string, args?: unknown[]): Promise<unknown>;
  stream(panel: string, socket: WorldStreamSocket): void;
  start(host: WorldHost): Promise<void>;
  stop(): Promise<void>;
}
