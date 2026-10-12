# DevRyanv2.0.8 replacement preflight

The authorized replacement combines the original v2.0.8 changes, its historical
verification record, and the pending startup contract into one `release v2.0.8`
commit based on v2.0.7. The public desktop inventory remains exactly
`DevRyan-2.0.8-arm64.dmg`. No uncommitted hosted or local database migrations
were present; publication must still apply pending hosted migrations and verify
history parity and the Bot schema marker through the existing release gate.

Workspace lint, type checks, documentation validation, production build, startup
bundle budgets, and whitespace checks passed. The first `validate:full` attempt
stopped in the harness package: concurrent background packing returned
`capture_git_failed`, with 705 tests passing and one failing. The focused test
passed unchanged, and the complete harness rerun passed all 706 tests. No
assertion or production code was changed to suppress that failure.

All package suites before the failure passed. The harness rerun and every
remaining suite then passed: orchestration, Cursor SDK, Electron, legacy Tauri,
UI (4,117 tests), and web (6,689 Vitest tests plus 14 Bun native checks). This
completes full validation coverage by resuming after the recorded failure;
the original `validate:full` invocation itself exited nonzero.

The first fresh-checkout startup-contract CI run failed because the runtime-bundle
fixture assumed `.cache/v2-validation` already existed. The shared fixture now
creates its parent before `mkdtemp`; the release attempt was cancelled before
publication so its source could include that correction. Production code and
test assertions are unchanged. `bun run test:startup` passed after the correction,
including all 148 web startup tests; documentation validation passed again.

The second Ubuntu startup run exposed a snapshot recovery failure and a lock
fixture's assumption that PID 1 always predates a timestamp eleven minutes old.
The lock fixture now advances the clock after creating both live-owner locks.
Startup CI uses the release's macOS ARM64 runner, exercising the same suite and
the native artifact checks that Ubuntu skipped. The second release attempt was
cancelled before publication. The Ubuntu snapshot failure remains recorded;
macOS release qualification does not establish a Linux runtime pass.

The first macOS startup CI run passed 145 tests and hit Vitest's default
five-second timeout in three Git/SQLite fixtures. The runtime-bundle fixture
suite now allows 30 seconds per test, retaining its explicit lifecycle timing
assertions and existing longer recovery limits. No release performance or
publication gate was relaxed.

[Release run 38236327796](https://github.com/1H-Team/DevRyan/actions/runs/38236327796)
built and uploaded the DMG but refused publication before migration deployment.
Its [failed startup receipt](startup-failure.json) passed GUI prerequisites and
artifact integrity, then reported a compiled acceptance failure without detail.
The receipt now preserves bounded, sanitized acceptance outcomes and case IDs.

The downloaded exact native artifact reproduced a source-input failure under
the ordinary host-only install. Matching native preparation's frozen all-CPU
Darwin install passed all 4,710 source-input hashes. The Bun-run harness then
failed its lifecycle child; the documented compiled qualification uses Node.
CI now restores the same dependency layout and reviewed Claude executable as
preparation, and uses Node without relaxing signature or input-hash checks.

The [first aligned Node acceptance attempt](compiled-attempt.json) passed 50 cases, then its parent-death
probe reached the existing two-minute setup deadline while full validation also
ran. Candidate and baseline journal gap checks each returned zero; cleanup had
no reported failure. This is a failed attempt, not compiled qualification.
The deadline remains unchanged, and final native acceptance must run separately
from the full deterministic suites.

After the qualifier setup and diagnostic corrections, `bun run validate:full`
passed end to end, including all package suites, 4,117 UI tests, 6,689 web tests
and 14 final native backend checks. The fresh macOS startup-contract CI also
passed. Original failures remain recorded above; final installer qualification
and migration deployment still require the frozen release workflow.

The separate native retry passed all 52 cases and all three durable journal
checks, with zero cleanup failures or source changes. Six task-owned retry
directories and the downloaded debug artifact were removed.

[Run 38243442083](https://github.com/1H-Team/DevRyan/actions/runs/38243442083)
built the DMG but failed before qualification began: Node exited 13 because the
benchmark CLI's top-level dynamic import formed a cycle with the release runner.
The CLI now lets its helper exports finish before loading that runner, catches
CLI failures with a deterministic nonzero exit, and has a subprocess regression
in the startup-contract CI suite. The regression first reproduced exit 13.
All 19 benchmark tests, release wiring/diagnostic tests and the complete startup
contract suite passed after the CLI correction; documentation validation passed.

[Run 38246883684](https://github.com/1H-Team/DevRyan/actions/runs/38246883684)
passed GUI prerequisites and eight compiled cases, then its Node 22 lifecycle
child failed. The local 52-case pass used Node 26, not Node 24. Qualification
now pins Node 24.14.1 to match [Electron 41.2.1's embedded host](https://releases.electronjs.org/release/v41.2.1).
The repository-bundled Node 24.19.0 is used for a separate local comparison;
it does not replace exact-host qualification in CI.
The local comparison refused the older workspace artifact's reviewed Claude
asset before any case; that artifact was not modified or treated as passing.
All 33 focused entrypoint, diagnostic and workflow tests passed under Node 24.
Lifecycle children now emit a bounded fatal cause before encoded-module traces,
and their caller propagates that cause into the sanitized qualification receipt.

Cache reporting and cleanup preview passed without applying bulk deletions.

[Run 38251966042](https://github.com/1H-Team/DevRyan/actions/runs/38251966042)
identified `native_process_boot_timeout` after eight compiled checks. The exact
prepared artifact and final DMG each passed all 52 compiled checks locally under
Node 24.19.0; the unchanged final DMG also passed all 52 under the exact Node
24.14.1 host. All three comparisons had clean durable journals, no cleanup
failures and no source changes. This did not qualify the failed CI run.

The disposable [CI journal diagnostic](https://github.com/1H-Team/DevRyan/actions/runs/38256785741)
showed repeated `execution.native.helper` calls consuming 2–3 seconds each;
the baseline journal gap check was clean and the candidate had not started.
The [confined command comparison](https://github.com/1H-Team/DevRyan/actions/runs/38257646492)
isolated Apple's `/usr/bin/git` shim: three calls took 4,058, 3,814 and 3,933 ms,
while the selected Xcode Git took 77, 72 and 56 ms under the same confinement.
Native helper hosts now resolve the Apple shim once before their confined calls.
No timeout, supervisor, directory restriction or termination assertion was relaxed.
Focused tests with the repository's pinned Vitest passed all 56 checks, including
failed selection, retry, concurrent reuse and preserved confinement.

Full validation passed after the Git helper correction (4,117 UI tests, 6,692 web
tests and 14 native backend checks). [Run 38259000511](https://github.com/1H-Team/DevRyan/actions/runs/38259000511)
then passed baseline startup and cloning but stopped at the next fixture input:
qualification still referenced ripgrep from an old local `.cache/v2-spike` run.
The fixture now uses the existing locked Cursor SDK 1.0.28 Darwin ARM64 binary
(ripgrep 14.1.1-cursor3), with its exact SHA-256 checked. A fresh-install contract
test binds that input to the workspace's pinned SDK version and executable bytes.
No dependency was added and the failed release was not published.
The corrected fixture and both isolated Cursor transport checks passed; the full
startup contract command, production build and bundle budget checks also passed.

Final-DMG startup, signed-image, topology, packaged-artifact, migration and
publication checks remain CI gates. The historical original v2.0.8 receipts
cannot qualify the replacement. macOS is ad-hoc signed and unnotarized.
Existing v2.0.8 installations require manual reinstall because the updater
only admits a strictly newer version.
