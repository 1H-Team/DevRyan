import type { MutationFile, MutationTarget, SessionMutationRuntime } from './session-mutations.js';

export interface MutationSession {
  id: string;
  directory: string;
  revert?: { messageID: string; partID?: string; fileRestore?: boolean };
  [key: string]: unknown;
}
export interface MutationSessionReference { directory: string; sessionID: string }
export interface MutationTerminationRequest { directory: string; sessions: string[]; transactionID: string }
export interface MutationTerminationReceipt { terminated: true; sessions: string[] }
export interface SessionRevertCoordinator {
  revert(input: MutationSessionReference & { messageID: string; scope?: 'tree' | 'session' }): Promise<MutationSession & {
    session: MutationSession;
    reverted: { files: MutationFile[]; sessions: MutationTarget[] };
    verification: { ok: true; transactionID: string };
    redoAvailable: boolean;
    outcome?: 'partial'; conflicts?: Array<{ path: string }>;
  }>;
  redo(input: MutationSessionReference): Promise<MutationSession & {
    session: MutationSession; restored: MutationFile[]; sessions: Array<{ id: string }>;
    verification: { ok: true; transactionID: string };
    outcome?: 'partial'; conflicts?: Array<{ path: string }>;
  }>;
  recover(input: { directory: string }): Promise<void>;
  restoreFiles(input: MutationSessionReference & { revision: string; redo?: boolean;
    calls: Array<{ sessionID: string; callID: string; messageID?: string }> }): Promise<{
    files: MutationFile[]; sessions: MutationTarget[]; redoAvailable: boolean;
  }>;
}
export function createSessionRevertCoordinator(options: {
  directory: string;
  runtime: SessionMutationRuntime;
  conversation: {
    capabilities(input: { directory: string }): Promise<{ legacyConversationRevert?: number }>;
    get(input: MutationSessionReference): Promise<MutationSession>;
    revert(input: MutationSessionReference & { messageID: string; partID?: string; files: false }): Promise<MutationSession>;
    unrevert(input: MutationSessionReference): Promise<MutationSession>;
    /** Required with `legacy`: direct children and one message for adopted conversations. */
    children?(input: MutationSessionReference): Promise<Array<{ id: string }>>;
    message?(input: MutationSessionReference & { messageID: string }): Promise<{ info: { id: string; role: string; time: { created: number } } }>;
  };
  /** Uncaptured change evidence for conversations that ran without the companion. */
  legacy?: {
    history(input: { directory: string; sessionIDs: string[]; since: number }): Promise<Array<{ path: string;
      current: { mode: string; oid: string } | null; previous: { mode: string; oid: string } | null }>>;
    blob(input: { directory: string; oid: string }): Promise<Uint8Array>;
  };
  executions: {
    isConfined(input: { directory: string }): Promise<boolean>;
    cancelAndWait(input: MutationTerminationRequest): Promise<MutationTerminationReceipt>;
  };
  onDiagnostic?(event: { event: 'session_revert'; transactionID: string; sessionID?: string; messageID?: string; phase: string; code?: string; errorID?: string }): void | Promise<void>;
}): SessionRevertCoordinator;
