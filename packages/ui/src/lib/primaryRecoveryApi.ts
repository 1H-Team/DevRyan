import { opencodeClient } from './opencode/client';
import { getSyncSessionDirectoryAnyDirectory } from '@/sync/sync-refs';
import { primaryRecoverySchema, usePrimaryRecoveryStore } from '@/stores/usePrimaryRecoveryStore';
import { z } from 'zod';

const requests = new Map<string, symbol>();
const beginRequest = (sessionID: string) => {
  const token = Symbol();
  requests.delete(sessionID);
  requests.set(sessionID, token);
  const oldest = requests.keys().next().value;
  if (requests.size > 256 && oldest !== undefined) requests.delete(oldest);
  return token;
};
const recoveryQuery = (sessionID: string) => {
  const directory = getSyncSessionDirectoryAnyDirectory(sessionID) ?? opencodeClient.getDirectory();
  return new URLSearchParams(directory ? { directory } : {});
};
const acceptResponse = (sessionID: string, token: symbol, snapshot: unknown) => {
  const parsed = primaryRecoverySchema.parse(snapshot);
  if (requests.get(sessionID) === token) usePrimaryRecoveryStore.getState().accept(sessionID, parsed);
  return parsed;
};

export async function requestPrimaryRecovery(sessionID: string, action?: 'cancel' | 'continue' | 'intent', messageID?: string) {
  const token = beginRequest(sessionID);
  const query = recoveryQuery(sessionID);
  const current = usePrimaryRecoveryStore.getState().snapshots[sessionID];
  if (action === 'continue') (await opencodeClient.awaitInputSubscription())();
  const response = await fetch(`/api/session/${encodeURIComponent(sessionID)}/recovery${action ? `/${action}` : ''}?${query}`, {
    method: action ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'X-DevRyan-CSRF': '1' },
    ...(action ? { body: JSON.stringify({ revision: current?.record?.revision, messageID }) } : {}),
    signal: AbortSignal.timeout(action ? 30_000 : 10_000),
  });
  if (!response.ok) throw new Error(action
    ? 'The host could not confirm this action. Refresh recovery status before trying again.'
    : 'Recovery status is unavailable. Stop has not been confirmed.');
  const snapshot: unknown = await response.json();
  // An event or action received while this status request was in flight owns
  // the current projection. Opaque inventory hashes cannot order old replies.
  const latest = usePrimaryRecoveryStore.getState().snapshots[sessionID];
  if (latest !== current) {
    if (action && requests.get(sessionID) === token && latest?.recoveredInputPartial
      && latest.recoveredInput === current?.recoveredInput) return requestPrimaryRecovery(sessionID);
    return primaryRecoverySchema.parse(snapshot);
  }
  return acceptResponse(sessionID, token, snapshot);
}

export async function actOnRecoveredInput(sessionID: string, action: 'resume' | 'discard', input: {
  revision: string; messageID: string; payloadHash: string;
}) {
  const token = beginRequest(sessionID);
  const current = usePrimaryRecoveryStore.getState().snapshots[sessionID];
  if (action === 'resume') (await opencodeClient.awaitInputSubscription())();
  const response = await fetch(`/api/session/${encodeURIComponent(sessionID)}/recovery/${action}-input?${recoveryQuery(sessionID)}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-DevRyan-CSRF': '1' },
    body: JSON.stringify(input), signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error('The host could not confirm this action. Refresh recovery status before trying again.');
  const snapshot: unknown = await response.json();
  // A newer host event may already have completed or discarded this input.
  const latest = usePrimaryRecoveryStore.getState().snapshots[sessionID];
  if (latest !== current) {
    if (requests.get(sessionID) === token && latest?.recoveredInputPartial
      && latest.recoveredInput === current?.recoveredInput) return requestPrimaryRecovery(sessionID);
    return primaryRecoverySchema.parse(snapshot);
  }
  return acceptResponse(sessionID, token, snapshot);
}

export const recoveredInputDetailsSchema = z.object({
  messageID: z.string().max(256), payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  type: z.enum(['user', 'synthetic', 'compaction', 'move']), delivery: z.enum(['queue', 'steer']),
  location: z.enum(['queued', 'promoted']), text: z.string().max(1_048_576),
  files: z.array(z.object({ uri: z.string().max(1_048_576), name: z.string().max(1_048_576).optional(), mime: z.string().max(256).optional() })).max(128),
  agents: z.array(z.object({ name: z.string().max(256) })).max(128).optional(),
  skills: z.array(z.object({ id: z.string().max(256), name: z.string().max(256) })).max(128).optional(),
});
export type RecoveredInputDetails = z.infer<typeof recoveredInputDetailsSchema>;

export async function readRecoveredInput(sessionID: string, input: { revision: string; messageID: string; payloadHash: string }, signal: AbortSignal) {
  const query = recoveryQuery(sessionID);
  for (const [key, value] of Object.entries(input)) query.set(key, value);
  const response = await fetch(`/api/session/${encodeURIComponent(sessionID)}/recovery/input?${query}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!response.ok) throw new Error('This input could not be loaded. Refresh recovery status before trying again.');
  const raw: unknown = await response.json();
  if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > 1_048_576) throw new Error('This input is too large to display.');
  const details = recoveredInputDetailsSchema.parse(raw);
  if (details.messageID !== input.messageID || details.payloadHash !== input.payloadHash) throw new Error('This input changed. Refresh recovery status before trying again.');
  return details;
}

export async function admitQueuedRecoveryIntent(sessionID: string): Promise<void> {
  // A missing renderer snapshot is not proof that the host has no pending
  // recovery. Obtain acknowledgement before accepting/clearing queued input.
  const snapshot = await requestPrimaryRecovery(sessionID);
  if (snapshot.recoveredInput) throw new Error('Review the retained input before sending another message.');
  if (!snapshot.record || (!snapshot.enforced && !snapshot.record.readOnly)) return;
  await requestPrimaryRecovery(sessionID, 'intent');
}
