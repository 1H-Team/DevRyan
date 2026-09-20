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
export function executionSignal(): AbortSignal | undefined;
export function checkExecutionAdmission(): void;
export function withoutExecutionDeadline<T>(action: () => T): T;
export function executionPhase<T>(phase: string, action: () => T | Promise<T>): Promise<T>;
export function executionCleanup<T>(action: () => T | Promise<T>): Promise<T>;
export function waitForExecutionQueue<T>(previous: Promise<T>): Promise<T>;
export function withExecutionAdmission<T>(input: {
  sessionID?: string; userMessageID?: string; messageID?: string; callID?: string;
}, action: () => T | Promise<T>, options?: {
  timeoutMs?: number; signal?: AbortSignal; onDiagnostic?: (record: ExecutionDiagnostic) => void;
}): Promise<T>;
