# Session Permission Auto-Accept Delete Cleanup Design

## Problem

`permissionStore` persists explicit auto-accept choices by session ID. The web
notification runtime forgets its in-memory suppression flag when it receives
`session.deleted`, but the renderer keeps the deleted session in
`permission-store`. On a later hydration, every persisted `true` entry is
POSTed back to `/api/notifications/auto-accept`, which can recreate server
suppression state for a permanently deleted session.

There is also an ordering race in the current fire-and-forget mirror. A `true`
request started by hydration or a user toggle can still be in flight when
deletion clears the server runtime. A deletion-side `false` request must be
ordered after that older request or the stale request can win last.

## Decision

Add `clearSessionAutoAccept(sessionId)`. It synchronously removes only the exact
session key from persisted renderer state and queues a best-effort `false`
mirror when an explicit entry existed. Empty IDs are ignored.

All auto-accept mirror requests use one short-lived promise tail per session.
Requests for different sessions remain independent. For one session, a later
request starts only after the earlier request settles, and the tail is removed
when complete. Authoritative deletion can therefore enqueue `false` after any
older hydration/toggle `true` without a permanent tombstone or global
serialization bottleneck.

The sync boundary invokes cleanup only for an authoritative `session.deleted`
event. Archive and optimistic delete initiation preserve the explicit choice.

## Scope

- Remove only the permanently deleted session from persisted `autoAccept`.
- Preserve unrelated `true` and `false` overrides.
- Ensure the final server mirror for that session is `enabled: false`.
- Preserve descendant resolution and pending-permission behavior for normal
  user toggles.
- Add no dependency and no broad store subscription.

## Verification

- Store regressions prove targeted persisted removal and retained overrides.
- A controlled delayed `true` request proves deletion queues `false` after it.
- A sync-boundary regression proves authoritative deletion invokes cleanup.
- A production renderer replay verifies local storage remains clean after
  reload and the last captured mirror request is `false`.
- Run affected validation, diff checks, and workspace isolation checks.
