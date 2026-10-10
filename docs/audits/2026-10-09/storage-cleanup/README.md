# Repository storage cleanup — 2026-10-09

Removed 14 merged local branch names, including 13 `archive/worktree-*`
branches and `docs/cleanup-2026-10`. Their commits remain reachable from
`main`. Git lists only the canonical checkout and the local `main` branch.

The repository storage utility successfully removed all 469 targets in its
reviewed manifest, including two superseded QA applications and old disposable
fixtures. The explicitly retired worktree-rescue cache contained 16 archived
fixture trees; it had no current source references, evidence citations, retention
pins or active process usage. That cache was removed after confinement and
identity checks. `.cache/worktrees` is empty.

The selected cleanup and archived cache totaled approximately **4.86 GiB of
allocated storage**. Volume free space increased from roughly 194 GiB to
198 GiB; APFS allocation and concurrent activity can affect this comparison.

All 76 pre-existing modified or untracked files matched their pre-cleanup
SHA-256 values. No installed-app data, dependencies, native donors, release
outputs, cited evidence or protected recent caches were removed. All cleanup
targets completed successfully, and `git diff --check` passed. Application tests
were not rerun for this storage-only operation.

## Additional old QA and test artifact retirement

At the user's request, a second review retired unused QA, validation,
benchmark and test artifacts older than 24 hours. This was a one-time cleanup;
the repository's default retention policy was not changed. The review retained
active and pinned runs, required native artifacts, the newest two outputs per
rebuildable group, the newest five failed runs per family, and cited files.
Cited directories kept their evidence while eligible uncited binaries were
stripped. Runs containing standalone source scripts were retained in full.

All **565 selected groups** completed successfully: 559 old run directories
were removed and six groups lost disposable binary payloads. In total, 671
paths and approximately **14.24 GiB of allocated storage** were removed.
The final cache report measured **30.64 GiB**, down from 44.88 GiB; available
volume space was 211.79 GiB.

Before this record was updated, all **78 pre-existing modified or untracked
files** matched their pre-cleanup SHA-256 values. All **89 retained folders
containing standalone source scripts** also matched their complete pre-cleanup
file-identity inventories. Every deleted target was verified absent, and no
cleanup failures or partial deletions remained. Installed-app state, production
data, dependencies, native donors and release outputs were outside the deletion
scope. Deleted disposable fixtures and binaries must be recreated before reuse;
application tests were not rerun.

## Remaining storage review and synthetic payload cleanup

A further review reduced repository cache usage from **30.64 GiB to
27.19 GiB**, removing another **3.45 GiB** across 130 verified paths.
The removed payloads belonged to 42 completed native benchmarks: synthetic
session stores (2.77 GiB), relocated synthetic projects and empty source seeds
(0.45 GiB). Four private QA homes marked `owned QA home` accounted for the
remaining 0.23 GiB. Their preparation script establishes that they are isolated
test homes; installed-app homes were not inspected or changed.

The benchmark runner explicitly classifies its bundles as disposable payloads,
and its fixture generator creates the synthetic projects. Every reviewed
benchmark reported completion, native process exit and no cleanup failures.
Each deletion rechecked repository confinement, Git-ignore status, citations,
required inputs, retention pins, process usage, file identity and the 24-hour
minimum age. Benchmark result files, scripts and source copies stayed intact.
This was a one-time reviewed retirement, not a change to the normal policy.

| Cache family | Before (GiB) | After (GiB) | Why the remaining contents stay |
| --- | ---: | ---: | --- |
| QA | 12.69 | 12.46 | Baselines, native donors, newest verified apps, scripts and evidence |
| Native validation | 5.82 | 5.82 | Required native reference artifacts, cited fixtures, scripts and recent runs |
| Performance | 1.88 | 1.88 | Required ledger fixtures and benchmark evidence |
| V2 spike | 1.74 | 1.74 | Reviewed inputs, required ripgrep input, scripts and retained database copies |
| OpenCode upgrade | 4.55 | 1.33 | Upgrade artifacts and benchmark results; synthetic payloads retired |
| Revert runtime companion | 1.01 | 1.01 | Runtime companion retained under the storage boundaries |
| Test fixtures | 0.74 | 0.74 | Cited or recent fixtures |
| Other | 2.21 | 2.21 | Recent startup/bundle investigations, release evidence, build inputs and caches with unresolved ownership |

The eight retained QA app executables total 10.80 GiB. Four are referenced by
QA or performance baseline configurations, three are native-module donors
(one also a baseline), and two are the newest verified builds. Their provenance
was checked by the existing storage utility. It reported no further eligible
deletions under the normal retention policy.

All 130 deleted paths were verified absent, and all removals succeeded. Before
updating this record, all 78 pre-existing changed/untracked files, all 264
standalone cached script files, and the file-identity inventories of four frozen
source copies matched their pre-cleanup snapshots. Only `main` remains as a
local branch and registered checkout. The final storage report showed
216.47 GiB of available volume space; APFS and concurrent activity affect
physical free-space comparisons.

`bun run cache:report`, `bun run docs:validate` and `git diff --check` passed.
Application tests were not rerun. Deleted synthetic fixtures need regeneration
before reuse; installed-app state, user source, dependency installations,
runtime companions, native donors and release outputs were preserved.
