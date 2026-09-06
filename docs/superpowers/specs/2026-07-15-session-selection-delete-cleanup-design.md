# Permanent Session Selection Cleanup Design

## Problem

The selection store retains model, agent, plan-mode, per-agent model, and
per-agent variant choices by session ID. Four collections live in Zustand and
the variant collection is module-level. Permanent session deletion removes the
session and chat caches, but none of these selection entries, so repeated
create/configure/delete cycles accumulate state that no live or archived
session can reach.

## Source of truth

An authoritative session.deleted event is the permanent lifecycle boundary.
Archive is represented by session.updated with time.archived and must preserve
selection state for a later unarchive. A failed optimistic delete never emits
session.deleted and therefore must not clear selections.

## Design

Add one selection-store action that deletes a target session from every
session-keyed selection collection, including the module-level variant Map.
The action preserves draft selections, unrelated session entries, default plan
mode, and the global last-used provider. It returns existing Zustand state when
none of its Zustand Maps contain the target and only replaces Maps that
actually change.

Invoke that action from shared sync handling when a valid session.deleted
payload supplies the deleted session ID. Web, Electron, therefore
share the same cleanup boundary.

## Alternatives rejected

- Clear on optimistic delete initiation: the server mutation can fail and the
  restored session must retain its choices.
- Clear on archive: archive is reversible and intentionally keeps session
  context.
- Cap the Maps without lifecycle cleanup: eviction could discard choices for
  live sessions while still retaining arbitrary deleted entries.
- Put variant selections into broad Zustand state solely for cleanup: the
  existing module-level store avoids an unnecessary render boundary and can be
  cleared by the same action.

## Verification

- Populate every session-keyed selection for a target and an unrelated
  session, clear the target, and assert only the target entries disappear.
- Apply a production session.deleted event and assert both sync caches and
  selection state drop the deleted session.
- Verify archive behavior remains unchanged.
- Run focused suites, affected validation, a disposable delete-event browser
  check, and isolation/diff checks.
