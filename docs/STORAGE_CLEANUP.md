# Local repository storage

DevRyan development retains independent Electron QA applications, Rust build
caches, private test environments and dependency snapshots. These are separate
from installed-app conversations and configuration. Git-ignored does not mean
disposable: QA evidence, native donors and dirty worktrees may live in caches.

## Preview and manual cleanup

Run from the repository root, with builds, QA and benchmarks paused. The utility
never stops processes. Do not launch new QA/build work while applying a manifest:
process inspection is a point-in-time safeguard, not a lock on other programs.

```sh
node scripts/storage.mjs audit --manifest .cache/storage/review.json
node scripts/storage.mjs clean
node scripts/storage.mjs clean --apply .cache/storage/review.json
```

Both `audit` and plain `clean` only preview. `--manifest` writes a new inventory
without deleting anything; existing files are not overwritten. Review eligible
paths, estimated allocated bytes, references and protection reasons. Only
`clean --apply` deletes files. `--json` or `--quiet` changes presentation, never
validation. Invalid requests, refusals and partial failures exit nonzero.
Manifest input/output paths are repository-relative JSON files directly under
`.cache/storage`. Invalid JSON errors never echo file contents. No new
dependencies are required.

Apply re-audits policy, compares file identities and provenance, and checks
process usage immediately before each deletion. Changed or protected candidates
are refused; other independent candidates can complete. Results are recorded
under `.cache/storage/cleanup-*.json`. Re-run audit for a fresh manifest after
changes. Repeated old applies refuse removed files without deleting anything
else. Do not edit manifests to bypass protection.

## Retention policy

- Keep the two newest verified top-level `.cache/qa/packaged-electron-*` packages,
  native donors, explicit pins, packages referenced by direct QA/performance JSON
  configurations, baseline references in source/docs and anything in use.
- Other completed, provenance-checked QA `.app` bundles may be removed regardless
  of age. Keep surrounding evidence, screenshots, logs, builder metadata and the
  original `package-evidence.json`. Ordinary historical audit references do not
  require keeping an executable forever.
- Only recognized Cargo `target/release` and `target/debug/incremental` caches
  with no descendant modified within fourteen days can be removed. Recent caches
  are kept, even if a cold rebuild could reproduce them.
- Preserve every registered worktree, tracked file and non-ignored untracked file.
  Worktrees are never removed recursively by this utility. Separately reviewed
  retirement must use Git after preserving unique source and evidence.
- Preserve dependencies, runtime companions, release output, databases,
  credentials, conversations and Docker data. Legacy temporary fixtures,
  dependency snapshots and unrecognized contents are report-only until their
  ownership/completion is established. The tool does not inspect upstream
  checkouts or installed-app/global storage.

New QA packages have mutable `storage-retention.json`, separate from immutable
package evidence. It records `schemaVersion: 1`, ISO `createdAt`/`completedAt`,
`pinned` and `payloadState` (`building`, `ready`, `removing`, `historical`). Set
`pinned: true` to retain a baseline; optional `pinReason` explains why. Missing
legacy metadata uses the evidence file timestamp only for newest-package
ordering, never as proof that an unknown environment is old enough to delete.

Before deletion the package is marked `removing`; after success it becomes
`historical`. Both are rejected by the QA artifact loader, so preserved reports
cannot be mistaken for runnable acceptance evidence. Partial deletion leaves
`removing` and its failure report for investigation. Never reset it to `ready`
without reconstructing and verifying the complete original payload.

## Recovery and limitations

Rebuild needed QA apps with the [QA packaging recipe](QA.md), retained web
artifact and compatible native donor. This produces new provenance; it does not
guarantee reproduction of old executable bytes. Pin packages when exact historical
reproduction is required. The normal native donor,
`packages/electron/dist/mac-arm64/DevRyan.app`, is never a cleanup target.
Cargo regenerates removed compilation outputs on its next locked build/test.

Process checks require usable `lsof` visibility. Missing tools, inspection
warnings, changed identities and symlink escapes fail closed. Internal Electron
framework symlinks are allowed only within the candidate bundle. A stale
`.cache/storage/apply.lock` after a crash must be investigated against its PID and
cleanup report before manual removal; it is never cleared automatically.

Allocated-byte estimates do not guarantee equal filesystem free-space gains:
APFS clones, snapshots, hard links and concurrent builds affect the result.
Measure both repository size and volume free space after verification.
No cleanup is scheduled automatically.
