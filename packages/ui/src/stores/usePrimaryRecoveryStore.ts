import { create } from 'zustand';
import { z } from 'zod';

const label = z.string().max(256);
export const primaryRecoverySchema = z.object({
  schemaVersion: z.literal(1), mode: z.enum(['off', 'observe', 'enforce']),
  supported: z.boolean(), enforced: z.boolean(), progressTimeoutMs: z.union([z.number(), z.literal(false)]),
  record: z.object({
    sessionID: label, anchorID: label, failedID: label.nullable(), recoveryID: label.nullable(),
    state: z.enum(['observing', 'stopping', 'reconciling', 'recovery_reserved', 'recovering', 'completed', 'needs_attention', 'cancelled', 'superseded']),
    revision: z.number().int().positive(), attemptCount: z.number().int().min(0).max(1), maxAttempts: z.literal(1),
    readOnly: z.boolean(), providerID: label, modelID: label, agent: label, variant: label.nullable(),
    reason: label.nullable(), updatedAt: z.number(),
  }).nullable(),
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
      if (JSON.stringify(previous) === JSON.stringify(parsed.data)) return state;
      const snapshots = { ...state.snapshots, [sessionID]: parsed.data };
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
  return Boolean(snapshot?.record && (snapshot.enforced || snapshot.record.readOnly));
};
