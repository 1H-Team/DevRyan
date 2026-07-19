# Directory Delete Rollback Reconciliation Design

## Problem

`deleteSessionInDirectory` optimistically removes one session before issuing the
directory-scoped delete request. On failure, it restores the entire session
array captured before the request.

A live `session.updated` or `session.created` event can update that directory
store while the delete request is pending. Replacing the whole array during
rollback then discards those newer records. In the smallest case, a same-ID
`session.updated` event reintroduces the target with a newer title, and the
failed delete rollback replaces it with the stale pre-request title.

## Source of truth

The current directory store is authoritative for live session records received
after the optimistic removal. The pre-request snapshot is rollback material
only for the removed target session and only when that target is still absent.

## Design

Route the directory-specific delete failure through the existing
`restoreOptimisticallyRemovedSessions` helper used by batch archive/delete
flows. The helper reconciles against the current store, restores only the
failed target when missing, and preserves any same-ID live record or unrelated
session changes that arrived while the request was pending.

No event routing, global membership policy, delete ordering, or success behavior
changes.

## Alternatives rejected

- Restore the old array and then replay events: the action does not own a
  complete replay log, and reconstructing one would duplicate the sync layer.
- Compare only `time.updated`: the target can be recreated or updated without a
  trustworthy timestamp ordering across providers; presence in current live
  state is the stronger signal already used by batch rollback.
- Add a new rollback helper: the existing selective helper implements the exact
  invariant and already handles directory-store replacement during the request.

## Verification

- A failing directory-specific delete still restores the removed target when no
  newer record arrived.
- If a newer same-ID session record lands before failure settlement, rollback
  preserves that record and its title.
- Focused session-action tests, affected validation, and diff checks remain
  green.
