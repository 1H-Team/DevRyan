# packages/ui/src/lib/plans/

## Responsibility

Owns client-side session-plan persistence coordination and deterministic local
storage helpers retained for injected-storage tests and adapters.

## Design

- `sessionPlanPersistence.ts` deduplicates revision saves, preserves the newest
  session pointer, and delegates authoritative runtime work to `SessionPlansAPI`.
  A saved pointer includes the exact canonical revision identity (registered
  project root, session creation time/slug, session ID, and source message ID)
  plus the returned path.
- `sessionPlanFile.ts` contains the deterministic path and create-once storage
  helper used by focused injected-storage tests. Web and Electron do not call
  generic filesystem APIs for session plans; the VS Code runtime mirrors this
  path contract behind its bridge adapter.

## Integration

Plan lifecycle detection and `PlanCard` call the persistence coordinator.
`PlanView` reuses the saved identity through the same runtime API for reads and
edits of the authoritative session revision. Scoped read failures render an
explicit retry state. Unrelated, explicitly opened project-plan paths continue
through the generic files adapter and its existing authorization policy.
