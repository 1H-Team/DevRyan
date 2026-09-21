import { opencodeClient } from '@/lib/opencode/client';
import { createRetentionSelection } from './retentionSelection';

export const retentionClientID = globalThis.crypto?.randomUUID?.() ?? `client_${Math.random().toString(36).slice(2)}`;
let active = typeof window !== 'undefined';
let currentSelection: () => string | null = () => null;

async function post(route: string, body: object) {
  const base = opencodeClient.getBaseUrl().replace(/\/$/, '');
  const response = await fetch(`${base}/openchamber/session-retention/${route}`, {
    method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(response.status === 409
    ? 'Session cleanup is in progress. Please try again.' : 'Could not protect the selected session. Please retry.');
  return response;
}

const selection = createRetentionSelection((sessionID, revision, committed) => post('selection', {
  clientID: retentionClientID, sessionID, revision, committed,
}), () => currentSelection());

export function setRetentionSelectionReader(reader: () => string | null) { currentSelection = reader; }
export function retentionNavigationChanged() {
  if (selection.navigationChanged() && active) void selection.observe(currentSelection()).catch(() => { /* Unknown protection blocks cleanup. */ });
}

export function protectRetentionSelection(sessionID: string | null) { active = true; return selection.observe(sessionID); }

/** A selection is protected before the UI switches; stale observers cannot
 * replace the latest requested selection while its acknowledgement is pending. */
export function selectRetentionSession(sessionID: string | null, apply: () => void, onError: (error: Error) => void) {
  if (!active) { apply(); return; }
  selection.select(sessionID, apply, onError);
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
