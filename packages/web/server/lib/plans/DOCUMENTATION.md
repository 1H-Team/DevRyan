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
  existing revision from Plan View.

The revision identity is the session ID, source message ID, registered project
root, session creation timestamp, and session slug. The client retains that
exact identity together with the path returned by `POST`, then reuses it for
Plan View reads and updates instead of rebuilding it from the session's current
directory.

The server derives each path below
`<data-dir>/projects/<project-id>/plans`. For a managed principal, the project
root comes from the active session-ownership row and its current project/branch
assignment. A session may execute from an OpenCode worktree, but its plan
revision remains keyed to the registered repository root. The submitted
directory is only an assignment-consistency check; no route accepts it as a
caller-selected output path.

Foreign or archived ownership, revoked assignments, and project mismatches fail
closed. Managed requests remain subject to the normal CSRF and assigned-directory
checks. General `/api/fs/*` policy is unchanged.
