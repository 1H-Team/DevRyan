# Unexpected-Abort Reconciliation Delete Cancellation Plan

1. Add a failing integration regression that holds `reconcileUnexpectedAbort` across authoritative `session.deleted` and proves the late response restores deleted messages.
2. Add post-await ownership validation to the existing message-refetch path without changing ordinary explicit refetch behavior.
3. Add exact `(directory, sessionID)` action-owner release and invoke it at the permanent deletion boundary; leave archive untouched.
4. Strengthen directory-release and exact-isolation coverage around late responses.
5. Update sync documentation and codemap ownership notes.
6. Run focused tests, type-check/lint, production build and guarded visual replay, then affected validation and isolation checks.
7. Continue the broader audit after fix #27 is independently verified.
