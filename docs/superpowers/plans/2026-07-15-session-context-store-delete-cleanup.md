# Session Context Store Delete Cleanup Plan

1. Add failing regressions for all seven persisted maps and a queued usage
   update that races with deletion.
2. Track deferred context work by session and add targeted cancellation.
3. Add `clearSessionContext` with reference-preserving removal of the exact
   session key.
4. Invoke the action at the authoritative `session.deleted` sync boundary.
5. Update store and sync documentation/codemaps.
6. Run focused tests, a production renderer persistence replay, affected
   validation, diff checks, and workspace isolation checks.
