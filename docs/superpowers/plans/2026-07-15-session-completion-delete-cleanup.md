# Session Completion Delete Cleanup Plan

1. Add failing notification-store coverage for exact-session removal, persistence cleanup, no-op reference preservation, and unrelated row retention.
2. Add a failing sync lifecycle regression that schedules a completion, applies authoritative deletion before settlement, and checks after the delay.
3. Implement the smallest notification removal action and invoke notification/timer cleanup only from `session.deleted`.
4. Run focused tests immediately and inspect the diff for reference-preserving updates.
5. Update sync documentation and codemap ownership notes.
6. Build the production web renderer and replay the delete/reload journey through an isolated DevRyan runtime and disposable browser.
7. Run affected validation, verify repository/runtime isolation, and continue the broader audit.
