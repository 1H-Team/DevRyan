# Active Session Diff Counter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the top-center header badge display current working-tree additions and deletions for files touched by the active session only.

**Architecture:** Use scoped user-message diffs only to identify active-session file ownership, then intersect those paths with current Git `diffStats`. Render the result from a memoized child so message and Git subscriptions do not fan out through the full header.

**Tech Stack:** React, TypeScript, Zustand, Bun test

## Global Constraints

- Work directly on `main` as explicitly approved by the user.
- Keep the change in shared UI; do not change runtime contracts or add dependencies.
- Preserve sidebar badge behavior.
- Use TDD and run `bun run validate:affected`.
- Repeat the real OpenAI/Test-project visual scenario before completion.

### Task 1: Specify active-session ownership plus current net totals

**Files:**
- Modify: `packages/ui/src/lib/sessionDiffStats.test.ts`
- Modify: `packages/ui/src/lib/sessionDiffStats.ts`
- Create: `packages/ui/src/components/layout/Header.diffStats.test.ts`

- [x] Write a failing test where one active session creates a three-line file and later replaces one line. With current Git stats at `+3 / -0`, the helper must return `+3 / -0`, not accumulated `+4 / -1`.
- [x] Assert that assistant-owned/unrelated paths are excluded.
- [x] Assert that a touched file absent from current Git stats produces no badge.
- [x] Write the failing header source contract requiring `ActiveSessionChangesBadge` and forbidding `useSessionDiff` and summary-derived header totals.
- [x] Run the focused tests and observe the intended RED failures.
- [x] Implement normalized path collection and current working-tree aggregation helpers.

### Task 2: Isolate the live badge and wire the header

**Files:**
- Create: `packages/ui/src/components/session/ActiveSessionChangesBadge.tsx`
- Modify: `packages/ui/src/components/layout/Header.tsx`

- [x] Read visible messages for only the active session and memoize the touched path set.
- [x] Select only current Git totals for those paths and return a primitive selector value to preserve render stability.
- [x] Refresh full Git status when touched paths or the latest message milestone changes so rich `diffStats` cannot remain stale after cleanup without polling on streaming updates.
- [x] Render the existing `SessionChangesBadge` from the isolated child.
- [x] Remove the header's direct summary and session-diff aggregation.
- [x] Run focused helper, header contract, and event-reducer tests with zero failures.

### Task 3: Validate and visually prove the regression is fixed

- [x] Build the web UI successfully.
- [x] In the real `Test` project with OpenAI GPT-5.6 Sol, create the three-line test file and verify header and Git both show `+3 / -0`.
- [x] Replace `beta` with `delta` and verify both remain `+3 / -0`.
- [x] Delete the file and verify Git is clean and the header badge disappears.
- [x] Reload the active session and verify the clean state does not leak a stale badge.
- [x] Run `bun run validate:affected`, `git diff --check`, and inspect the final diff.
- [x] Commit the implementation directly to `main`.

The `Test` project must be clean before completion.
