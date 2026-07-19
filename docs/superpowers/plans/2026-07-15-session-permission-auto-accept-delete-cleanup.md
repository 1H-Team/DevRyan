# Session Permission Auto-Accept Delete Cleanup Plan

1. Add failing store regressions for targeted persisted removal and delayed
   mirror ordering.
2. Add a failing sync-boundary regression for authoritative deletion.
3. Serialize server mirror requests per session and expose
   `clearSessionAutoAccept`.
4. Invoke cleanup from the authoritative `session.deleted` boundary only.
5. Update store and sync documentation/codemaps.
6. Run focused tests, a production renderer persistence/mirror replay,
   affected validation, diff checks, and workspace isolation checks.
