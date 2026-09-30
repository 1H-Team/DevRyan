# Session plan revision API

## Purpose

This module owns canonical plan Markdown storage for web and Electron runtimes.
It exists so a managed developer can save, open, and edit a plan belonging to
one owned session without receiving general filesystem access.

## Contract

- `POST /api/session/:sessionID/plan-revisions/:sourceMessageID` creates the
  deterministic revision file once and preserves an existing file.
- `GET /api/session/:sessionID/plan-revisions/:sourceMessageID` reads the exact
  deterministic revision.
- `PUT /api/session/:sessionID/plan-revisions/:sourceMessageID` updates an
  existing revision from Plan View using the required `expectedVersion`.

All three operations return the SHA-256 `version` of the saved UTF-8 bytes.
An update without a version returns 428 (`plan_version_required`); a stale
version returns 409 (`plan_version_conflict`) with the current `version`.
`revisions.js` is the shared HTTP and private-tool storage boundary: it holds a
cross-process file lock, compares the version, stages a unique temporary file,
rechecks authorization, then atomically renames it. Failed publication leaves
the original intact. Full replacements must be nonblank and at most 256 KiB
UTF-8; content is never truncated. Files must be regular, nonsymlink revisions
inside the exact project's plans directory.

Root Builder and Orchestrator use `devryan_task` actions `plan_read` and
`plan_update` through private `harness_plan`, independently of context
projection. The host selects the revision from the canonical synthetic
Implement Plan marker on the durable objective; callers supply no path or
target identity. The current canonical assistant/tool call, root agent,
ownership, project, cancellation generation and writable objective are
revalidated at commit. Specialists report proposed changes to their parent.
The hidden Plan agent remains unable to invoke this tool.

Markers may carry the registered `projectDirectory` from the saved revision.
`selected-revision.js` is shared by the private writer and compaction.
Local legacy markers resolve only when the OpenCode project root and source
session directory identify exactly one existing revision. Managed hosts use
the current ownership-derived repository root. Compaction uses the same
resolver and reads the current saved outline; files are not migrated.

Writes publish `session.plan.updated` with revision identity and version only,
and record content-free write/refusal diagnostics. Plan View skips load echoes,
serializes saves against its acknowledged version, refreshes a clean matching
view, and retains a dirty draft on conflict. These events do not create another
Plan Card.

The revision identity is the session ID, source message ID, registered project
root, session creation timestamp, and session slug. The client retains that
exact identity together with the path returned by `POST`, then reuses it for
Plan View reads and updates instead of rebuilding it from the session's current
directory.

The server derives each path below
`<data-dir>/projects/<project-id>/plans`. The project ID storage component is
unchanged up to 255 ASCII characters; longer IDs use `path_sha256_<full SHA-256
of the ID>` from the shared runtime helper. Public project IDs stay unchanged,
and previously writable plan paths are preserved. For a managed principal, the project
root comes from the active session-ownership row and its current project/branch
assignment. A session may execute from an OpenCode worktree, but its plan
revision remains keyed to the registered repository root. The submitted
directory is only an assignment-consistency check; no route accepts it as a
caller-selected output path.

Foreign or archived ownership, revoked assignments, and project mismatches fail
closed. Managed requests remain subject to the normal CSRF and assigned-directory
checks. General `/api/fs/*` policy is unchanged.

HTTP reads and writes verify the source assistant message belongs to the URL
session and derive its creation time and slug from bounded canonical OpenCode
metadata. Submitted identity fields must match that session. Managed admission,
the final read, and both locked write checks reload the authenticated caller's
current grants; a request snapshot cannot retain revoked access. The project,
branch, and storage root must remain unchanged before publication. OpenCode's
shared `global` identity never authorizes unrelated non-Git roots: HTTP and
private selection require the actual source/current session directories to
remain inside the selected root. Historical Git worktree messages are read
through the authorized registered root, preserving saved revision access after
that worktree disappears.
If the canonical source session or message is unavailable, access fails closed;
stored Markdown alone does not establish its ownership.
