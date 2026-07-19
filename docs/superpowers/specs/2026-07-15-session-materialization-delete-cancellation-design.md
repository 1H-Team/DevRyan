# Session Materialization Delete Cancellation Design

## Problem

The sync layer starts asynchronous, exact-session recovery for missing message snapshots, persisted lifecycle indicators, and blocking-request session records. `session.deleted` removes the authoritative store record, but it does not currently invalidate those in-flight owners. A response that started before deletion can therefore merge messages or even the complete session back into the directory store after permanent deletion.

Archive is reversible and must preserve recovery work. Only authoritative `session.deleted` is a cancellation boundary.

## Design

Add one exact-session sync-ownership retirement helper and call it at the start of authoritative deletion handling, before store cleanup.

For the deleted `(directory, sessionID)` pair, the helper:

1. removes the exact pending snapshot materialization and clears its retry timer;
2. marks the exact lifecycle restoration cancelled and removes its ownership entry;
3. removes the exact blocking-request materialization token so a late `session.get` response fails its token check;
4. removes pending buffered part deltas owned by messages already indexed to the deleted session;
5. clears exact live-recovery timestamp/view tracking; and
6. clears the exact abort-retry guard so a deferred re-abort cannot target a deleted session.

Existing materializers already validate captured map identity immediately before merging. Removing exact ownership is therefore the generation/tombstone boundary; aborting transport is not required for correctness.

## Safety

- Archive does not invoke the helper.
- Cleanup is scoped to one normalized directory and one exact session ID.
- Other sessions and other directory-scoped recovery keys retain ownership; the globally keyed abort guard is retired only for the exact globally unique session ID.
- Late async `finally` handlers cannot remove newer ownership because existing identity/token checks remain authoritative.
- Routing-index message ownership is read before the reducer removes it, allowing exact pending-delta cleanup without scanning unrelated stores.

## Verification

- Hold a blocking-request `session.get`, delete its session, release the response, and prove the session does not reappear.
- Hold a message snapshot materialization, delete its session, release the response, and prove messages and parts do not reappear.
- Run the same races with retained sessions to prove exact-session isolation.
- Prove archive leaves in-flight recovery able to complete.
- Run focused sync tests, production build/replay where practical, affected validation, and repository/runtime isolation checks.
