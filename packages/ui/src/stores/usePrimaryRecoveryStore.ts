import { create } from 'zustand';
import { z } from 'zod';

const label = z.string().max(256);
const inputHash = z.string().regex(/^[a-f0-9]{64}$/);
export const recoveredInputDescriptorSchema = z.object({
  messageID: label,
  payloadHash: inputHash,
  type: z.enum(['user', 'synthetic', 'compaction', 'move']),
  delivery: z.enum(['queue', 'steer']),
  location: z.enum(['queued', 'promoted']),
  preview: z.string().max(160),
  attachmentCount: z.number().int().min(0).max(128),
  canResume: z.boolean(),
  canDiscard: z.boolean(),
  reason: label.nullable(),
});
export type RecoveredInputDescriptor = z.infer<typeof recoveredInputDescriptorSchema>;
export const primaryRecoverySchema = z.object({
  schemaVersion: z.literal(1), mode: z.enum(['off', 'observe', 'enforce']),
  supported: z.boolean(), enforced: z.boolean(), progressTimeoutMs: z.union([z.number(), z.literal(false)]),
  record: z.object({
    sessionID: label, anchorID: label, failedID: label.nullable(), recoveryID: label.nullable(),
    state: z.enum(['observing', 'stopping', 'reconciling', 'recovery_reserved', 'recovering', 'completed', 'needs_attention', 'cancelled', 'superseded']),
    revision: z.number().int().positive(), attemptCount: z.number().int().min(0).max(1), maxAttempts: z.literal(1),
    readOnly: z.boolean(), providerID: label, modelID: label, agent: label, variant: label.nullable(),
    reason: label.nullable(), updatedAt: z.number(),
    failureObserved: z.boolean().optional(),
    collectionIssue: z.object({ taskId: label, code: label }).nullable().optional(),
    failureKind: z.enum(['provider_transport', 'provider_usage_limit', 'provider_authentication', 'provider_prompt_rejected', 'model_unavailable', 'deadline_exceeded']).nullable().optional(),
  }).nullable(),
  recoveredInput: z.object({
    revision: inputHash,
    state: z.enum(['paused', 'resuming', 'discarding']),
    inputs: z.array(recoveredInputDescriptorSchema).max(128),
  }).optional(),
  recoveredInputPartial: z.literal(true).optional(),
});
export type PrimaryRecoverySnapshot = z.infer<typeof primaryRecoverySchema>;

// Low-frequency host snapshots only. No tokens, transcript, or live text.
export const usePrimaryRecoveryStore = create<{
  snapshots: Record<string, PrimaryRecoverySnapshot>;
  accept(sessionID: string, value: unknown): void;
}>()((set) => ({
  snapshots: {},
  accept: (sessionID, value) => {
    const parsed = primaryRecoverySchema.safeParse(value);
    if (!parsed.success || (parsed.data.record && parsed.data.record.sessionID !== sessionID)) return;
    set((state) => {
      const previous = state.snapshots[sessionID];
      if (previous?.record && parsed.data.record) {
        if (previous.record.anchorID === parsed.data.record.anchorID && previous.record.revision > parsed.data.record.revision) return state;
        if (previous.record.anchorID !== parsed.data.record.anchorID && previous.record.updatedAt > parsed.data.record.updatedAt) return state;
      }
      const snapshot = parsed.data.recoveredInputPartial
        ? { ...parsed.data, recoveredInput: previous?.recoveredInput } : parsed.data;
      if (JSON.stringify(previous) === JSON.stringify(snapshot)) return state;
      const snapshots = { ...state.snapshots, [sessionID]: snapshot };
      // Schema bounds each entry; count plus byte bound protects long-lived tabs.
      for (const key of Object.keys(snapshots)) {
        if (Object.keys(snapshots).length <= 256 && JSON.stringify(snapshots).length <= 1_048_576) break;
        if (key !== sessionID) delete snapshots[key];
      }
      return { snapshots };
    });
  },
}));

export const hostOwnsPrimaryRecovery = (sessionID: string): boolean => {
  const snapshot = usePrimaryRecoveryStore.getState().snapshots[sessionID];
  return Boolean(snapshot?.recoveredInput || snapshot?.record && (snapshot.enforced || snapshot.record.readOnly
    || snapshot.record.reason === 'managed_repeated_preexecution_rejection'));
};
