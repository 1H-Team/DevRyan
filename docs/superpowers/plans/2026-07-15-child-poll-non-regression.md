# Child Poll Non-Regression Implementation Plan

1. Add focused materialization tests proving that a stale snapshot currently
   reopens a terminal assistant message and finalized tool part.
2. Run the focused test and capture the expected red assertions.
3. Make same-ID assistant and tool lifecycle merges monotonic, then re-run the
   focused materialization tests.
4. Add a task-child snapshot helper test proving bounded polls merge with the
   cache instead of replacing it, then route regular and final task polls
   through that helper.
5. Update sync documentation and codemap ownership.
6. Run focused tests, affected validation, diff checks, and a real child-task UI
   exercise without committing, staging, pushing, or releasing.
