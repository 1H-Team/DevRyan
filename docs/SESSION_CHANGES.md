# Session change summaries

## Ownership and capture

The shared harness runtime owns cumulative session changes independently of
optional turn evidence and diagnostic journaling. Web/Electron
instantiate `createSessionChangeHost` with their own private data root, OpenCode
request/auth adapter and event publisher. The managed
`devryan-session-changes.mjs` plugin registers the initial user message and
sends exact session/call execution boundaries over the existing bearer-protected
loopback bridge. The host resolves the assistant message and verifies the
session directory before capture. Canonical completed/error tool events finish
pending captures even when a failed or cancelled command bypasses the after hook.
Before-capture receipts must settle within 30 seconds, before the plugin
transport timeout; a late snapshot is unavailable even if execution proceeds.

Snapshots use a private bare Git repository and disposable private indexes under
`<data-root>/harness/session-changes/`. They enumerate tracked and non-ignored
untracked files, preserve raw bytes/modes/symlinks, and bypass clean filters.
A private nanosecond file-stat cache reuses unchanged raw objects; inode, device,
mode, size, modification and change times must all match. The optional stat cache uses at most 256 buckets of 64 KiB each. Path enumeration,
raw hashing and private-index updates stream in bounded batches. Cache loss causes
rehashing, and object collection invalidates the cache. They never write the user's index, object database, branch, HEAD or working files.
Git-backed capture includes dirty and staged starting states as the baseline.

Known native edit/write targets capture only their validated paths, including missing
targets; unrelated checkout files are neither enumerated nor hashed. Ancestor
symlinks are rejected. These targets provide explicit file scopes. Disjoint explicit
file operations can overlap without mixing attribution. Unknown execution tools,
including shell and MCP tools, capture the whole checkout. Overlapping unknown
windows and conflicting same-file windows remain unassigned. Known read-only
and task/Council wrapper tools do not capture; verified descendants contribute
their own operations. Repeated delivery deduplicates by session/call identity,
with exact assistant-message validation. No time-window containment deduplication
or current-repository fallback is used. An uninstrumented external writer cannot
be conclusively attributed from Git alone; missing runtime receipts produce
incomplete coverage, and conflicting recorded file chains are excluded.

## Summary and review contract

`GET /api/openchamber/session/:id/changes?directory=...` returns:

- `rootSessionID`, requested `directory`, canonical `worktreeDirectory`, `worktreeID` and `revision`.
- `coverage` (`complete` or `partial`) and machine-readable `reasons`.
- Net `fileCount`, total `additions`/`deletions`, a bounded `files` page,
  `sessionCount`, `firstUserMessageID` and optional `undone`.
- `pageIndex`, `nextCursor` and `previousCursor`. Follow-up file pages use
  `GET .../changes?revision=...&cursor=...`, without reconciling live history again.
  Pages contain at most 128 rows or approximately 256 KiB of row metadata.
- Each file has `path`, optional `oldPath`, status, contributing sessions and
  line counts. Binary line counts are `null`.

Before/after file chains compose chronologically across the verified root and
its descendants. Repeated edits count once; exact reversals disappear. Private
Git trees detect renames and compute net line counts. Another session's later
edits, commits and repository polling do not rewrite those trees.

`GET .../changes/diff?revision=...&file=...` reads only the selected stored
revision. The renderer captures that revision when opening review. Expired
revision detail returns `410 summary_detail_expired`; it never opens today's
repository diff instead. The diff response includes `patch`, `totalBytes`,
`pageIndex`, `nextCursor` and `previousCursor`; requests accept `cursor`. Patches
are generated lazily into private, disposable files and read in 64 KiB pages
aligned to UTF-8 boundaries. The UI replaces the current page instead of appending
an unbounded patch string. Current repository review is a separate card action.

The UI cache includes runtime URL, authenticated principal, directory and root
session. It validates response identity, fences stale requests, and clears on
account changes, deletion and directory disposal. It is bounded to 128 entries
and 8 MiB. Capture notifications use a narrow `session.changes.updated` channel;
ordinary Git polling does not refresh immutable captured history. Partial,
failed and loading results remain explicit when recorded files or an undone
revision justify the card. Empty loading/error/partial summaries stay hidden.
The card requires a completed response to the latest substantive submitted
non-plan turn, resolved message history, and an idle root and descendants with
no pending revert. Submitted plan intent comes from canonical message metadata
and recorded plan flags; maintenance continuations do not change it. Returning
to planning hides earlier cumulative changes, and changing the composer toggle
alone does not reveal them. An undone summary stays visible for Redo outside
planning. Failed reads with retained files offer Retry. A successful read-only shell command
produces no warning.

## Undo and Redo

`POST .../changes/undo` and `POST .../changes/redo` accept `{ revision }`.
The backend requires current exact revision, complete coverage and no busy
runtime sessions or pending capture. It restores only the same verified
operation set used by the summary. Every expected current file is checked before
any write and again immediately before its write. Restore rejects changed bytes,
modes, unsupported ancestors and ambiguous state. Writes are atomic per file;
a post-write verification precedes persistence. On failure it rolls back only
bytes still matching this transaction, reporting rollback failure explicitly
instead of overwriting a concurrent writer. Independent files are preserved.
Successful Undo/Redo advances the summary generation and invalidates UI data.

Card Undo is file-only. Existing per-message conversation revert continues to
use its existing planner and rollback protections. An active native conversation
rewind disables card Undo until restored. Like other filesystem operations,
external programs are not subject to the private lock; state checks prevent
known conflicts but do not constitute an OS-wide write lock.

## History, retention and limitations

History reconciliation imports one response page at a time and persists only
message/call identifiers, timestamps, the earliest user message, and a continuation
cursor. Completed scans subsequently refresh the head through the saved boundary;
incomplete scans resume on the next read. A 20-second reconciliation work slice
returns `history_pending`, and subscribed UI cards schedule another read. There is
no lifetime page-count, aggregate-history-byte or descendant-count ceiling.
Responses remain bounded to 16 MiB; oversized pages retry with a smaller requested
message count. An individually oversized or unavailable upstream response remains
an explicit observation failure rather than a fabricated complete history.

Older native file receipts can reconstruct exact textual before/after diffs,
including calls whose original capture record is unavailable. Recovery preserves
call/message identity and overlap information, and only resolves the repaired
call's capture failure. Worktree-wide turn diffs never establish ownership.
Historical receipts cannot prove file modes or complete execution capture, so
historical Undo remains disabled. Missing shell snapshots cannot be reconstructed
from the current checkout.

Production capture has no fixed snapshot-byte, path-count, operation-count,
session-registration, or cumulative storage-admission ceiling. Explicit runtime
options can impose operator/test limits; they are not enabled by the host.
Disk failures (`storage_unavailable`), command/capture deadlines (`capture_timeout`),
and interrupted captures remain distinct. Diagnostics record the phase, session
and call identity without source contents. Tool execution keeps its existing
behavior when capture fails; coverage never silently becomes complete.

Metadata version 2 stores individual operation/session blobs and bounded list
pages in the private Git tree at `refs/devryan/state`. A disposable index and one
compare-and-swap ref update publish each transaction. The metadata tree is an
on-disk index, not an application-memory copy of all retained operations. V1 JSON
records migrate on first access; the original bounded record remains intact,
uncommitted migration objects are harmless, and retry resumes from that original
until the new state is published.

Completed operations retain before/after trees containing their changed paths.
Every 128 settled operations, maintenance removes obsolete snapshot references
and runs private Git packing/collection under the worktree lock. It retains
pending capture trees and all objects needed by completed operations and recorded
revisions. Derived patch files and stat caches may be discarded and regenerated.
Maintenance failure does not invalidate a successfully persisted capture.

All summary revisions remain available until session deletion by default.
Deleting a child retains its verified contribution under the parent. Permanent
root deletion clears owned descendants and collects private objects; deleting
the last owned session removes the private repository and migrated legacy record.
Interrupted captures remain explicitly unavailable after restart. Large-file
Undo/Redo hashes working files and streams stored bytes into per-file atomic
replacements, retaining conflict verification and conditional rollback.

## Verification

`session-changes.test.js` exercises real temporary Git repositories, including
shell-only and partial writes, staged/dirty baselines, untracked and ignored
files, raw CRLF/filters, symlinks, binaries, renames, net-zero changes, descendant
retention, independent and overlapping writers, revision expiration, restart
and conflict-safe Undo/Redo. `session-changes-host.test.js` checks the shared
HTTP/plugin contract and history pagination. Plugin tests check tool coverage;
card/store tests check presentation and asynchronous isolation.
`session-changes-scale.test.js` crosses the old snapshot, path, storage, operation
and registration limits; verifies scoped capture, UTF-8 pagination, receipt repair,
metadata transaction failure, collection, and streaming large-file restore.

`tests/visual-session-changes/` mounts the production card and revision dialog
with deterministic fixture data. Expand/review, recorded diff, Undo/Redo,
independent-session switching and incomplete narrow layouts are manually
verified there. This fixture does not claim end-to-end provider execution.
