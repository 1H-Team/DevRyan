import { create } from 'zustand';
import { decodeRequiredCheckVerification, type RequiredCheckVerification } from '@devryan/orchestration-runtime';
import { isRecord } from '@/lib/decoders/guards';
import { managedOrchestrationApi } from '@/lib/orchestrationApi';

export type ObjectiveProof = { objectiveId: string; verification: RequiredCheckVerification | null };
type Entry = { status: 'loading' | 'confirmed' | 'error'; proof: ObjectiveProof | null };
const keyOf = (sessionId: string, directory: string) => JSON.stringify([sessionId, directory]);
const keepBounded = (entries: Record<string, Entry>, key: string, entry: Entry) => {
  const next = { ...entries, [key]: entry };
  while (Object.keys(next).length > 256) {
    const oldest = Object.keys(next).find(item => item !== key);
    if (!oldest) break;
    delete next[oldest];
  }
  return next;
};
const pending = new Map<string, { id: number; promise: Promise<ObjectiveProof | null> }>();
let sequence = 0;

export const useObjectiveVerificationStore = create<{
  entries: Readonly<Record<string, Entry>>;
  refresh(sessionId: string, directory: string, options?: { expectedObjectiveId?: string; originatingMessageId?: string; force?: boolean }): Promise<ObjectiveProof | null>;
}>((set) => ({
  entries: {},
  refresh: (sessionId, directory, options = {}) => {
    const key = keyOf(sessionId, directory), existing = pending.get(key);
    if (existing && !options.force && !options.expectedObjectiveId && !options.originatingMessageId) return existing.promise;
    const id = ++sequence;
    set(state => ({ entries: keepBounded(state.entries, key, { status: 'loading', proof: state.entries[key]?.proof ?? null }) }));
    const promise = Promise.resolve().then(async () => {
      try {
        if (!managedOrchestrationApi.getObjectiveVerification) throw new Error('objective_verification_unavailable');
        const value = await managedOrchestrationApi.getObjectiveVerification({ rootSessionId: sessionId, directory,
          ...(options.expectedObjectiveId ? { expectedObjectiveId: options.expectedObjectiveId } : {}),
          ...(options.originatingMessageId ? { originatingMessageId: options.originatingMessageId } : {}), signal: AbortSignal.timeout(10_000) });
        if (!isRecord(value) || typeof value.objectiveId !== 'string' || !value.objectiveId
          || options.expectedObjectiveId && value.objectiveId !== options.expectedObjectiveId
          || options.originatingMessageId && value.originatingMessageId !== options.originatingMessageId) throw new Error('objective_verification_invalid');
        const verification = value.verification === null ? null : decodeRequiredCheckVerification(value.verification);
        if (value.verification !== null && (!verification || verification.objectiveId !== value.objectiveId)) throw new Error('objective_verification_invalid');
        const proof = { objectiveId: value.objectiveId, verification };
        if (pending.get(key)?.id !== id) return null;
        set(state => ({ entries: keepBounded(state.entries, key, { status: 'confirmed', proof }) }));
        return proof;
      } catch {
        if (pending.get(key)?.id === id) set(state => ({ entries: keepBounded(state.entries, key, { status: 'error', proof: state.entries[key]?.proof ?? null }) }));
        return null;
      } finally { if (pending.get(key)?.id === id) pending.delete(key); }
    });
    pending.set(key, { id, promise });
    return promise;
  },
}));

export const objectiveVerificationKey = keyOf;
