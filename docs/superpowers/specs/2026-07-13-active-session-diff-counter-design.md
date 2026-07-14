# Active Session Diff Counter Design

## Problem

The header badge beside the current session title displays accumulated per-turn additions and deletions. That is edit churn, not the active session's current net diff.

The bug was reproduced in the `Test` project with an OpenAI model:

1. Creating a three-line file showed `+3 / -0` in both the header and Git panel.
2. Replacing one line made the header show `+4 / -1`, while the Git panel correctly remained `+3 / -0`.
3. Deleting the file left the header at `+4 / -4`, while the working tree was clean.

Each user-message summary describes one turn, so summing those summaries double-counts overlapping edits and retains edits that were later reversed.

## Goal

The badge beside the currently open session title must show the current working-tree additions and deletions for files touched by that session. It must update after edits and reversions, disappear once those files are clean, and never include files owned only by another session.

## Non-goals

- Do not change sidebar session badges in this fix.
- Do not show repository-wide totals in the header.
- Do not reconstruct a net diff by composing historical patches in the browser.
- Do not add dependencies or change the badge's visual styling.

## Architecture

Use two existing sources for separate responsibilities:

- User-message `summary.diffs` entries identify which file paths the active session touched.
- The Git store's current `diffStats` provides authoritative net additions and deletions for those paths now.

This distinction is important. OpenCode's `session.diff` endpoint without a `messageID` returned an empty array in the real visual test, while a message-scoped request returned only that turn's patch. Neither is a cumulative current-session snapshot. The message summaries remain useful for ownership, but their historical line counts are not summed.

Add a memoized `ActiveSessionChangesBadge` component. It will:

- subscribe only to the active session's visible messages;
- build a normalized, deduplicated set of paths from user-message `summary.diffs` entries;
- select a primitive totals key from the Git store by summing current `diffStats` for only those paths;
- refresh full Git status when touched paths or the latest message milestone changes so cleanup and reversals do not leave a stale rich payload;
- render the existing `SessionChangesBadge`, or render nothing for zero totals.

`Header` passes only the active session ID and directory into this child. The child owns the message and Git subscriptions so those updates do not repaint the full header shell.

## Data Flow

1. `Header` resolves the current session ID and directory.
2. `ActiveSessionChangesBadge` reads visible messages for that exact session.
3. `getSessionTouchedFilePaths` unions normalized file paths from user-owned scoped diffs and ignores assistant or unrelated entries.
4. A full Git-status refresh at stable message milestones keeps rich per-file `diffStats` current after model turns.
5. `resolveTouchedFileWorkingTreeDiffStats` sums only the active session's touched paths from the current working tree.
6. The unchanged `SessionChangesBadge` renders `+N / -N`, or disappears for an empty result.

## Failure and Race Handling

- Missing message ownership data or missing Git stats hides the badge instead of falling back to historical totals.
- Switching sessions changes both the message source and directory-scoped Git selection.
- Reverted messages are excluded through `useVisibleSessionMessages`.
- A late Git refresh only updates the directory it was requested for; the badge selector always reads the currently passed directory.

## Performance

- High-churn subscriptions live in a memoized child instead of `Header`.
- The Git selector returns a primitive encoded totals key, so unrelated Git-store changes do not rerender the badge.
- Touched paths are memoized from the session message-array reference.
- Full status refreshes occur when touched paths or the latest message milestone changes, not on text-part deltas or unchanged streaming records.

## Automated Verification

- Unit-test that overlapping per-turn summaries for the same file resolve to the current Git total rather than their sum.
- Unit-test that unrelated files are excluded and cleaned/deleted touched files yield no badge.
- Add a header source-contract regression test proving the header delegates to `ActiveSessionChangesBadge` and no longer reads `currentSession.summary` or `useSessionDiff`.
- Run focused UI tests and `bun run validate:affected`.

## Visual Verification

Use the real DevRyan UI with the clean `Test` project and OpenAI GPT-5.6 Sol:

1. Create `diff-counter-visual-check.txt` with three lines. Header and Git panel must both show `+3 / -0`.
2. Replace `beta` with `delta`. Header and Git panel must both remain `+3 / -0`.
3. Delete the file. Git must report a clean working tree and the header badge must disappear.
4. Reload the active session. The clean state must restore without a stale badge.

The test file must be deleted before finishing.
