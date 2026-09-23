export interface ExecutionDiagnostic {
  event: 'session_execution';
  sessionID?: string;
  userMessageID?: string;
  messageID?: string;
  callID?: string;
  phase: string;
  state: 'started' | 'completed' | 'failed';
  elapsedMs?: number;
  code?: string;
  slow?: boolean;
  /** Summary records: `phase:count/elapsedMs` per phase, comma-separated. */
  steps?: string;
}
export function executionRemainingMs(): number;
export function executionSignal(): AbortSignal | undefined;
export function checkExecutionAdmission(): void;
export function executionProgress(): void;
export interface ExecutionProgressMeter { progress: number; waiters: number; following?: ExecutionProgressMeter; }
export function executionProgressMeter(): ExecutionProgressMeter | undefined;
export function withExecutionSlotWait<T>(action: () => T | Promise<T>): Promise<T>;
export function withoutExecutionDeadline<T>(action: () => T): T;
export function executionPhase<T>(phase: string, action: () => T | Promise<T>): Promise<T>;
export function quietExecutionPhase<T>(phase: string, action: () => T | Promise<T>, slowMs?: number): Promise<T>;
export function executionCleanup<T>(action: () => T | Promise<T>): Promise<T>;
export function waitForExecutionQueue<T>(previous: Promise<T>, progress?: ExecutionProgressMeter): Promise<T>;
export function withExecutionMeter<T>(action: () => T): T;
export function withExecutionAdmission<T>(input: {
  sessionID?: string; userMessageID?: string; messageID?: string; callID?: string;
}, action: () => T | Promise<T>, options?: {
  /** Absolute cap. */ timeoutMs?: number;
  /** Expire once neither this work nor the followed lock holder progressed for this long. */ idleMs?: number;
  signal?: AbortSignal; onDiagnostic?: (record: ExecutionDiagnostic) => void;
  /** Journal one record per admission (with per-phase `steps`) when it failed or took at least `minMs`;
   * phases are journaled individually only when they fail or run for `slowMs` (default 2 s). */
  summary?: { minMs?: number; slowMs?: number };
}): Promise<T>;
export function withExecutionPreparation<T>(input: {
  sessionID?: string; userMessageID?: string; messageID?: string; callID?: string;
}, action: () => T | Promise<T>, options?: {
  timeoutMs?: number; stallMs?: number; signal?: AbortSignal; onDiagnostic?: (record: ExecutionDiagnostic) => void;
  summary?: { minMs?: number; slowMs?: number };
}): Promise<T>;
