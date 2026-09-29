import { opencodeClient } from '@/lib/opencode/client';
import { streamPerfCount, streamPerfObserve } from '@/stores/utils/streamDebug';
import { createRetentionSelection, SelectionSupersededError, type SelectionOptions } from './retentionSelection';
export { SelectionSupersededError, type SelectionOptions } from './retentionSelection';

export const retentionClientID = globalThis.crypto?.randomUUID?.() ?? `client_${Math.random().toString(36).slice(2)}`;
let active = typeof window !== 'undefined';
let currentSelection: () => string | null = () => null;
let pendingChanged: (id: string | null) => void = () => {};

export class RetentionRequestError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) { super(code); }
}

async function post(route: string, body: object, signal?: AbortSignal) {
  const base = opencodeClient.getBaseUrl().replace(/\/$/, '');
  const timeout = AbortSignal.timeout(15_000);
  try {
    const response = await fetch(`${base}/openchamber/session-retention/${route}`, {
      method: 'POST', credentials: 'include', headers: {
        'content-type': 'application/json', 'x-devryan-selection-request': crypto.randomUUID(),
      },
      body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      const result: unknown = await response.json().catch(() => null);
      const code = response.status === 401 || response.status === 403 ? 'retention_authentication'
        : result && typeof result === 'object' && 'code' in result && typeof result.code === 'string'
          ? result.code : 'retention_unavailable';
      if (code === 'selection_superseded') throw new SelectionSupersededError();
      const retryable = code !== 'retention_authentication' && (result && typeof result === 'object'
        && 'retryable' in result && typeof result.retryable === 'boolean' ? result.retryable
        : response.status === 409 || response.status === 408 || response.status === 429 || response.status >= 500);
      throw new RetentionRequestError(code, retryable);
    }
    return response;
  } catch (error) {
    if (signal?.aborted) throw new SelectionSupersededError();
    if (timeout.aborted) throw new RetentionRequestError('retention_timeout', true);
    throw error;
  }
}

const selection = createRetentionSelection(async (sessionID, revision, committed, signal) => {
  // One observation per HTTP request, with stage/commit separated for diagnosis.
  const phase = committed ? 'commit' : 'protection';
  const started = performance.now();
  try {
    const response = await post('selection', { clientID: retentionClientID, sessionID, revision, committed }, signal);
    streamPerfCount(`session.load.${phase}.confirmed`);
    return response;
  } catch (error) {
    const outcome = error instanceof SelectionSupersededError ? 'superseded'
      : error instanceof RetentionRequestError && error.code === 'retention_timeout' ? 'timeout' : 'failure';
    streamPerfCount(`session.load.${phase}.${outcome}`);
    throw error;
  } finally { streamPerfObserve(`session.load.${phase}.duration`, performance.now() - started); }
}, () => currentSelection(), id => pendingChanged(id));

export function setRetentionSelectionReader(reader: () => string | null, onPending?: (id: string | null) => void) {
  currentSelection = reader;
  pendingChanged = onPending ?? (() => {});
}
export const beginRetentionNavigation = () => { selection.navigationChanged(); return selection.navigationRevision(); };
export const getRetentionNavigationRevision = () => selection.navigationRevision();
export function retentionConnectionChanged() { if (active) selection.invalidateAcknowledgement(); }
export function invalidateRetentionSession(id: string, clear: () => void) {
  if (!active) {
    if (currentSelection() === id) { selection.navigationChanged(); clear(); }
    return;
  }
  selection.invalidateSession(id, clear);
}
export function retentionNavigationChanged() {
  if (selection.navigationChanged() && active) void selection.observe(currentSelection()).catch(() => {});
}

/** Resolves only when the current selection's commit is acknowledged. */
export function protectRetentionSelection(sessionID: string | null) { active = true; return selection.observe(sessionID); }

export function selectRetentionSession(sessionID: string | null, apply: () => void, onError: (error: Error) => void, options?: SelectionOptions) {
  if (!active) {
    if (options?.expectedNavigationRevision !== undefined && options.expectedNavigationRevision !== selection.navigationRevision()) return;
    selection.navigationChanged(); apply(); options?.onApplied?.(); return;
  }
  selection.select(sessionID, apply, onError, options);
}

/** Cleanup cannot dispatch on an acknowledgement from an obsolete navigation. */
export async function runProtectedSessionRetention(): Promise<RetentionResult> {
  const revision = selection.navigationRevision();
  const sessionID = currentSelection();
  await protectRetentionSelection(sessionID);
  if (revision !== selection.navigationRevision() || !selection.isConfirmed(sessionID)) throw new SelectionSupersededError();
  return runSessionRetention();
}

export type RetentionResult = {
  action: 'archive' | 'delete'; completed: string[];
  skipped: Array<{ id: string | null; reason: string }>;
  failed: Array<{ id: string; reason: string }>;
};
export async function runSessionRetention(): Promise<RetentionResult> {
  const response = await post('run', {});
  const result: unknown = await response.json();
  if (typeof result !== 'object' || !result || !('completed' in result) || !Array.isArray(result.completed)
    || !result.completed.every((id) => typeof id === 'string') || !('skipped' in result) || !Array.isArray(result.skipped)
    || !('failed' in result) || !Array.isArray(result.failed) || !('action' in result)
    || (result.action !== 'archive' && result.action !== 'delete')) throw new Error('Invalid session cleanup result');
  const reasons = (entries: unknown[], nullable: boolean) => entries.map((entry) => {
    if (typeof entry !== 'object' || !entry || !('id' in entry) || !('reason' in entry) || typeof entry.reason !== 'string'
      || !(typeof entry.id === 'string' || nullable && entry.id === null)) throw new Error('Invalid session cleanup result');
    return { id: typeof entry.id === 'string' ? entry.id : null, reason: entry.reason };
  });
  return { action: result.action, completed: result.completed,
    skipped: reasons(result.skipped, true), failed: reasons(result.failed, false).map((entry) => ({ ...entry, id: entry.id! })) };
}
