# Unexpected-Abort Reconciliation Delete Cancellation Design

## Problem

An unexpected assistant abort can ask `session-actions` to refetch the session's authoritative message snapshot. The operation is deduplicated by `(directory, sessionID)`, but the response currently materializes unconditionally after the network await. Authoritative `session.deleted` cleans the sync store without invalidating this separate owner, so a response that began before deletion can restore deleted messages and parts afterward. Directory disposal removes the dedupe entry but has the same late-write gap.

Archive is reversible and must not cancel an already-valid reconciliation. Only permanent deletion or directory disposal invalidates this ownership.

## Design

Keep the existing promise dedupe map as the generation token:

1. `reconcileUnexpectedAbort` captures its exact promise identity and passes an `isCurrent` callback into `refetchSessionMessages`.
2. `refetchSessionMessages` checks that callback immediately after the response resolves and before parsing or materializing any records.
3. A new `releaseSessionActionSession(directory, sessionID)` removes only the exact dedupe owner.
4. Authoritative deletion calls that exact release before the reducer removes store state.
5. The existing directory release removes every owner for that directory; the new post-await identity check makes that removal a real write barrier.
6. A reconciliation requested after permanent deletion is ignored when neither a live session nor cached messages for that exact session remain.

No transport abort is required for correctness. Promise identity is rechecked at the only post-await state-write boundary, so an abort-insensitive completed response cannot merge after ownership is released.

## Safety

- Archive does not release reconciliation ownership.
- Exact deletion does not affect another session or another directory.
- If newer reconciliation ownership replaces an older promise for the same key, the older response fails the identity check and cannot overwrite the newer snapshot.
- Ordinary explicit message refetches retain existing behavior because the ownership callback is optional and defaults to current.
- The implementation adds no dependency and does not widen session deletion policy beyond the confirmed async owner.

## Verification

- Hold an unexpected-abort message refetch, emit authoritative deletion, release the stale response, and prove no message or part returns.
- Prove exact-session release leaves another session's reconciliation current.
- Prove directory release prevents an old response from writing while allowing a new owner to start.
- Prove archive does not release the in-flight owner.
- Run focused sync/session-action tests, production UI replay, affected validation, and repository/runtime isolation checks.
