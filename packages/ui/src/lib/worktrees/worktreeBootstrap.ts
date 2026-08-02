import * as gitHttp from '@/lib/gitApiHttp';
import type { GitWorktreeBootstrapStatus, RuntimeAPIs } from '@/lib/api/types';

declare global {
  interface Window {
    __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs;
  }
}

type CacheEntry = {
  status: GitWorktreeBootstrapStatus;
  operationId: string | null;
  pollPromise: Promise<void> | null;
  listeners: Set<() => void>;
};

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 250;
const cache = new Map<string, CacheEntry>();

const normalizePath = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '') || value;
const getKey = (directory: string): string => normalizePath(directory);
const pause = (delayMs: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, delayMs));

const pendingStatus = (directory: string, operationId: string | null): GitWorktreeBootstrapStatus => ({
  operationId,
  idempotencyKey: null,
  directory,
  stage: 'prepare_remote',
  status: 'queued',
  error: null,
  updatedAt: Date.now(),
  attempt: 1,
  warnings: [],
  stages: {},
});

const notify = (entry: CacheEntry): void => {
  for (const listener of entry.listeners) listener();
};

const ensureEntry = (
  directory: string,
  initial?: GitWorktreeBootstrapStatus,
): CacheEntry => {
  const key = getKey(directory);
  const existing = cache.get(key);
  if (existing) {
    if (initial) {
      existing.status = initial;
      existing.operationId = initial.operationId;
      notify(existing);
    }
    return existing;
  }
  const status = initial ?? pendingStatus(directory, null);
  const entry: CacheEntry = {
    status,
    operationId: status.operationId,
    pollPromise: null,
    listeners: new Set(),
  };
  cache.set(key, entry);
  return entry;
};

const getRuntimeGit = () => (
  typeof window !== 'undefined' ? window.__OPENCHAMBER_RUNTIME_APIS__?.git : undefined
);

const fetchStatus = async (
  directory: string,
  operationId: string | null,
): Promise<GitWorktreeBootstrapStatus> => {
  const runtimeGit = getRuntimeGit();
  if (operationId) {
    if (runtimeGit?.worktree?.operation) return runtimeGit.worktree.operation(operationId);
    if (runtimeGit?.getGitWorktreeBootstrapOperation) {
      return runtimeGit.getGitWorktreeBootstrapOperation(operationId);
    }
    return gitHttp.getGitWorktreeBootstrapOperation(operationId);
  }
  if (runtimeGit?.worktree?.bootstrapStatus) {
    return runtimeGit.worktree.bootstrapStatus(directory);
  }
  if (runtimeGit?.getGitWorktreeBootstrapStatus) {
    return runtimeGit.getGitWorktreeBootstrapStatus(directory);
  }
  return gitHttp.getGitWorktreeBootstrapStatus(directory);
};

const failureMessage = (status: GitWorktreeBootstrapStatus): string => {
  const stage = status.stage ? ` during ${status.stage.replaceAll('_', ' ')}` : '';
  if (status.status === 'needs_attention') {
    return status.error || `Worktree setup needs attention${stage}`;
  }
  if (status.status === 'removed') return 'Worktree was removed before setup completed';
  return status.error || `Worktree bootstrap failed${stage}`;
};

const isReady = (status: GitWorktreeBootstrapStatus): boolean => (
  status.status === 'ready'
  || status.status === 'ready_with_warnings'
  || status.status === 'not_applicable'
);

const isFailed = (status: GitWorktreeBootstrapStatus): boolean => (
  status.status === 'failed'
  || status.status === 'needs_attention'
  || status.status === 'removed'
);

export const markWorktreeBootstrapPending = (
  directory: string,
  initial?: GitWorktreeBootstrapStatus,
): void => {
  if (!getKey(directory)) return;
  ensureEntry(directory, initial);
};

export const clearWorktreeBootstrapState = (directory: string): void => {
  const key = getKey(directory);
  if (!key) return;
  cache.delete(key);
};

export const setWorktreeBootstrapState = (
  directory: string,
  next: GitWorktreeBootstrapStatus,
): void => {
  const entry = ensureEntry(directory);
  entry.status = next;
  entry.operationId = next.operationId;
  notify(entry);
};

export const getWorktreeBootstrapState = (
  directory: string,
): GitWorktreeBootstrapStatus | null => (
  cache.get(getKey(directory))?.status ?? null
);

export const subscribeWorktreeBootstrap = (
  directory: string,
  listener: () => void,
): (() => void) => {
  const entry = ensureEntry(directory);
  entry.listeners.add(listener);
  return () => entry.listeners.delete(listener);
};

export const refreshWorktreeBootstrap = async (
  directory: string,
  operationId?: string | null,
): Promise<GitWorktreeBootstrapStatus> => {
  const entry = ensureEntry(directory);
  const next = await fetchStatus(directory, operationId ?? entry.operationId);
  setWorktreeBootstrapState(directory, next);
  return next;
};

const pollUntilSettled = async (
  directory: string,
  timeoutMs: number,
  operationId?: string | null,
): Promise<void> => {
  const entry = ensureEntry(directory);
  if (operationId) entry.operationId = operationId;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await refreshWorktreeBootstrap(directory, entry.operationId);
    if (isReady(result)) return;
    if (isFailed(result)) throw new Error(failureMessage(result));
    await pause(POLL_INTERVAL_MS);
  }
  throw new Error('Timed out waiting for worktree bootstrap');
};

export const waitForWorktreeBootstrap = async (
  directory: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  operationId?: string | null,
): Promise<void> => {
  const key = getKey(directory);
  if (!key) return;
  const entry = ensureEntry(directory);
  if (operationId) entry.operationId = operationId;
  if (isReady(entry.status)) return;
  if (isFailed(entry.status)) throw new Error(failureMessage(entry.status));
  if (entry.pollPromise) return entry.pollPromise;

  entry.pollPromise = pollUntilSettled(directory, timeoutMs, entry.operationId).finally(() => {
    const current = cache.get(key);
    if (current) current.pollPromise = null;
  });
  return entry.pollPromise;
};

export const primeWorktreeBootstrap = async (
  directory: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> => {
  await waitForWorktreeBootstrap(directory, timeoutMs);
};
