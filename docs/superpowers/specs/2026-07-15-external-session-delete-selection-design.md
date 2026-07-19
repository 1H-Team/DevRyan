# External Session Delete Selection Cleanup Design

## Problem

Local permanent-delete actions clear the selected session before sending the
request, but another renderer or runtime can delete the same session first. In
that path, the authoritative `session.deleted` event removes the session and
its caches while the ephemeral UI store can keep `currentSessionId` pointed at
the now-missing session. Chat and composer actions then retain a stale target.

## Decision

Authoritative permanent deletion will synchronously clear the current session
only when its ID exactly matches the deleted session. The sync boundary will
read the already-registered session UI store through its imperative ref, so the
selection is invalidated in the same event turn without introducing a runtime
import cycle or an asynchronous frame of stale selection.

The optional ref lookup will no-op when the UI store has not been registered.
This keeps headless sync consumers valid while preserving the stronger
selection invariant in renderers.

## Scope

- Clear only a selected session whose ID matches authoritative deletion.
- Preserve the current selection when a background session is deleted.
- Preserve archive behavior and local delete rollback semantics.
- Do not guess a replacement session or automatically open a new draft.

## Verification

- A focused sync-boundary regression proves external deletion clears the exact
  selected session and preserves an unrelated selection.
- A production renderer replay injects authoritative deletion of the viewed
  session and confirms the stale chat/composer target disappears.
- Run affected validation, diff checks, and workspace isolation checks.
