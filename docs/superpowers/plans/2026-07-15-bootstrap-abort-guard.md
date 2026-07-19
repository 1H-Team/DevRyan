# Bootstrap Abort-Guard Plan

1. Add a failing bootstrap regression for a guarded retry snapshot.
2. Add the smallest abort-guard snapshot filter with reference preservation.
3. Route bootstrap status ingestion through the filter.
4. Add the unguarded control case and update sync documentation/codemap.
5. Run focused, affected, and full verification before accepting the fix.
