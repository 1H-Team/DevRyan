# Session Materialization Delete Cancellation Plan

1. Add a failing sync regression that holds blocking-request session recovery across authoritative deletion and proves the late response currently resurrects the session.
2. Add a failing snapshot-materialization race proving late message data currently returns after deletion.
3. Implement one exact `(directory, sessionID)` retirement helper using existing identity/token checks and timer cancellation.
4. Invoke retirement before the deletion reducer; leave archive untouched.
5. Add exact-session, cross-directory, and archive-preservation coverage where the production race exposes those boundaries.
6. Update sync documentation and codemap ownership notes.
7. Run focused tests, type-check/lint, a production build and replay, then affected validation and isolation checks.
8. Continue the broader audit after fix #26 is independently verified.
