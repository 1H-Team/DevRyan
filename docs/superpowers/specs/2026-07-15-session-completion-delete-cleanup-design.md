# Session Completion Delete Cleanup Design

## Problem

Permanent session deletion removes authoritative session data but leaves two completion-owned client resources behind:

- `notification-store.ts` retains in-memory notification rows and persisted turn-complete rows for the deleted session.
- `session-ui-store.ts` may still have a 250 ms completion-settlement timer. After deletion removes live status, that timer sees no busy/retry state and can write a deleted-session completion indicator.

Archive is reversible and must preserve these records. Only authoritative `session.deleted` is a cleanup boundary.

## Design

Add an exact-session removal action to the notification store. It filters only rows whose `session` matches, rebuilds the derived index once, and rewrites the bounded completion persistence. It returns the original state when no row matches.

At the authoritative deletion boundary:

1. remove notifications for the exact deleted session;
2. call the existing session UI completion cleanup action, which cancels both normal and plan settlement timers and removes settled completion indicators;
3. preserve archive behavior and unrelated session records.

The notification store remains the sole owner of its list, index, and persistence. The session UI store remains the sole owner of completion timers and indicator maps.

## Safety

- No cleanup occurs for `session.updated` archive events.
- No directory-wide or project-wide clearing is introduced.
- Unrelated notification object identity is preserved by `filter`.
- Notification persistence is updated synchronously with the in-memory removal.
- Existing completion cleanup already owns timer cancellation, avoiding a second timer API.

## Verification

- Store regression: exact-session removal deletes target completion/error rows and persisted completion state while retaining unrelated rows.
- Sync regression: schedule completion, delete before the settle delay, wait past the delay, and prove neither notification nor indicator state returns.
- Archive regression: archive preserves notification and pending completion behavior.
- Production replay: seed a completion notification, inject authoritative deletion, reload, and verify storage and visible UI remain clean.
