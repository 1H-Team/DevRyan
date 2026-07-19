# Permanent Session Selection Cleanup Implementation Plan

1. Add a selection-store regression covering every session-keyed collection,
   the module-level variant Map, and preservation of an unrelated session.
2. Add a sync-boundary regression proving session.deleted triggers cleanup.
3. Run both focused tests and capture retained target selections.
4. Implement one narrow cleanup action and wire it only to authoritative
   session.deleted handling.
5. Re-run focused suites, update sync/store documentation, run affected
   validation and a disposable visual delete check, then verify isolation
   without committing, staging, pushing, or releasing.
