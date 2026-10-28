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

`canonical-source.js` accepts automatic compaction only from the private native
ordered sequence: the original user, completed `auto` compaction and successor
assistant must form one canonical parent chain. Compaction summaries are never
Plan content. Manual, pending or failed compaction, synthetic anchor text,
client parts/metadata and later human turns cannot supply that proof. Existing
owned native-stream continuation receipts remain independently required for
interrupted-stream successors, including mixed compaction/stream chains.
The private reader scans at most 2,000 native rows and 8 MiB, rejects repeated
cursors/IDs, and projects once over their canonical paging order so a page
boundary cannot supply a guessed parent. Its ordinals describe that order;
they are not bus event sequence numbers. Only sanitized verified membership
reaches the UI's existing Plan grouping contract.

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

## Successful source and implementation authority

`canonical-source.js` derives source identity from bounded, ordered canonical
message pages. A standalone plan must be the successful final assistant content
source. Native stream continuation prefixes join only through durable exact
continuation receipts; unrelated replacement assistants stay separate. The
receipt IDs, ordered parents and synthetic-content fingerprint must agree.
The successor attempt uses the original native trace/span witness schema;
receipt ordinal and canonical event sequence establish its order. The consumer
test drives the original recovery owner and accepts its unchanged durable
receipt, rather than substituting a numeric attempt fixture.
Public `sourceIdentity` contains message membership and current/success/settled
flags; private permit and configuration hashes never enter responses.

A current source also requires the native owner's controller/configuration pin,
primary cancellation generation, idle status, empty execution leases and settled
managed descendants/envelope barrier. Missing evidence fails closed. Historical
owned revisions remain readable, but cannot authorize a new Implement action.
An unsettled source answers 409 `plan_source_unsettled` with a closed `reason`
(`native-plan-settlement.js`): `barrier_pending`, `tasks_active`,
`sessions_busy`, `leases_active` and `primary_busy` are transient, and the client
waits them out and retries; `source_changed`, `superseded`, `cancelled`,
`needs_attention`, `pin_changed` and `invalid_state` are final.
Creation stores canonical content; editor updates return the actual saved bytes.
Observer failures after atomic publication do not turn a committed save into a
refusal. Fresh Implement admission requires the exact saved SHA-256 version and
a current successful settled canonical source.

The web Session Plans API reconciles the V2 creation-event display slug with
the current scoped session metadata only after `plan_identity_mismatch` (409).
It requires the exact session ID, requested directory and unchanged creation timestamp, updates only
the slug alias, and retries once. Directory, source, submitted content and
expected saved version stay fixed. Foreign/recreated sessions and version
conflicts remain refusals. The server checks identity before any save, so this
retry cannot reinterpret a committed write as an uncommitted operation.

Private `plan_read` must fit its constructor-owned reviewed output budget; large
plans return an actionable refusal directing the user to Plan View. When the plan
was written in this same session, `plan_read` returns
`{unchanged:true, version, sourceMessageID}` instead of the text, but only if
four things hold: the saved version matches the Implement marker, the saved
version matches the canonical source text, no compaction followed the source
message, and the source session is this session. Otherwise it returns the full
text, for example after a compaction, a later update, or a Plan View edit made
before Implement.
`plan_update` preflights a lean saved/path/version/sourceIdentity receipt before
publication and never echoes the submitted full plan after commit.
