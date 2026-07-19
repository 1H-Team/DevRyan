# Queued reconnect auto-send implementation plan

1. Add focused red tests for the disconnected-to-connected idle-queue edge,
   steady-connected idempotency, and disconnected/blocked suppression.
2. Add the pure dispatch decision helper and wire the queue hook to the leaf
   connection state.
3. Fault-inject the real transport path. If it disproves the assumed signal,
   add a red connection-state test and correct the source before proceeding.
4. Preserve disconnected state across WS-to-SSE switches and publish connected
   only after the SSE iterator parses or yields its first real event.
5. Run the focused queue, connection-state, event-pipeline, and flush suites.
6. Exercise the complete failed-send, queue-restore, disconnect, reconnect, and
   exactly-once recovery workflow through DevRyan.
7. Update hook/sync documentation, inspect the diff, and run the required
   quick, affected, full, and build validation gates.
