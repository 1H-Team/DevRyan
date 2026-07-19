# Permanent Session Composer Cleanup Plan

1. Add failing regressions for authoritative storage removal and session-target
   retirement writeback suppression.
2. Move session composer key ownership into the session-draft storage module and
   add a synchronous removal subscription.
3. Let the mounted composer retire only its matching active session, cancel its
   pending write, and release retirement after the target-switch boundary.
4. Wire authoritative `session.deleted` to the storage removal operation.
5. Update chat/sync documentation and codemaps.
6. Run focused tests, a production delete/reload replay, affected validation,
   diff checks, and workspace isolation checks.
