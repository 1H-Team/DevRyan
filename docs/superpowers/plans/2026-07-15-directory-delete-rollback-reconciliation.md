# Directory Delete Rollback Reconciliation Implementation Plan

1. Add a focused session-action test that holds a directory-scoped delete,
   inserts a newer same-ID live session record, fails the request, and expects
   rollback to preserve the newer record.
2. Run the focused test and capture the stale-snapshot failure.
3. Replace whole-array rollback with the existing selective optimistic-removal
   restoration helper.
4. Re-run focused session-action tests and update sync ownership documentation.
5. Run affected validation and diff/contamination checks without committing,
   staging, pushing, or releasing.
