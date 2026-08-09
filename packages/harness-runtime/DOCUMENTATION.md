# Harness Runtime

`@openchamber/harness-runtime` is the dependency-free Node ESM owner for durable
DevRyan harness operations. It contains atomic private-file persistence,
versioned record stores, turn lifecycle correlation, durable worktree bootstrap
receipts, sanitized diagnostic journaling/export preparation, and optional Git
turn-evidence primitives.

Host packages inject storage roots and platform effects. The shared UI never
imports this package; it consumes HTTP or VS Code bridge contracts.

## Storage

`createHarnessPaths({ rootDir })` creates a `harness/` namespace below a host
owned data root. Files are written with private permissions using a
file-fsync/rename/parent-fsync sequence. Invalid JSON records are moved to a
`quarantine/` directory and do not prevent startup.

## Runtime ownership

- `lifecycle.js`: synchronous canonical OpenCode-event correlation.
- `worktree-bootstrap.js`: durable idempotent receipt state machine.
  Version 2 receipts include an `ownerId`; version 1 records migrate to the
  explicit `local-admin` owner so shared-host retries cannot cross principals.
  A terminal receipt can be explicitly superseded when the same idempotency key
  is reused with a different request fingerprint; active queued/running work is
  never superseded and still returns a conflict. Resolved worktree directories
  are also single-flight keys: matching concurrent submissions share the one
  authoritative receipt, conflicting setup or maintenance returns
  `409 WORKTREE_DIRECTORY_BUSY`, and active setup prevents removal.
- `session-id.js`: canonical four-way record attribution plus session-parent
  relations shared by storage and export selection.
- `journal-trim.js`: bounded pre-sanitization policy that drops streaming
  deltas and coalesces repeated part/session updates. It flushes on completion,
  lifecycle boundaries, debounce, drain, and capacity pressure.
- `sanitizer.js` and `journal.js`: always-on, bounded, sanitized NDJSON capture
  partitioned into `sessions/<sessionID>/` and an unattributed `runtime/`
  bucket. Each bucket has an atomic manifest, gzip-compressed closed chunks,
  one plain crash-safe active chunk, and gzip blob sidecars. The root generated
  `README.md` and `index.json` make the format self-describing. Clear removes
  all current and legacy journal data while preserving those discovery files
  and accepting newly arriving records afterward.
  Supported record schemas retain a sanitized `actor` identifier supplied by
  the host, allowing shared-host diagnostics to be attributed without exposing
  authentication material.
- `export.js`: task/runtime export selection and second-pass redaction. Bundle
  version 2 streams one plain NDJSON entry per session plus `runtime.ndjson`,
  an included-manifest index, and decompressed plain-text blobs.
- `evidence-git.js` and `evidence-ledger.js`: opt-in interval evidence that never
  mutates the user's index, HEAD, branch, or working tree.

## Operational limits

- Journal writes are ordered through a bounded O(1) enqueue path. Per-session
  chunks rotate at 4 MiB, the LRU writer pool keeps at most six file
  descriptors open, retention is seven days, and total storage caps at 1 GiB
  by default. The VS Code host intentionally selects a 256 MiB cap. Legacy
  flat segments prune before whole inactive session directories; runtime
  closed chunks are the final tier.
- `message.part.delta` is intentionally omitted. Repeated
  `message.part.updated` and `session.updated` events are last-write-wins with
  stored `coalesced` counts and manifest trim totals; intentional trims never
  emit `gap` records.
- Large sanitized strings are stored as bucket-local gzip blobs. Binary attachments
  retain only filename/MIME/size/SHA-256 metadata.
- Worktree terminal receipts retain 90 days or 2,000 operations; active
  receipts are never pruned.
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
