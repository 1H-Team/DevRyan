# Session UI Delete Retirement Plan

1. Add failing session UI store coverage for exact collection cleanup, abort-controller cancellation, persisted plan cleanup, attachment retirement, and no-op reference preservation.
2. Add a failing sync lifecycle regression proving authoritative deletion retires target state while archive preserves it.
3. Implement `retireDeletedSession(sessionId)` with lazy collection cloning and exact namespace matching.
4. Replace deletion's completion-only cleanup call with the new retirement action; leave archive untouched.
5. Run focused tests immediately and inspect reference/persistence behavior.
6. Update sync documentation and codemap ownership notes.
7. Build the production web renderer and replay deletion/reload through an isolated DevRyan runtime and disposable browser.
8. Run affected validation, verify repository/runtime isolation, and continue the broader audit.
