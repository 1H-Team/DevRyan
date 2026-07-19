# Retry-deadline abort guard implementation plan

1. Add red guard tests proving a stopped retry remains guarded beyond the base
   TTL through its advertised deadline, duplicate relative deadlines do not
   slide, and the extended guard eventually expires.
2. Add a red reducer test proving an authoritative user message clears a guard
   before a new turn's retry status is processed.
3. Store a retry-aware expiration and seed every production guard registration
   with the status being stopped.
4. Clear guards from authoritative user-message events while preserving the
   existing idle/error/new-local-send/disposal clearing paths.
5. Add a red streaming-derivation regression proving guarded idle completes an
   incomplete tracked assistant stream while ordinary premature idle retains it.
6. Prevent only the active-guard streaming fallback from overriding guarded
   idle.
7. Run the focused guard, reducer, reconnect-recovery, session-action, and
   cancellation/reversion suites immediately.
8. Fault-inject a long retry deadline through a real DevRyan UI journey and
   verify Stop remains stable past the former boundary without cancelling a
   subsequent user turn.
9. Update sync documentation/codemap, inspect the diff, and run the applicable
   quick, affected, full, and production-build validation gates.
