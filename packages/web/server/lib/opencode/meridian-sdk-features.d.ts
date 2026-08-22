export type MeridianPromptMode = 'client-only' | 'claude-only' | 'combined' | 'none' | 'custom';

export type MeridianPromptModeResult =
  | { ok: true; mode: MeridianPromptMode; compatibilityMode: boolean }
  | { ok: false; code: string; error: string };

export type MeridianPromptModeWriteResult =
  | { ok: true; changed: boolean; mode: MeridianPromptMode; compatibilityMode: boolean }
  | { ok: false; changed: false; code: string; error: string };

export function readMeridianPromptMode(options?: Record<string, unknown>): MeridianPromptModeResult;
export function setMeridianPromptCompatibilityMode(
  compatibilityMode: boolean,
  options?: Record<string, unknown>,
): MeridianPromptModeWriteResult;
