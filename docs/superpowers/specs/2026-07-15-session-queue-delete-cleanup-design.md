# Permanent Session Queue Cleanup Design

## Problem

`messageQueueStore` persists queued prompt rows by session ID. Permanent
`session.deleted` events remove the authoritative session and its live sync
caches, but leave the deleted session's queued rows in persisted renderer
storage. The session row is gone, so those prompt, attachment, directory, and
send-configuration records are no longer reachable through the UI.

## Decision

Treat the authoritative `session.deleted` event as the queue-lifetime boundary.
The sync event side-effect layer will call the queue store's existing
`clearQueue(sessionID)` action alongside the other per-session cleanup actions.

Archive remains a `session.updated` transition and must preserve queued rows.
Optimistic delete attempts do not clear the queue; cleanup occurs only after the
server emits the authoritative permanent-delete event, so a failed delete can
still roll back without losing queued user data.

## Scope

- Add one integration regression at the production sync-event boundary.
- Remove only the deleted session's queue key and preserve unrelated queues.
- Reuse the existing persisted-store action; do not change queue dispatch,
  claim/restore semantics, or persistence format.
- Document the permanent-delete ownership rule in the store and sync maps.

## Verification

- Focused regression fails before wiring the event cleanup and passes after it.
- Existing queue claim/restore and sync lifecycle suites remain green.
- A production UI replay queues a visible prompt, emits an authoritative
  `session.deleted`, reloads the renderer, and confirms the deleted session key
  is absent from persisted queue storage while another session's queue remains.
- Run affected validation and repository-isolation checks.
