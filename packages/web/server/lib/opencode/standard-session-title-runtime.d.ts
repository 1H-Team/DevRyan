export const SESSION_TITLE_PRIMARY_ZEN_MODEL: string;
export const SESSION_TITLE_HELPER_AGENT: string;
export const SESSION_TITLE_HELPER_SESSION_TITLE: string;
export const DEFAULT_TITLE_FALLBACK_ZEN_MODEL: string;
export const TITLE_ZEN_MODEL_ROTATION: readonly string[];

export type StandardSessionTitleScheduleInput = {
  sessionID: string;
  directory?: string;
  text?: string;
  providerID?: string;
  modelID?: string;
  variant?: string;
};

export type StandardSessionTitleRuntime = {
  schedule(input?: StandardSessionTitleScheduleInput): Promise<boolean>;
  schedulePlaceholderRecovery(input?: { directory?: string }): Promise<boolean>;
  cleanupStaleHelpers(input?: { directory?: string }): Promise<number>;
  processOpenCodeEvent(payload: unknown): Promise<boolean>;
  dispose(): Promise<void>;
};

export type StandardSessionTitleGeneratedInput = {
  session: Record<string, unknown>;
  title: string;
  directory?: string;
  source: 'free_zen' | 'session_model' | 'local_fallback';
};

export function normalizeGeneratedSessionTitle(
  value: unknown,
  sourceText?: string,
  options?: { rejectSourceMatch?: boolean },
): string | null;

export function deriveLocalSessionTitle(sourceText: unknown): string;

export function createStandardSessionTitleRuntime(options?: Record<string, unknown>): StandardSessionTitleRuntime;
