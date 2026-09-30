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
  generic filesystem APIs for session plans. These paths use the shared runtime's bounded plan-storage identity for long project roots.
- `planRevisionDraft.ts` retains each editor draft and its acknowledged byte
  version, skips unchanged saves, serializes updates, and preserves conflicts.
  In-flight live events wait for the save acknowledgement before being classified.
  `PlanView` retains only dirty/in-flight drafts across view remounts in a
  principal-scoped page-lifetime cache; acknowledged clean drafts are removed.
  Canceled loads stop before activating any fallback draft, so an old session's
  rejected read cannot replace the current editor or its save target.

## Integration

Plan lifecycle detection and `PlanCard` call the persistence coordinator.
`PlanView` reuses the saved identity through the same runtime API for reads and
edits of the authoritative session revision. Scoped read failures render an
explicit retry state. Matching `session.plan.updated` events reach the editor
through `sessionEvents`: clean views reload, dirty drafts remain visible with a
conflict, and own save acknowledgements do not conflict. PUT always carries the
last acknowledged version; an external version never becomes an automatic retry.
Unrelated, explicitly opened project-plan paths continue
through the generic files adapter and its existing authorization policy.
