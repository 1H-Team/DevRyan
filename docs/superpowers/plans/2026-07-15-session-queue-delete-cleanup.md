# Permanent Session Queue Cleanup Plan

1. Add a sync-event regression that seeds queued rows for a deleted session and
   an unrelated session, applies `session.deleted`, and expects only the target
   queue to be removed.
2. Run the focused test and preserve the failing evidence.
3. Wire `messageQueueStore.clearQueue` into authoritative permanent-delete
   side effects without changing archive or optimistic-delete behavior.
4. Update the store and sync documentation/codemaps.
5. Run the focused tests, a production UI persistence replay, affected
   validation, diff checks, and workspace isolation checks.
