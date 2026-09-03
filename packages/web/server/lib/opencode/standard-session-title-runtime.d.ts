export const SESSION_TITLE_HELPER_AGENT: string;
export const SESSION_TITLE_HELPER_SESSION_TITLE: string;

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
  source: 'derived' | 'session_model';
};

export function normalizeGeneratedSessionTitle(
  value: unknown,
  sourceText?: string,
  options?: { rejectSourceMatch?: boolean },
): string | null;

export function deriveLocalSessionTitle(sourceText: unknown): string;

export function createStandardSessionTitleRuntime(options?: Record<string, unknown>): StandardSessionTitleRuntime;
