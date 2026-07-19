# Permanent Session Composer Cleanup Design

## Problem

When composer persistence is enabled, unsent text and confirmed mentions are
stored under two local-storage keys owned by the session ID. Permanent
`session.deleted` handling does not remove those keys. For the active session,
the normal target-switch effect also saves the old composer after deletion, so
an eager clear alone can be undone immediately.

## Decision

The session-draft storage module will own an authoritative permanent-session
input removal operation. It removes both keys and synchronously notifies mounted
composer owners. A composer whose current target matches the deleted session
cancels its pending persistence timer and retires that target before the sync
store transition can trigger the normal old-target save.

The target-switch effect still runs, but the retired target rejects that one
writeback. It then releases the local retirement marker at the explicit switch
boundary, keeping retirement state bounded. Background-session deletion needs
no retirement marker because no mounted composer can write that target; direct
key removal is sufficient.

## Scope

- Remove only the deleted session's text and confirmed-mention keys.
- Preserve unrelated sessions, reversible archives, and failed optimistic
  deletes.
- Keep storage removal and the mounted-composer notification synchronous.
- Do not change draft-to-session promotion or normal session-switch persistence.

## Verification

- A focused sync regression proves authoritative deletion removes both keys and
  preserves unrelated composer storage.
- A controller regression proves a retired session target cannot recreate text
  or mention keys during target switching.
- A production UI replay deletes the active session with unsent text, reloads
  the renderer, and confirms both keys remain absent.
- Run affected validation and isolation checks.
