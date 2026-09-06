# Active-directory background hydration design

## Problem

DevRyan's session sidebar performs background work for sessions in several
directories at startup. The work includes root-session child discovery,
historical user/assistant activity hydration, and neighbor prefetch.

OpenCode owns a separate runtime context per directory. With user-configured
local MCP servers, the first scoped request for a new directory starts another
copy of each server. A controlled runtime test showed:

- managed OpenCode cold baseline: 7 processes, including two Railway/Resend MCP
  sets, about 0.95 GiB RSS;
- a message read in the already-active directory: no new processes;
- the same read scoped to a second DevRyan directory: 13 processes, two more
  Railway/Resend sets, about 1.83 GiB RSS;
- opening the UI with several known projects: 23 processes before the guarded
  ceiling stopped the isolated server.

Temporary request telemetry showed automatic requests for inactive project,
worktree, home, and stale temporary-session directories. The telemetry was
removed after capture.

## Decision

Background session hydration is scoped to the current directory.

- Historical user-activity and archived assistant-activity fetches may run only
  for sessions whose resolved directory matches the current directory.
- Sidebar root-session child discovery may run only for the current directory.
- Automatic neighbor prefetch may consider only sessions in the current
  directory.
- Read-only sync subscriptions for inactive session rows create passive stores
  from cached data without bootstrapping directory APIs.
- Provider configuration, reconnect, visibility recovery, and replay-gap
  recovery may bootstrap or re-fetch only the current directory.
- Global session metadata and already-cached child-store data remain available
  for rendering inactive projects.
- Selecting a project or session remains the explicit lifecycle edge that
  changes the current directory and enables its normal bootstrap/materialization.

Paths are normalized for separators, trailing slashes, and case before policy
comparison so web and Electron share the same rule.

## Why this boundary

The UI does not need message bodies, child lists, or recency scans from every
project to render the global sidebar. Session metadata provides deterministic
fallback ordering, and live events update activity for loaded sessions. Starting
directory-owned runtime services is therefore disproportionate background work.

The rule is enforced at automatic caller and read-subscription boundaries rather
than by changing `ChildStoreManager.ensureChild()`'s default. `useDirectoryStore`
and explicit-directory `useSession` subscriptions pass `bootstrap: false` for
inactive directories, while provider configuration and recovery select only the
normalized current-directory store. Imperative sync callers still use the
default bootstrap authority for explicit selection, materialization, and user
actions; globally suppressing it would make lifecycle intent ambiguous.

## Verification

Focused tests cover normalized directory matching, active-store selection,
activity candidate filtering, archived candidate filtering, child target
filtering, and neighbor selection.
Runtime verification repeats the same guarded startup with corrected descendant
tracking. Loading the UI must not create OpenCode child processes for inactive
directories, and selecting the active Test workspace must remain functional.

## Non-goals

- Changing OpenCode's per-directory runtime model or the user's MCP config.
- Terminating the user's already-running packaged DevRyan instance.
- Changing global session-list pagination or destructive session operations.
