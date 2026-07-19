# Reconnect Status Snapshot Race Implementation Plan

1. Add focused reconnect tests that invert the status-response/live-event order
   before the first merge and before the final merge.
2. Run the focused test and confirm both new assertions fail for the stale
   snapshot overwrite.
3. Add semantic candidate-status baseline helpers and restrict each reconnect
   merge to candidates whose baseline is still current.
4. Re-run focused tests, then update sync documentation and codemap ownership.
5. Run affected validation, diff checks, and runtime cleanup checks.
