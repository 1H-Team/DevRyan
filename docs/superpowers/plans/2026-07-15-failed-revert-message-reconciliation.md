# Failed Revert Message Reconciliation Implementation Plan

1. Add a focused session-action test that holds an idle-session scoped revert,
   sends a newer `message.updated` event through the reducer, fails the request,
   and exposes the missing reconciliation fetch.
2. Run the focused test and capture the missing concurrent message failure.
3. Make failed scoped reverts always run the existing bounded authoritative
   message refetch after local rollback.
4. Re-run the focused and complete session-action suites and update sync module
   documentation.
5. Run affected validation, a disposable visual check, and contamination/diff
   checks without committing, staging, pushing, or releasing.
