# Harness Runtime

`@openchamber/harness-runtime` is the dependency-free Node ESM owner for durable
DevRyan harness operations. It contains atomic private-file persistence,
versioned record stores, turn lifecycle correlation, durable worktree bootstrap
receipts, sanitized diagnostic journaling/export preparation, and optional Git
turn-evidence primitives. It also owns the host-neutral persisted command-
deadline controller used by web/Electron.

`lib/atomic-file.js` also exports a dependency-free cross-process lock. Locks
are acquired with exclusive `wx` creation and private mode, carry a random
token plus PID/timestamp, reclaim only proven-dead or safely stale malformed
owners, time out deterministically around live owners, and delete only when the
release token still matches. Project configuration uses this primitive to
serialize scheduler claims and ordinary mutations across web/Electron server
processes.

Host packages inject storage roots and platform effects. The shared UI never
imports this package; it consumes HTTP bridge contracts.

## Storage

`createHarnessPaths({ rootDir })` creates a `harness/` namespace below a host
owned data root. Files are written with private permissions using a
file-fsync/rename/parent-fsync sequence. Invalid JSON records are moved to a
`quarantine/` directory and do not prevent startup.

## Runtime ownership

- `lifecycle.js`: synchronous canonical OpenCode-event correlation.
- `prompt-admission.js`: synchronous named-hold controller shared by web/Electron
 . A hold returns the exact HTTP-shaped block for new prompts and
  managed-work launches while allowing active work, cancellation, result
  acknowledgement, and shutdown to drain. Reference-counted releases prevent
  one recovery owner from reopening admission held by another.
- `worktree-bootstrap.js`: durable idempotent receipt state machine.
  Version 3 receipts add the explicit `run_post_checkout_hook` stage; version 1
  records first migrate to the `local-admin` owner and version 1/2 terminal or
  already-advanced receipts skip the newly introduced hook so migration never
  replays user code. New receipts run the stage immediately after population.
  A terminal receipt can be explicitly superseded when the same idempotency key
  is reused with a different request fingerprint; active queued/running work is
  never superseded and still returns a conflict. Resolved worktree directories
  are also single-flight keys: matching concurrent submissions share the one
  authoritative receipt, conflicting setup or maintenance returns
  `409 WORKTREE_DIRECTORY_BUSY`, and active setup prevents removal.
- `command-deadline.js`: exact shell-call deadline ownership. It fingerprints
  the session, assistant message, part, call, and tool; persists no command
  text; preserves the first absolute deadline across repeated updates; and
  immediately reconciles overdue records after restart or system sleep. Thirty
  seconds after the declared deadline it fetches the exact message, issues at
  most one session abort, and waits up to ten seconds for authoritative
  settlement. A managed runtime restart is allowed only when that session is
  the sole active operation. Concurrent and external runtimes remain untouched
  and surface an unresolved incident. Commands are never replayed.
- `git-post-checkout-hook.js`: bounded cross-host post-checkout runner. It
  resolves the effective `core.hooksPath` (including a global path that shadows
  repository-local hooks), skips absent hooks, and requires Git 2.36+ only when
  a hook is present. Existing hooks run once as
  `git hook run --ignore-missing post-checkout -- <zero> <HEAD> 1` in the new
  worktree. Timeout/nonzero failures are hard setup failures with byte-capped,
  terminal-control-stripped, path-sanitized receipt excerpts. The stage is not
  replay-safe: interrupted execution becomes `needs_attention` and reruns only
  after explicit Retry.
- `session-id.js`: canonical four-way record attribution plus session-parent
  relations shared by storage and export selection.
- `journal-trim.js`: bounded pre-sanitization policy that drops streaming
  deltas and coalesces repeated part/session updates plus property-free,
  unattributed `sync` events. It flushes on completion, lifecycle boundaries,
  debounce, drain, and capacity pressure.
- `sanitizer.js` and `journal.js`: always-on, bounded, sanitized NDJSON capture
  partitioned into `sessions/<sessionID>/` and an unattributed `runtime/`
  bucket. Each bucket has an atomic manifest, gzip-compressed closed chunks,
  one plain crash-safe active chunk, and gzip blob sidecars. The root generated
  `README.md` and `index.json` make the format self-describing. Clear can remove
  a recent time range by rebuilding older retained records and their blob
  sidecars, or remove all current and legacy journal data. Both modes preserve
  the discovery files and accept newly arriving records afterward.
  Web/Electron hosts record raw OpenCode events only from the canonical global
  watcher; event transport bridges never call the journal, preventing duplicate
  records when multiple UI stream clients are attached.
  Supported record schemas retain a sanitized `actor` identifier supplied by
  the host, allowing shared-host diagnostics to be attributed without exposing
  authentication material. Provider-reported assistant token snapshots retain
  only the numeric `total`, `input`, `output`, `reasoning`, `cache.read`, and
  `cache.write` fields so context-usage counts remain auditable without widening
  the general nested-field allowlist.
  Bot browser network/gap records retain the event, Bot/process stream,
  sequence, generation, observation time, masked origin/path, request type,
  status/reason, and missing-sequence bounds. Their dedicated payload projection
  drops headers, bodies, and input even though ordinary execution records may
  permit those fields. A real journal write/read regression verifies this
  contract after sanitization, rather than testing only a recorder mock.
- `export.js`: task/runtime export selection and second-pass redaction. Bundle
  version 2 streams one plain NDJSON entry per session plus `runtime.ndjson`,
  an included-manifest index, and decompressed plain-text blobs.
- `evidence-git.js` and `evidence-ledger.js`: opt-in interval evidence that never
  mutates the user's index, HEAD, branch, or working tree.

## Operational limits

- Journal writes are ordered through a bounded O(1) enqueue path. Per-session
  chunks rotate at 4 MiB, the LRU writer pool keeps at most six file
  descriptors open, retention is seven days, and total storage caps at 1 GiB
  by default. Legacy
  flat segments prune before whole inactive session directories; runtime
  closed chunks are the final tier.
- `message.part.delta` is intentionally omitted. Repeated
  `message.part.updated` and `session.updated` events are last-write-wins with
  stored `coalesced` counts and manifest trim totals. Property-free,
  unattributed `sync` events use the same bounded last-write-wins window without
  changing live SSE delivery; intentional trims never emit `gap` records.
- Large sanitized strings are stored as bucket-local gzip blobs. Binary attachments
  retain only filename/MIME/size/SHA-256 metadata.
- Worktree terminal receipts retain 90 days or 2,000 operations; active
  receipts are never pruned.
- Shell commands default to 240,000 ms and may declare 1,000 through 3,600,000
  ms. Deadline reconciliation begins after a 30,000 ms grace period.
- Evidence retains seven days or 200 turns per primary repository and removes
  its hidden refs when records are pruned, sessions are deleted, or the user
  clears a project. A clean unchanged worktree reuses the before tree for the
  after commit, avoiding a second temporary-index scan.

Diagnostics are always local and always on. Export is explicit, branded
`DevRyan-diagnostics-*.zip`, and receives a second redaction pass plus a sharing
warning. Turn evidence is separately opt-in, default-off, read-only interval
evidence; it is never a restore point or an attribution mechanism.

## Journal inspection

From the repository root, run `bun scripts/journal.mjs list`, then
`bun scripts/journal.mjs show <sessionID>`. The zero-dependency CLI reads gzip,
active plain chunks, runtime records, and legacy segments. It also supports
type/event/time/grep/tail filters plus `gaps`, `blob`, and `path` commands.
The default `gaps` command trusts valid zero-gap bucket manifests and scans only
positive, missing, or invalid manifests plus legacy segments. Use `gaps
--verify` to scan every chunk when checking the manifests themselves.

An administrator Error Log event UUID locates a durable sanitized summary; it
is not expected to appear in this journal. Resolve the UUID through the Error
Log detail API first and capture its `sessionId`, timestamp, action/kind, and
available `callId`, `toolId`, `messageId`, or `taskId`. Use the session and
strongest identifier to retrieve execution evidence, normally
`bun scripts/journal.mjs show <sessionID> --grep <callId>`. Fall back to another
identifier or a bounded `--since`/`--until` window and run
`bun scripts/journal.mjs gaps` before drawing conclusions. Error Logs provide
durable administrative indexing and classification; the local journal provides
prompts, tool output, lifecycle ordering, recovery behavior, and detailed
failure evidence. If the relevant host journal is unavailable, expired, or has
a qualifying gap, report the limitation instead of reconstructing missing
detail.
# Primary provider recovery

The dependency-free `provider-recovery` controller and `provider-recovery-host`
adapter own primary turn admission, semantic liveness, durable recovery and
cancellation across web/Electron. Default policy is observe. Full
safety, protocol, storage, rollout and rollback contracts are documented in
[`docs/PROVIDER_RECOVERY.md`](../../docs/PROVIDER_RECOVERY.md).

## Session-owned changes

`lib/session-changes.js` owns always-on execution receipts, private Git snapshots, cumulative net summaries, bounded stored revisions, and conflict-checked file-only Undo/Redo. It is independent of optional diagnostic evidence. `lib/session-changes-host.js` validates canonical session identity, lineage and directory; consumes paginated history; and exposes the same plugin/HTTP contract in web/Electron. Full contract, operational limits and verification: `docs/SESSION_CHANGES.md`.
