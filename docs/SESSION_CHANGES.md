# Session change summaries

## Ownership and capture

The shared harness runtime owns cumulative session changes independently of
optional turn evidence and diagnostic journaling. Web/Electron and VS Code
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
mode, size, modification and change times must all match. Metadata quota scans
use bounded concurrency. Cache loss causes rehashing, and object collection
invalidates the cache. They never write the user's index, object database, branch, HEAD or working files.
Git-backed capture includes dirty and staged starting states as the baseline.

Known native edit/write targets provide explicit file scopes. Disjoint explicit
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
- Net `files`, `sessionCount`, `firstUserMessageID` and optional `undone`.
- Each file has `path`, optional `oldPath`, status, contributing sessions and
  line counts. Binary line counts are `null`.

Before/after file chains compose chronologically across the verified root and
its descendants. Repeated edits count once; exact reversals disappear. Private
Git trees detect renames and compute net line counts. Another session's later
edits, commits and repository polling do not rewrite those trees.

`GET .../changes/diff?revision=...&file=...` reads only the selected stored
revision. The renderer captures that revision when opening review. Expired
revision detail returns `410 summary_detail_expired`; it never opens today's
repository diff instead. Current repository review is a separate card action.

The UI cache includes runtime URL, authenticated principal, directory and root
session. It validates response identity, fences stale requests, and clears on
account changes, deletion and directory disposal. It is bounded to 128 entries
and 8 MiB. Capture notifications use a narrow `session.changes.updated` channel;
ordinary Git polling does not refresh immutable captured history. Partial,
failed and loading results are explicit. A successful read-only shell command
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

History is paginated beyond the old 1,000-message boundary. Reads cap at 100
pages per session, 1,000 descendants, 16 MiB per response and 64 MiB total history,
with request/history deadlines. Missing or truncated history is explicit.
Older native file receipts may reconstruct exact textual before/after diffs;
worktree-wide turn diffs never establish ownership. Historical receipts cannot
prove file modes or complete execution capture, so historical Undo is disabled.
External execution adapters can implement `SessionChangeRuntime` boundaries;
missing hooks remain incomplete instead of receiving guessed shell changes.

Capture defaults to 50,000 paths / 64 MiB per snapshot, 2,000 operations and
2,000 session registrations per worktree, and a 256 MiB storage admission budget.
Limits stop new captures explicitly rather than dropping cumulative ownership.
Each root retains its current summary and up to 20 previous revisions (4 MiB
of archived metadata). Older review detail becomes explicitly unavailable.
Private tree objects remain retained while operation records need them.
Deleting a child retains its verified contribution under the parent. Permanent
root deletion clears owned descendants and collects private objects; deleting
the last owned session removes the private repository. Interrupted captures
become unavailable after restart instead of being mistaken for completed tools.

## Verification

`session-changes.test.js` exercises real temporary Git repositories, including
shell-only and partial writes, staged/dirty baselines, untracked and ignored
files, raw CRLF/filters, symlinks, binaries, renames, net-zero changes, descendant
retention, independent and overlapping writers, revision expiration, restart
and conflict-safe Undo/Redo. `session-changes-host.test.js` checks the shared
HTTP/plugin contract and history pagination. Plugin tests check tool coverage;
card/store tests check presentation and asynchronous isolation.

`tests/visual-session-changes/` mounts the production card and revision dialog
with deterministic fixture data. Expand/review, recorded diff, Undo/Redo,
independent-session switching and incomplete narrow layouts are manually
verified there. This fixture does not claim end-to-end provider execution.
