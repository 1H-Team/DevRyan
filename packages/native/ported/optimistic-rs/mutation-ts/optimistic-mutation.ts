// Test wrapper, never part of the product: calls the two draft-mutating exports of
// `optimistic.ts` and returns the draft, so a port can be compared.
import {
  applyOptimisticAdd,
  applyOptimisticRemove,
  type OptimisticAddInput,
  type OptimisticRemoveInput,
  type OptimisticStore,
} from "../../../../ui/src/sync/optimistic"

export function applyOptimisticAddReturningDraft(draft: OptimisticStore, input: OptimisticAddInput): OptimisticStore {
  applyOptimisticAdd(draft, input)
  return draft
}

export function applyOptimisticRemoveReturningDraft(draft: OptimisticStore, input: OptimisticRemoveInput): OptimisticStore {
  applyOptimisticRemove(draft, input)
  return draft
}
