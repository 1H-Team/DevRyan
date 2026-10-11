# Runtime and directory startup

## Scope

Directory session loading starts with the critical directory requests. Each
critical request captures its directory, retains transient retries, and has a
30-second total deadline. Failed preparation exposes Retry; retry and disposal
cancel obsolete bootstrap owners. Live status changes win over older snapshots.
Agent, LSP, and VCS enrichment follows readiness; questions and permissions can
recover while the first session page finishes.

Runtime preparation records verification, artifact retention, database checkpoint,
data copying, preparation, and selection separately. Service recovery records its
stopped-owner and acquisition steps. File hashes stream and supported filesystems
use copy-on-write with ordinary-copy fallback. Verification, checkpointing,
ownership, atomic publication, and rollback requirements are preserved.

## Reported Docker coincidence

Read-only installed startup metadata showed native OpenCode readiness at
13:24:39 on October 11, followed by `bot_runtime_docker_unavailable` at 13:24:40.
The later launch reached native readiness at 13:44:09 and reported a separate
Bot warmup failure. Selected revision 9's journal gap query returned no gaps.
These records do not establish Docker as the cause of the directory wait.

An executable desktop startup test holds Bot preparation unresolved, then rejects
it with `bot_runtime_docker_unavailable`: foreground execution continues immediately,
the background rejection is handled, and retry ownership clears. Existing Bot
tests cover the typed Docker-unavailable response. No installed state or running
Docker service was changed for verification.

## Verification

The focused directory suite passed 24 tests; desktop startup source contracts
passed 9 tests; startup benchmark contracts passed 18 tests. Build and startup
bundle budgets passed. Full deterministic validation passed, including 4,103 UI
tests, 6,582 web tests, and 14 additional native contract tests. Follow-up focused
checks cover the final failure-display and Docker test additions.

The candidate includes a concurrent user edit removing the session-opening label.
That edit is preserved and explicitly included in the source comparison receipt.
The final candidate also preserves the concurrent recovered-input archive fix;
its operation handlers are outside startup. These source differences are listed
explicitly in the comparison receipt rather than attributed to this task.

## Matched measurements

[Final evidence](comparison-final.json) records three sequential baseline/candidate
pairs in B1, C1, C2, B2, B3, C3 order, using the same native artifacts and local
provider fixture. Each first launch upgrades a distinct, compatible same-version
artifact, then creates 200 synthetic sessions and reopens in a new process.
Readiness requires the expected available model, enabled visible composer,
New Chat control, and acknowledged live event stream. No forced navigation is used.

| Measurement | Baseline median (range) | Candidate median (range) |
| --- | --- | --- |
| Upgrade launch, usable chat | 37.941 s (37.137–38.438) | 36.645 s (36.526–39.117) |
| Unchanged reopen, usable chat | 11.245 s (9.756–11.281) | 9.482 s (9.424–9.672) |
| Bundle upgrade phase | 18.073 s (17.568–18.526) | 17.782 s (17.558–17.843) |

Reopening improved 15.68% at the median and in all three pairs, passing the
existing benchmark gate (at least 5% median improvement and every pair faster).
Upgrade-launch median improved 3.42%, but one pair was slower and the stricter
gate **did not pass**. The bundle-upgrade median improved only 1.61%; there is
no strong claim of faster first launch after every update. Native configuration
and import variation remain material, and this small cohort does not establish
population-level significance. The retained implementation improves the targeted
phase and total medians while keeping hashes bounded to 1 MiB per read.

Candidate nested phase medians: artifact retention 3.545 s, bundle preparation
7.985 s, selection 2.958 s, database checkpoint 1.87 ms, and fixture data copying
5.79 ms. Native configuration took 9.408 s versus 9.905 s baseline. Nested spans
must not be added to their parents. Synthetic fixture data is much smaller than
an established user's profile; no installed database was copied or benchmarked.

Every completed final trial passed journal-gap, renderer-exception, model,
session-list, selection-transition, and process-cleanup checks. Every unchanged
reopen preserved its bundle/revision and emitted no upgrade/copy phase. The first
50 sessions were loaded from all 200-session profiles. [Reopen screenshot](reopen.png)
shows the inspected synthetic history and available composer/model.

## Rejected trials and harness correction

The [first comparison](comparison-first.json), using default streaming buffers,
passed correctness but failed both performance gates. Bundle upgrade regressed
from 18.114 s to 19.729 s at the median. The final implementation uses explicit
1 MiB buffers; its focused artifact/bundle suite passed 75 tests.

Two subsequent comparisons stopped on [baseline catalog probe failures](baseline-failure.json)
(HTTP 500 and 503). Their partial cohorts are not used in the final comparison.
The one-shot catalog probe was replaced with a ten-second bounded readiness wait
through 5xx warmup. Every response code and elapsed time is retained, all waiting
counts toward usable-chat time, and catalog/model/stream assertions remain in force.
The final B1 recorded 503 followed by 200 about 121 ms later. Persistent failure
still fails; authorization failures fail immediately. The updated benchmark suites
passed 48 tests. All final samples use the same revised measurement rule.

## Limits

These are macOS arm64 private-profile measurements, with a local provider and
background Bots disabled by the existing QA host. Real Docker-stopped behavior
is covered by the executable nonblocking-startup contract, not a live Docker
shutdown. Signing, release installation, Windows/Linux performance, real providers,
and installed-app upgrade behavior were not verified. No release or installed-app
replacement was performed.

## Cleanup

Sanitized evidence is retained here (about 284 KiB). All 29 task-owned package
and comparison directories and the two failed runtime fixtures were removed.
No worktree was created. Cache report and prune preview passed; the unrelated
3.49 GiB suggested by the preview was not deleted. Final free disk space was
182 GiB. Source whitespace, documentation links, and bundle budgets passed.
