# Optimistic Shadow Message Confirmation Implementation Plan

1. Add a focused mergeOptimisticPage regression with one echoed message ID and
   different optimistic/server part IDs.
2. Run the focused test and capture the duplicate-part, unconfirmed-shadow
   failure.
3. Make the fetched message identity confirm the shadow item without merging
   its obsolete optimistic parts.
4. Re-run focused and complete optimistic tests and update sync documentation.
5. Run affected validation, a disposable production browser refetch check, and
   contamination/diff checks without committing, staging, pushing, or
   releasing.
