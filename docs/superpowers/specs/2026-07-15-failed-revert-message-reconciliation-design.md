# Failed Revert Message Reconciliation Design

## Problem

`revertToMessage` hides the target message and every later message while its
scoped revert request is pending. The event reducer also suppresses live
`message.updated` events at or after that boundary so an in-flight revert cannot
resurrect the suffix it is trying to remove.

If the scoped request fails, the action restores the message snapshot captured
before the request. It currently refetches authoritative messages only when the
session was already non-idle before the revert. A second client can create a new
turn while an initially idle revert is pending; that live event is correctly
suppressed during the transaction, but the failed rollback neither contains nor
refetches it, leaving the first client stale until a later reload.

## Source of truth

After a failed scoped revert, the server message history is authoritative. The
pre-request snapshot is only an immediate local rollback and cannot prove that
no other client wrote messages during the request.

## Design

Keep the existing synchronous rollback so the original suffix reappears
immediately, clear the pending transaction as today, and then always perform the
existing bounded message-history refetch before rethrowing the revert error.
The materializer additively incorporates messages that arrived while the
transaction suppressed their events and preserves terminal/live fields under
its existing merge rules.

No success behavior, revert boundary policy, event suppression, or input
restoration changes.

## Alternatives rejected

- Retain every suppressed event for later replay: this adds a second event log
  and ordering policy to the action layer, duplicating the sync pipeline.
- Refetch only when a live status becomes busy: the concurrent message can be
  accepted and settle before failure handling observes status, so status is not
  a reliable write detector.
- Merge only the current local message list into the snapshot: the relevant
  event was intentionally suppressed and may never be present locally.

## Verification

- Hold an idle-session scoped revert request and confirm its optimistic
  transaction suppresses a newer `message.updated` event.
- Fail the revert and return that newer message from `session.messages`.
- Confirm the original suffix is restored, the concurrent turn is materialized,
  and the refetch uses the reverted session directory.
- Run the focused session-action suite, affected validation, and isolation/diff
  checks.
