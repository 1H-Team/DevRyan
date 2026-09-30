import type { Session } from '@opencode-ai/sdk/v2';
import type { WorktreeMetadata } from '@/types/worktree';
import type { SessionPlanRevisionIdentity } from '@/lib/api/types';

export type SessionPlanUpdated = SessionPlanRevisionIdentity & { version: string };
const planUpdatedListeners = new Set<(event: SessionPlanUpdated) => void>();

export const notifyPlanUpdated = (properties: unknown): void => {
  if (!properties || typeof properties !== 'object') return;
  const value = properties as Record<string, unknown>;
  if (typeof value.sessionID !== 'string' || !value.sessionID
    || typeof value.sourceMessageID !== 'string' || !value.sourceMessageID
    || typeof value.directory !== 'string' || !value.directory
    || typeof value.sessionCreated !== 'number' || !Number.isSafeInteger(value.sessionCreated) || value.sessionCreated <= 0
    || typeof value.sessionSlug !== 'string' || !value.sessionSlug
    || typeof value.version !== 'string' || !value.version) return;
  const event = { sessionId: value.sessionID, sourceMessageId: value.sourceMessageID,
    directory: value.directory, sessionCreated: value.sessionCreated, sessionSlug: value.sessionSlug, version: value.version };
  planUpdatedListeners.forEach(listener => listener(event));
};

export type SessionDeleteRequest = {
  sessions: Session[];
  dateLabel?: string;
  mode?: 'session' | 'worktree';
  worktree?: WorktreeMetadata | null;
  suppressSuccessToast?: boolean;
};

export type SessionCreateRequest = {
  worktreeMode?: 'main' | 'create' | 'reuse';
  parentID?: string | null;
  projectId?: string | null;
};

type DeleteListener = (request: SessionDeleteRequest) => void;
type CreateListener = (request: SessionCreateRequest) => void;
type DirectoryListener = () => void;
type GitRefreshHint = { directory: string; sessionChanges?: boolean; sessionID?: string };
type GitRefreshListener = (hint: GitRefreshHint) => void;

const deleteListeners = new Set<DeleteListener>();
const createListeners = new Set<CreateListener>();
const directoryListeners = new Set<DirectoryListener>();
const gitRefreshListeners = new Set<GitRefreshListener>();

export const sessionEvents = {
  onPlanUpdated(listener: (event: SessionPlanUpdated) => void) {
    planUpdatedListeners.add(listener);
    return () => { planUpdatedListeners.delete(listener); };
  },
  onDeleteRequest(listener: DeleteListener) {
    deleteListeners.add(listener);
    return () => {
      deleteListeners.delete(listener);
    };
  },
  requestDelete(payload: SessionDeleteRequest) {
    if (!payload.sessions.length && payload.mode !== 'worktree') {
      return;
    }
    deleteListeners.forEach((listener) => listener(payload));
  },
  onCreateRequest(listener: CreateListener) {
    createListeners.add(listener);
    return () => {
      createListeners.delete(listener);
    };
  },
  requestCreate(payload?: SessionCreateRequest) {
    const request = payload ?? {};
    createListeners.forEach((listener) => listener(request));
  },
  onDirectoryRequest(listener: DirectoryListener) {
    directoryListeners.add(listener);
    return () => {
      directoryListeners.delete(listener);
    };
  },
  requestDirectoryDialog() {
    directoryListeners.forEach((listener) => listener());
  },
  onGitRefreshHint(listener: GitRefreshListener) {
    gitRefreshListeners.add(listener);
    return () => {
      gitRefreshListeners.delete(listener);
    };
  },
  requestGitRefresh(hint: GitRefreshHint) {
    if (!hint.directory.trim()) {
      return;
    }
    gitRefreshListeners.forEach((listener) => listener(hint));
  },
};
