# Reconnect Status Snapshot Race Design

## Problem

`resyncDirectoryAfterReconnect` fetches one directory-scoped session-status
snapshot, applies it, refreshes candidate sessions and blocking requests, then
applies the same snapshot again. A live `session.status` event can arrive while
the status request is in flight or during the later refresh work. Reapplying the
older snapshot can therefore replace the newer status for the same session.

Session A cannot overwrite session B because sync state is keyed by directory
and session ID. The unsafe case is a stale snapshot overwriting a newer live
event for the same key.

## Source of truth

A live status event observed after a reconnect snapshot request begins is newer
than that request's payload and must win. Reconnect snapshots remain
authoritative only for candidate sessions whose status has not changed since the
relevant request or merge boundary.

## Design

Capture the semantic status of every reconnect candidate immediately before the
status request. Once the response arrives, merge its value only for candidates
whose current status still matches that baseline. After the first merge, capture
a second baseline for the candidates that were still eligible. The final merge
after message and blocker recovery is restricted to candidates that still match
that second baseline.

Status equality compares the full supported contract: `idle`/`busy` type and,
for `retry`, attempt, message, and next-at timestamp. Missing status is a real
baseline value.

This keeps the guard on the cold reconnect path. It avoids a new global revision
map, avoids adding work to the SSE hot path, and needs no disposal lifecycle.

## Alternatives rejected

- Guarding on the selected session: reconnect state is session-keyed already and
  selection does not identify the same-session race.
- Always trusting the snapshot: a delayed response can be older than an SSE
  event that has already been reduced.
- Adding per-session event counters: correct but unnecessary global state and
  cleanup when semantic baselines detect every state-changing overwrite.

## Verification

- Delay the status response, write a newer live status, then release the stale
  response; the live status must remain.
- Let the first snapshot merge, delay message recovery, write a newer live
  status, then release recovery; the final repeated merge must not restore the
  stale status.
- Preserve normal reconnect recovery when no live status changes.
