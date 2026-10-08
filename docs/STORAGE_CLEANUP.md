# Local repository storage

DevRyan development retains independent Electron QA applications, Rust build
caches, private test environments and dependency snapshots. These are separate
from installed-app conversations and configuration. Git-ignored does not mean
disposable: QA evidence, native donors and dirty worktrees may live in caches.

Heavy QA writes about 25 GB a day under the gitignored `.cache/`. Producers now
remove their own runtime payloads when a run passes or is interrupted (see
[QA.md](QA.md)); this tool reports what remains and prunes it under a retention
policy that never deletes cited evidence.

## Commands

```sh
bun run cache:report            # every top-level .cache family: owner, class, size, reclaimable bytes
bun run cache:prune             # preview only: what would be stripped or removed, and why the rest is kept
bun run cache:prune --apply     # preview, then delete (re-audits and rechecks each target before removing it)
bun run cache:prune --max-size 30G --apply   # custom budget (default 50G)
bun run cache:prune --evict-evidence         # also preview evicting the oldest uncited evidence runs to meet the budget
```

`bun run clean` is the same preview as `cache:prune`. `node scripts/storage.mjs
report|audit|clean` accepts the same options, plus the manifest workflow below
(`--manifest`, `--apply <manifest>`). `report` prints a table and the suggested
`git worktree` commands; `--json` prints the full audit. Both walk the whole
cache, so allow a minute or two. `validate:full` prints a one-line warning when
`.cache` exceeds the budget or free disk is below 20 GB; it never fails the run.
Preview scans tolerate cache entries removed during enumeration; other filesystem
errors still fail the command.

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
`clean --apply` (with or without a manifest) deletes files. `--json` or `--quiet` changes presentation, never
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

## Retention classes

Every top-level `.cache` entry is classified by a registry in
`scripts/storage-policy.mjs`. A unit is a direct child of a family (for example
`.cache/qa/<run>`), or the entry itself for unowned names. Nothing modified in
the last 24 hours is ever selected, whatever the class.

| Class | Matches | Rule |
|---|---|---|
| scratch | `test-fixtures/*`, `wf/*`, `storage-tests/*`, `*/tmp`, `v2-validation/journal-reader-*`, `v2-validation/compaction-journal-*` | removed after 24 hours unless cited, pinned or protected |
| run evidence | `qa/*`, `v2-validation/*`, `perf/*`, `livetest/*`, `opencode-upgrade/*`, `release-*/*`, `v2-spike/*`, `browser-upgrade/*`, `browser-inspect/*` | after 3 days, heavy subtrees are stripped and light files kept; the 5 newest failed runs per family stay intact |
| rebuildable | `qa/packaged-electron-*` (the existing package rule below), `qa/stage-f-*`, `browser-upgrade/install-*`, `v2-validation/native-artifact-*` | packaged outputs that later runs consume: newest 2 per kind stay intact plus pinned, cited and native donors; older ones lose heavy payloads |
| session | `sessions/<date>-<task>/` | heavy subtrees stripped after 14 days; logs kept |
| unowned | any other name, including loose `.cache/*.log` | removed after 14 days unless cited or pinned (cited: heavy subtrees stripped, files kept) |
| worktrees | `worktrees/*` and every registered worktree | report only |
| report only | `shared/` (shared Bun install cache), `storage/`, `eslint/`, `typecheck/`, `plugin-upgrades/`, `session-execution/`, `windows-native/` | sized and listed; never selected |

Heavy subtrees: `node_modules`, `.bun`, `runtime-bundles`, `*.app`, Chromium
caches (`Cache`, `Code Cache`, `GPUCache`, `Dawn*Cache`, `GrShaderCache`,
`ShaderCache`), any directory holding `CACHEDIR.TAG`, and binaries (`.dmg`,
`.asar`, `.node`, `.dylib`, `.so`, `.dll`, `.exe`, `.wasm`, `.pak`, `.msi`,
`.nupkg`, `.pdb`, or Mach-O/ELF/PE content of 256 KiB or more). Light files
(`.json`, `.jsonl`, `.ndjson`, `.log`, `.txt`, `.md`, `.png`, `.sha256`, `.err`)
are never stripped. Files that are neither heavy nor light (archives, databases,
scripts) are left alone and show up as size in the report.

Metadata read from a run directory: `run.json` (`status`, `pinned`,
`completedAt`, written by `scripts/qa/run-root.mjs`) and the older
`storage-retention.json` (`pinned`, `payloadState`, `completedAt`). `pinned: true`
keeps the whole run. A `failed` status counts toward the per-family failure cap.
Without either file the newest modification time inside the unit is its age.

## Citations and protected inputs

Committed docs and code cite about 700 `.cache/...` paths as evidence, often by
SHA-256 alone. The tool collects every `.cache/...` path mentioned in tracked
or non-ignored files (docs, code, JSON, workflows) plus direct `.cache/qa/*.json`
and `.cache/perf/*.json` configuration.

- A cited file is never deleted, even when it is a binary.
- A cited directory (a unit or deeper) is never removed whole and keeps its light
  files; heavy subtrees inside it can still be stripped. A cited heavy directory
  (for example a cited `node_modules`) is kept whole.
- A path ending in `*` cites everything with that prefix.
- Citing only a family root such as `.cache/qa` protects nothing.
- Paths that code reads as inputs are protected in full:
  `.cache/v2-spike/homes/g2-01-seam-smoke/cache/opencode/bin/rg` (the
  SHA-pinned `DEFAULT_RG` of `scripts/opencode-v2-native/artifacts.mjs`),
  `v2-validation/native-artifact*` reference artifacts, `quota-fixtures`,
  `perf/ledger-*`, `perf/multi-session`, `browser-upgrade/current`,
  `test-fixtures/verified-runtime` and `test-fixtures/foreign`. See
  `protectedInputs` in `scripts/storage-policy.mjs`.

A failed scan of the citations aborts the audit rather than guessing. Copy small,
sanitized proof into `docs/audits/<date>/` instead of relying on a `.cache` path.

## Budget

`--max-size <N>G` (default 50G) is a ceiling for `.cache`. The class rules run
first (scratch and unowned removal, heavy payload stripping). If the projected
size is still over, the preview reports the shortfall and names the flag that
would go further; by default nothing else is selected, so logs and JSON results
are never deleted to meet the budget.

`--evict-evidence` opts in: the oldest eligible run-evidence and session units
are then removed whole until the budget fits. Cited, pinned, protected, active
and failure-capped units are never evicted, and neither is a unit under 1 MiB
once stripped. Evictions are marked `budget eviction` in the preview. With
`--apply` and no manifest the flag is given on the same command; a manifest
records it.

## Coverage by family

| Family | Class | Owner | What the tool does |
|---|---|---|---|
| `qa/packaged-electron-*` | rebuildable | `scripts/qa/package-electron.mjs` | existing package rule: keep 2 newest, pins, references, donors; remove only the `.app` |
| `qa/*` (other) | run evidence | `scripts/qa/*.mjs` runners | strip heavy after 3 days |
| `v2-validation/*` | run evidence | `scripts/verify-opencode-v2-*.mjs`, `scripts/opencode-v2-native/*` | strip heavy after 3 days; journal fixtures are scratch; `native-artifact-*` keep newest 2 |
| `perf/*` | run evidence | `scripts/perf/*` | strip heavy after 3 days |
| `livetest/*`, `opencode-upgrade/*`, `release-*/*` | run evidence | live journeys, upgrade and release procedures | strip heavy after 3 days |
| `v2-spike/*`, `browser-upgrade/*`, `browser-inspect/*` | run evidence | reviewed inputs and browser inspection tests | strip heavy after 3 days; code-read inputs protected |
| `test-fixtures/*`, `wf/*`, `storage-tests/*`, `*/tmp` | scratch | tests and workflow scratch | remove after 24 hours |
| `sessions/<date>-<task>/` | session | agent sessions | strip heavy after 14 days |
| `worktrees/*`, nested worktrees | worktrees | `git worktree` | report only; suggest `git worktree remove` for clean branch checkouts and `git worktree prune` for missing ones |
| `shared/` | report only | `scripts/qa/profile-preparation.mjs` | shared reusable caches such as `shared/bun-install-cache`; never per-run deletion |
| `storage/` | report only | this tool | manifests and cleanup reports |
| `eslint/`, `typecheck/` | report only | package lint and type-check caches | listed |
| `plugin-upgrades/`, `session-execution/`, `windows-native/` | report only | build inputs | listed; never selected |
| loose `.cache/*.log` and anything unregistered | unowned | none | remove after 14 days unless cited or pinned |
| `packages/desktop/src-tauri/target/{release,debug/incremental}` | Cargo cache | Cargo/Tauri | remove if untouched for 14 days |

Producers write the metadata the tool relies on; add a new family to the
registry in `scripts/storage-policy.mjs` when adding a producer, otherwise it is
reported as unowned.

## QA package and Cargo retention policy

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
