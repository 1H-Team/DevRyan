export type SessionTitleOutboxJob = {
  key: string;
  sessionID: string;
  directory: string;
  sourceHash: string;
  candidateTitle: string;
  source: 'derived' | 'session_model' | 'free_zen' | 'local_fallback';
  replacesTitle?: string;
  state: 'pending_idle' | 'persisting';
  attemptCount: number;
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
  idleConfirmedAt: number;
  inactiveObservationCount: number;
  lastInactiveObservedAt: number;
  providerID: string;
  modelID: string;
};

export type SessionTitleOutbox = {
  filePath?: string;
  list(): Promise<SessionTitleOutboxJob[]>;
  upsert(job: SessionTitleOutboxJob): Promise<SessionTitleOutboxJob>;
  remove(key: string): Promise<boolean>;
  dispose(): Promise<void>;
};

export function createMemorySessionTitleOutbox(options?: {
  initialJobs?: SessionTitleOutboxJob[];
  now?: () => number;
}): SessionTitleOutbox;

export function createFileSessionTitleOutbox(options: {
  filePath: string;
  fsApi?: unknown;
  now?: () => number;
  logger?: Pick<Console, 'warn'>;
  onCorrupt?: (input: { error: unknown; destination: string }) => void | Promise<void>;
}): SessionTitleOutbox;
