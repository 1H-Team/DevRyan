# Session Context Store Delete Cleanup Design

## Problem

`contextStore` persists seven maps keyed by session ID: model selection, agent
selection, per-agent model selection, per-agent model variant, current agent,
context usage, and per-agent edit mode. Authoritative `session.deleted` cleanup
currently leaves those entries in `context-store`, so permanently deleted
session state survives reload.

Context usage also has deferred writers. `getContextUsage` queues a microtask
and `pollForTokenUpdates` owns delayed retries. A simple map deletion can be
undone when one of those callbacks runs after the delete event.

## Decision

Add one `clearSessionContext(sessionId)` store action. It will first cancel all
tracked deferred context work owned by that session, then remove the exact
session key from each of the seven persisted maps. Only maps that contain the
key receive a new reference; unrelated maps and entries retain their identity.

Deferred work is tracked with short-lived cancellation records and owned timer
handles. Completed work releases its record. Deletion cancels and releases all
records for the session, so no permanent tombstone or unbounded deleted-ID set
is introduced.

The authoritative sync boundary calls this action only after a real
`session.deleted` event. Archive and optimistic delete initiation do not clear
the store. Empty IDs and the reserved `__global__` edit-mode key are ignored.

## Scope

- Clear only the deleted session from all seven persisted context maps.
- Preserve unrelated sessions and the global edit-mode fallback.
- Prevent queued usage calculations and token polls from resurrecting state.
- Preserve archive behavior and failed-delete rollback semantics.
- Add no dependency and no cross-store subscription.

## Verification

- A sync-boundary regression seeds all seven maps for deleted and retained
  sessions, plus the global edit-mode row, then proves targeted cleanup.
- A store regression proves a queued context-usage calculation cannot recreate
  the deleted session after cleanup.
- A production renderer replay verifies persisted storage after deletion and
  again after reload.
- Run affected validation, diff checks, and workspace isolation checks.
