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
First output and first answer text now have distinct typed marks; the historical
text/reasoning mark retains its meaning. The existing benchmark retains its
three warmup receipts and feeds real provider, bridge, ledger and projected
output observations to the production journal, sealed during cleanup. Focused
timing checks pass (25), as do journal/collector checks (26, zero skips), web
types and documentation checks. Final performance qualification remains pending.
The first compiled timing probe exposed late native idle settling a newer send.
That race was reproduced independently before the fix. Native projected idle
now carries its actual inbox identity; timing settlement cannot clear another
turn. The collector preserves its canonical completion clock and waits for the
exact stream settlement before collecting timing snapshots. The corrected
one-stream and eight-call diagnostic retained all ten sets of provider, bridge,
ledger, first-output and first-answer-text marks. Both sealed journals reconcile
to their accepted counts (133 and 558); original gap commands exited zero with
zero gaps. An initial ad hoc journal grade remains failed because it requested
an error-only client diagnostic from healthy turns. This diagnostic does not
replace the required three compiled acceptance roots or performance calibration.
The original incomplete probe is retained. Timing, projector and native-provider
checks pass (99); journal/collector/Windows workflow contracts pass (27).

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
inputs. Interrupted helper recovery now covers the atomic exchange, backup naming,
rollback decision and failed-copy naming. Reopening binds a replacement helper
and exits before pre-launch recovery; a lost launch is not replayed. Both app
code hashes and the copied installer are pinned, including startup and final
cleanup verification. Focused checks include actual killed subprocesses and the
compiled macOS exchange bridge. Disposable packaged DMG launches remain
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

Enrollment review findings reproduced on the original review snapshot and the
integrated branch. A durable fingerprint-only intent now precedes the exclusive
vendor credential write; a matching pending enrollment can be settled by a fresh
authorized selection without replaying the issuer. Abandoned live starts remove
only their own empty directories, non-private roots refuse before issuer work,
and damaged enrollment directories no longer hide healthy rows. The lost-begin
renewal acknowledgement was also reproduced: only the exact owner's proved
undispatched attempt is cancelled, and new enrollment reserves space for its
complete renewal intent. Enrollment/lifecycle/provider-route checks passed (116),
as did the synthetic renewal checks and web type checks. Evidence grading now
reads and verifies the actual log descriptor instead of trusting caller-supplied
empty bytes; all 13 gap/tee/evidence checks passed. Other B1 scopes remain open.

Tracked live ownership now uses a fresh attended host, one constructor-retained
grant, an in-memory one-use local-owner link and an explicit nonsecret setup
mirror. Held native snapshots/digests stay private; candidate projection uses
the existing native CAS. Claude access-only acceptance reads the independent
login service through a readonly owner and cannot refresh, write or enroll.
The matrix retains the exact saved graph and scopes each candidate's binding.
Teardown checks listeners, inputs and parent-observed PID/start identities;
retained runtime state stays outside evidence and prevents publication.

The compiled synthetic rehearsal passed at native build ID
`722fa725e3cb11c3fe797a7c7bb06fc3ac6506e7f68b894935bf867df35362c0`
(manifest SHA-256
`96142e55386afeef5e82985395736cb1ae8233722897c7262d9757312fed9e53`).
It uses original source SDK OAuth grants, actual compiled key mutations and
activation, genuine source/candidate holds, exact private Credential.Info
fingerprints, candidate readiness, owned cleanup and zero evidence leaks.
Its evidence is `.cache/v2-validation/live-owner-rehearsal-qDlZSr/evidence`;
23 constructor/mirror/input tests and 134 provider/coordinator/facade tests passed.
No paid inference, external Cursor model discovery, packaged Electron or
managed-user qualification is claimed. Failed rehearsals and their zero-gap
runtime journals remain preserved. They reproduced an outer HTTP credential
queue deadlock and a Cursor key save incorrectly owned by legacy `auth.json`.
Native commits now own the complete queue span, and Cursor keys use the native
facade. Two later rehearsal assertions were corrected to respect sanitized
evidence and the separate external Cursor catalog.

Recovery review independently reproduced a committed upgrade whose caller
aborted before settlement, serialized Electron recovery codes being lost,
broken selector imports exiting before a recovery window, and CLI `-q`/root
resolution inconsistencies. A committed transition now recomposes once after
completion or disconnect. Recovery displays only finite original IPC codes;
broken selectors hold owners and settings, while service probes remain readable.
CLI, shell and provisioning share validated root resolution. Startup releases
only exact temporary holds belonging to the verified bundle or its immediate
checkpoint source, then retries persisted wakes through existing permits and
revision-bound acknowledgements. Durable and foreign fences remain intact.
The combined server checks passed (81), ledger/admission checks passed (53),
Electron package checks passed, and web type checks passed. Original failed
review fixtures are preserved. Compiled journal grading rejects empty roots and
uses verified chunk scans, including stale zero-gap manifests; historical gap
command acceptance is not meaningful root qualification.

The integrated full validation was attempted. The first attempt exposed a stale
release-workflow assertion; its normalized dry-run contract now passes. The
second reached Electron after passing lint, types and preceding deterministic
suites, then failed an extracted startup fixture missing the new binding-error
state. The fixture and focused Electron suite are corrected. Full validation
must be rerun against the frozen candidate; neither attempt is a full pass.
A following interim run passed lint/types and 1,182 script checks, then correctly
refused native test skip declarations. The native inventory is now an explicit
macOS acceptance gate; all portable assertions remain in deterministic discovery.
Runner/discovery, installer and actual native checks pass (59 focused checks).
The original failed run remains recorded; this is not a full validation pass.

The next integrated attempt reached the harness suite, with two fixture
isolation failures and a teardown error: repository-local non-Git fixtures
discovered the enclosing DevRyan checkout. Both unchanged assertions pass when
the fixture's canonical `TMPDIR` is also its `GIT_CEILING_DIRECTORIES` (2 checks).
The full gate must be rerun with this isolation; the failed attempt is retained
as `integrated-full-validation-native-gate.log`.

Further B1 reproduction found that a full Claude lifecycle dispatched the issuer
before refusing capacity. Count, byte and complete renewal capacity now precede
the sign-in URL and are rechecked before dispatch; existing accounts and
unresolved fingerprints remain intact. The 64-account/128-unresolved safety
ceilings retain no automatic eviction or credential retirement. Historical
empty directories left by a crashed owner remain outside automatic cleanup.
The enrollment page also rejected the backend's incomplete/unavailable rows,
hiding healthy peers. It now preserves those rows and offers an explicit
Recover and Use action without replaying sign-in. Original-factory server checks
pass (124); mounted enrollment checks pass (5), as do existing skill
running/completed/history/permission presentation checks (11). These are focused
checks; live enrollment, native notifications and final packaged cells remain
unqualified.

## Final evidence table

The isolated full validation at `3f344f87` passed lint, type checks,
documentation, the harness suite and all 4,048 UI checks. The web suite passed
6,321 checks and failed one production JSON-parser coverage check: packaged
prompt restoration had relied on a parser present only in its focused fixture.
The restore route now owns a 4 KiB JSON parser. Its fixture omits the global
parser and checks oversized refusal before mutation; both focused route and
parser-coverage files pass (21 checks). The full failed log remains
`integrated-full-validation-isolated.log`; later suites were not run by that
attempt. Final integrated validation is still required.

This table must be rebound to the final source commit, lock hash, native build
identity, image manifest identity, packaging digests, and installed artifacts
before it can authorize publication. Current evidence is interim engineering
evidence in `.cache/release-2.0.2-recovery`.

| Mandatory gate | Status | Evidence or prerequisite |
| --- | --- | --- |
| Full integrated validation, build, bundle budgets and documentation | Failed (interim); final not run | Interim validation failures corrected with focused checks; engineering is still changing |
| Packaged prompt conflict notice and explicit restore | Passed (focused); packaged not run | API, mounted UI, stale revision, edit/path replacement and guidance checks |
| Tracked credential owner and synthetic rehearsal | Passed (compiled synthetic); live not run | Original SDK OAuth, compiled native key/CAS owners, held projection, ready boot and zero evidence leaks; final identities and attended live/launcher qualification pending |
| Complete B1 review closure | In progress | Checkpoint, shutdown, enrollment and renewal findings reproduced and corrected; remaining scopes being consolidated |
| Compiled acceptance and seeded-credential boot | Not run | Final native artifacts pending |
| Three meaningful durable journal roots and verified gaps | Not run | Journal fixture/grading code integrated |
| Seven lifecycle modes and seven wire cells | Not run | Final identities pending |
| Two actual-runtime UI cells and reviewed screenshots | Not run | Final runtime pending |
| CLI persistence/refusal and Electron Resume | Not run | Final runtime pending |
| Shipped 2.0.1 → candidate → 2.0.1 continuity | Not run | Actual artifact qualification pending |
| Packaged first launch and service mode | Not run | Candidate package pending |
| DMG update success/refusal/interruption/rollback | Passed (focused); packaged not run | Verified downloads, native app exchange, startup acknowledgement and guarded rollback; killed-helper/native exchange checks pass; disposable package qualification pending |
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
