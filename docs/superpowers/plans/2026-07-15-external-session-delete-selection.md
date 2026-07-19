# External Session Delete Selection Cleanup Plan

1. Add a failing sync-boundary regression for selected and background session
   deletion.
2. Expose a non-throwing read of the registered session UI store ref.
3. Clear the exact selected session synchronously on authoritative
   `session.deleted`.
4. Update sync documentation and codemaps.
5. Run focused tests, a production renderer replay, affected validation, diff
   checks, and workspace isolation checks.
