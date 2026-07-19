# Bootstrap Abort-Guard Design

## Problem

Manual Stop during a provider retry is protected at the live-event and reconnect-recovery status boundaries, but `bootstrapDirectory` currently writes the raw `session.status()` snapshot into `session_status`. A reconnect that triggers directory bootstrap can therefore resurrect a guarded `retry` status even though the user already stopped that retry loop.

## Source of truth

The server snapshot remains authoritative, except for the existing, explicit manual-abort guard. Every status ingress path must apply that same guard before publishing status to shared UI state. Historical assistant records must not decide whether the retry is live.

## Change

- Add a snapshot helper beside the existing single-status abort-guard filter.
- Preserve the original status-map reference when no status is changed.
- Filter the phase-one `session.status()` bootstrap result before storing it.
- Keep live-event and reconnect behavior unchanged.

## Verification

Drive the change through a `bootstrapDirectory` regression test: register a guard, return an authoritative retry snapshot, bootstrap the directory, and require stored status to be idle. Also prove an unguarded retry remains unchanged.
