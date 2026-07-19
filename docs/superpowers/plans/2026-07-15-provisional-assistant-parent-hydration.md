# Provisional Assistant Parent Hydration Implementation Plan

1. Add a focused reducer test that creates a provisional assistant from
   message.part.updated, then sends an otherwise identical non-terminal
   message.updated with parentID.
2. Run the focused test and capture the discarded-parent failure.
3. Add parent identity to the existing lightweight message no-op gate.
4. Re-run focused and complete reducer suites and update sync documentation.
5. Run affected validation, a disposable visual check, and contamination/diff
   checks without committing, staging, pushing, or releasing.
