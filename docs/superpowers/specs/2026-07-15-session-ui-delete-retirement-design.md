# Session UI Delete Retirement Design

## Problem

Permanent session deletion removes authoritative sync data, but `session-ui-store.ts` still retains exact-session ownership in multiple maps and sets. The retained data includes worktree routing, plan lifecycle, starter context, abort state, and non-Git UI state. Some plan ownership is persisted across reloads, and an exact-session `AbortController` can remain live after deletion. `session-worktree-store.ts` also retains the deleted session's authoritative attachment.

Archive is reversible and must preserve all of this state. Only authoritative `session.deleted` is a retirement boundary.

## Design

Add one `retireDeletedSession(sessionId)` action to the session UI store and invoke it from authoritative deletion handling after clearing an exact selected session.

The action:

1. cancels both completion-settlement timers;
2. aborts and removes only the exact session's pending send controller;
3. removes exact keys from `worktreeMetadata`, `sessionDirectoryHints`, `webUICreatedSessions`, `sessionAbortFlags`, `sessionPlanAvailable`, `sessionPlanIndicator`, `sessionCompletionIndicator`, `planModeUserMessagesBySession`, `starterAssistantMessages`, and `pendingChangesBarDismissed`;
4. clears an exact armed abort prompt;
5. removes the message ID owned by the session's `planModeUserMessagesBySession` entry from `planModeUserMessages`;
6. removes only implemented-plan request keys beginning with the unambiguous `${sessionId}:` namespace;
7. rewrites persisted plan state only when plan ownership changed;
8. removes an exact legacy Cursor draft-prewarm record; and
9. clears the exact attachment in `session-worktree-store`.

Every unaffected collection keeps its original reference. The action does not infer ownership for detached historical plan message IDs that have no session mapping; those remain bounded by the existing persistence cap.

## Safety

- No cleanup occurs for `session.updated` archive events.
- No project, directory, or store-wide reset is introduced.
- Similarly prefixed session IDs are protected by the delimiter-bearing `${sessionId}:` prefix.
- The controller is aborted before its map entry is retired so pending delivery observes cancellation.
- Unrelated entries and their object identities are preserved.
- Existing selected-session side effects remain owned by `setCurrentSession(null)`.

## Verification

- Store regression: seed every owned collection for target and retained sessions, retire the target, and assert exact cleanup plus controller cancellation.
- Persistence regression: prove target mapped plan message and implementation keys are gone after retirement while unrelated and similarly prefixed keys remain.
- No-op regression: retiring a missing session preserves every collection reference.
- Sync regression: authoritative deletion invokes retirement; archive preserves the same state.
- Production replay: seed target and retained state, inject permanent deletion, and verify target absence before and after reload without blocked mutations.
