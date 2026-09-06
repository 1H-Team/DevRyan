# Managed launch ownership implementation plan

1. Add a failing starting-lease regression that releases `createSession` after the task
   has become interrupted and observes the stale launch side effects.
2. Return explicit ownership from scheduler child/acceptance checkpoints and update the
   workspace TypeScript contract.
3. Make the shared executor stop stale launches and clean up fresh children; add focused
   tests for the pre-prompt and post-prompt ownership boundaries.
4. Add web/Electron child-session deletion transport parity and focused tests.
5. Update orchestration documentation/codemap and run focused, affected, full, and build
   verification appropriate to the cross-runtime contract change.
