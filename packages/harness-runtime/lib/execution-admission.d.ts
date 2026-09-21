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
export function executionCleanup<T>(action: () => T | Promise<T>): Promise<T>;
export function waitForExecutionQueue<T>(previous: Promise<T>, progress?: ExecutionProgressMeter): Promise<T>;
export function withExecutionAdmission<T>(input: {
  sessionID?: string; userMessageID?: string; messageID?: string; callID?: string;
}, action: () => T | Promise<T>, options?: {
  timeoutMs?: number; signal?: AbortSignal; onDiagnostic?: (record: ExecutionDiagnostic) => void;
}): Promise<T>;
export function withExecutionPreparation<T>(input: {
  sessionID?: string; userMessageID?: string; messageID?: string; callID?: string;
}, action: () => T | Promise<T>, options?: {
  timeoutMs?: number; stallMs?: number; signal?: AbortSignal; onDiagnostic?: (record: ExecutionDiagnostic) => void;
}): Promise<T>;
