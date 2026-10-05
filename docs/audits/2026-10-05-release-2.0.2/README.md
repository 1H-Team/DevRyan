# DevRyan 2.0.2 implementation and qualification

Status: implementation in progress. macOS 2.0.2 has not been qualified or
published. Windows follows after both architecture-specific safety inventories
and installer qualification pass. Passing focused tests below does not satisfy
the final release gates.

## Recovery and integration

Claude's DevRyan auto-continue was disabled through its native UI. The UI showed
148 completed commands and two stopped commands, with no running commands.
Every available worktree was stable during preservation. Git refs, staged and
unstaged patches, and all non-ignored changed/untracked files were preserved in
`.cache/release-2.0.2-recovery`; the verified Git bundle contains all refs.
Original worktrees and evidence remain in place. No stash was applied.

The release branch started at `1b3e7c3d`. Integration preserved the shared
`recordSessionExecution` commit and followed the approved order:

| Group | Result on the integrated branch |
| --- | --- |
| Inputs | 141 focused Vitest tests passed |
| Storage sweeps | Owner/source/artifact tests passed; final affected source, artifact and bundle checks: 74 passed |
| Held lifecycle | 26 server and 5 mounted UI tests passed |
| UX recovery | 68 Electron and 70 server tests passed |
| Skill names | UI, native reviewed-skill, projection, notification and duplicate-live checks passed |
| Superpowers retirement | 251 server tests plus UI, reviewed setup and performance profile contracts passed |
| Durable fixture journals | 17 tests passed |
| Bot image reuse | 19 tests passed, zero skips |

The codemap conflict was resolved by preserving both stale pinned seed and
half-deleted 2.0.0 recovery contracts. Other overlapping files merged cleanly.
The uncommitted performance draft was applied with Git's three-way merge;
its original worktree and all 23 changed/untracked files remain preserved.

Initial test-runner mistakes are retained in the evidence directory. Vitest
files require the Vitest runner, and migration fixtures require the web package
working directory. Corrected focused runs passed. Those failed invocations are
not release evidence.

## Additional engineering and reproduced findings

The constructor checkpoint grant now reserves before asynchronous selector
reads, rechecks selection after settlement, exposes only a frozen held scope,
and revokes after failed settlement. Scope identity expires per action, so a
closure retained from an earlier action cannot revive during another hold.
The expiry flaw was independently reproduced against the `1b3e7c3d` review
snapshot. Grant and lifecycle checks passed, including the genuine drain order,
concurrency, refusal, and revocation cases. No HTTP or Electron grant was added.

Timing instrumentation records bounded content-free native request marks,
ledger waits and hold times, bridge calls, first output, and first text.
Diagnostic routes require permission and session ownership. Foreign assistant
message IDs cannot mutate another session's timings. Native response frames
must match observed requests. Focused timing and harness checks passed;
loopback baselines and optimization qualification remain pending.

Five shutdown failures were reproduced with the preserved review fixtures:
finite credential refusals killed the controller, and queued enrollment/provider
cleanup deadlocked while a mutation awaited full owner exit. Correlated native
replies and non-dispatched commands now retain their controller. Uncertain
operations wait for verified process termination before allowing dependent
owner cleanup to finish. Full-cleanup exit semantics remain intact.
Process/integration checks passed. Crashed provider worker recovery also passed,
including refusal to replace a worker with unconfirmed termination.

Packaged prompt maintenance now has host-admin typed status and explicit restore
operations plus a visible conflict notice in Runtime settings. Status is read-only
even with a matching manifest fast path. Restoration checks the inspected hash,
backs up the observed file, rejects linked targets and racing replacements, and
queues the existing configuration-apply owner. The 52 focused server checks,
mounted restore UI, packaged planning/execution guidance contracts, web/UI type
checks and documentation validation passed. Final packaged qualification is pending.

The DMG updater now verifies release identity, architecture, size and SHA-256,
resumes interrupted downloads, performs preflight before drain, and binds a
durable installation intent to file and process identities. The standalone
installer uses the compiled macOS bridge for exclusive rename and atomic app
exchange; startup acknowledgement retains the previous app, and rollback
requires proven candidate cleanup and exit. Download, installer state-machine,
owned drain, and startup checks passed, including the compiled native bridge.
The installer bundle is self-contained and its digest is recorded with bundle
inputs. Disposable packaged DMG launches and interrupted-helper recovery remain
unqualified; no update of the user's installation was attempted.

Release preparation now resolves the eight Bot image inputs once. Manifest
assembly permits packaging and isolated topology qualification to run
independently, while publication still requires both. Dry-run guards cover
release/tag/upload, registry/image-tag, npm, database and notification writes;
Bot core functions also refuse publication and tagging. Assets must match their
packaging SHA-256, uploaded state, size and exact shared scope allowlist. The
preserved `r22-b6` verifier supplied the digest checks. Focused release tests
passed without registry access. Windows x64/ARM64 CI is configured with pinned
native tools and read permissions; actual Windows runs and contracts are pending.

## Final evidence table

This table must be rebound to the final source commit, lock hash, native build
identity, image manifest identity, packaging digests, and installed artifacts
before it can authorize publication. Current evidence is interim engineering
evidence in `.cache/release-2.0.2-recovery`.

| Mandatory gate | Status | Evidence or prerequisite |
| --- | --- | --- |
| Full integrated validation, build, bundle budgets and documentation | Not run | Engineering is still changing |
| Packaged prompt conflict notice and explicit restore | Passed (focused); packaged not run | API, mounted UI, stale revision, edit/path replacement and guidance checks |
| Tracked credential owner and synthetic rehearsal | Not run | Genuine checkpoint grant implemented; QA composition pending |
| Complete B1 review closure | Not run | Recovered reproductions being consolidated |
| Compiled acceptance and seeded-credential boot | Not run | Final native artifacts pending |
| Three meaningful durable journal roots and verified gaps | Not run | Journal fixture/grading code integrated |
| Seven lifecycle modes and seven wire cells | Not run | Final identities pending |
| Two actual-runtime UI cells and reviewed screenshots | Not run | Final runtime pending |
| CLI persistence/refusal and Electron Resume | Not run | Final runtime pending |
| Shipped 2.0.1 → candidate → 2.0.1 continuity | Not run | Actual artifact qualification pending |
| Packaged first launch and service mode | Not run | Candidate package pending |
| DMG update success/refusal/interruption/rollback | Passed (focused); packaged not run | Verified downloads, native app exchange, startup acknowledgement and guarded rollback; disposable package and interrupted-helper qualification pending |
| Exact provider/role graph, 12 journeys, 16 compaction boundaries | Not run | Owner sign-in window after credential-free rehearsal |
| Managed-user verification | Unavailable | Non-production Supabase environment not supplied |
| Cold/warm loopback and full performance audit | Not run | Timing instrumentation and reproducible baselines pending |
| Burst, six attribution, 21 calibration, conditional 42 paired launches | Not run | Quiet window and frozen grading pending; retain 750 ms |
| Release dry-run with no external writes and exact asset digests | Passed (focused); CI not run | Fake-registry refusal/reuse tests, workflow writer guards and packaging-digest verification; actual signed images and frozen package pending |
| Downloaded DMG digest, mounted app, isolated launch and updater | Not run | Publication requires all preceding mandatory gates |
| Windows x64 / ARM64 native safety and installers | Not run | [Port plan](../../WINDOWS_PORT_PLAN.md); native Windows runners required |

macOS remains ad-hoc signed. Windows packaging is unsigned. No notarization,
Authenticode, live provider, or Windows runtime pass is claimed. Verification
must keep the user's installed app, running runtime, Docker Engine, and data
untouched. Provider sign-ins remain owner actions. Trash cleanup requires
approval of exact paths and sizes; no user data or Superpowers folder has moved.
