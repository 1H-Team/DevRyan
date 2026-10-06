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
final loopback qualification remains pending.
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

Three baseline and three candidate engineering repetitions retain cold and
warm turns for both workloads, with stable per-cohort source identities and
successful cleanup. A candidate reused bridge connections and avoided unchanged
registration locks; its auth/cancellation tests (6), ledger/admission tests (71)
and web types passed. Its median gains (92 ms for one stream, 365 ms for eight
calls) did not exceed baseline launch variation (101 ms and 1,947 ms). The
optimizations were therefore removed from the implementation; their exact patch,
receipts, artifact identities and inconclusive decision remain preserved in
`.cache/release-2.0.2-recovery/performance-optimization-decision.json` and
`performance-unqualified-candidate.patch`. These runs were not quiet-window
calibration or matched source/environment paired qualification. The full
performance audit and frozen protocol remain outstanding; the interval is 750 ms.

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
passed without registry access. Windows x64/ARM64 CI uses pinned native tools
and read permissions.
The release branch was pushed to the canonical repository. Draft PR creation
was refused by the API token's permissions. Native CI now runs on scoped pushes
to this release branch, without requiring a PR or browser sign-in. The first
[run](https://github.com/1H-Team/DevRyan/actions/runs/37349064957), at
`7e328f87690f9b01d0603d302a95a724aae31ef7`, compiled both supervisors and failed
both safety inventories. Retained x64/ARM64 supervisor SHA-256 values are
`409bec7afc6435bfb0c90cd15aa79f46fce34e0cdd2ad569ed570fbff008f5ae` and
`6f3adde9ac0b3af8513ba9a62824792744b62bb22325210d97f94f0f1896a073`.
The missing token adjustment right is corrected; POSIX-only test assumptions,
native filesystem/read confinement and the Darwin-only controller/writer builder
remain open. The draft assigns its Job Object atomically during process creation;
actual abrupt-death qualification is still not run. Core execution remains held.

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
empty bytes; all 13 gap/tee/evidence checks passed. Remaining B1 scopes are
consolidated below.

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

## Consolidated B1 engineering review

| Scope | Reproduced findings and current focused evidence |
| --- | --- |
| Credentials and enrollment | Durable issuer/write intent, lost acknowledgement, private directory refusal and capacity-before-issuer corrections; 116 then 124 server checks, 5 mounted UI checks and the compiled synthetic owner rehearsal |
| Worker shutdown | Five preserved failure reproductions; finite refusals retain controllers, reverse actions settle outside recursive queues, active/retired credential requests retain their 64-request bound, and physical exit precedes dependent cleanup |
| Recovery | Disconnect after committed update, finite IPC codes, invalid selector startup, CLI quiet/root handling, original checkpoint and source-owner checks; 81 server and 53 ledger/admission checks |
| Capabilities and admission | Unsupported Anthropic refuses before worker/authorization while another provider remains usable; original readonly inspection cannot settle renewal; both rebound preserved fixtures pass; input and eight fix-group checks remain integrated |
| Credential composition | Frozen constructor-only grant, selector CAS before/after settlement, per-action authority expiry and revocation after failed settlement; genuine drain/exit ordering and compiled in-memory projection checks |
| Drift | Current comparison records 254 modified historical files, five intentional removals and no changed file types or restored v1 routes. The user's status-dot change is preserved. Updater metadata and Superpowers removals are intentional. Hydrated Claude bytes are present; new artifacts must use fresh source identities |
| Evidence grading | Opened log identity/bytes, raw hash attribution, expected cancellation joins, exact accepted tee and nonempty compiled roots; 13 focused gap/tee checks pass, while the failed ad hoc error-only grade remains recorded |

Original review fixtures, failed reproductions and corrected runs remain under
`.cache/release-2.0.2-recovery`. The current drift comparison is
`b1-final-drift.json`; it invalidates historical qualification for changed source.
This consolidates engineering review, not live or packaged acceptance. Native
notifications, actual UI cells, managed-user checks and final compiled evidence
remain in their qualification gates below.

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

At `9d52371b`, another full run passed lint/types and the preceding deterministic
suites, then passed 663 harness checks and reached the framework's five-second
cutoff in a durable shell-wake integration case. Teardown removed its fixture
while Git was still reading it, producing a secondary `capture_not_git` error.
The unchanged isolated case passed in 2.5 seconds. Its runner budget is now a
bounded 20 seconds; all 34 checks in that file pass with the original authority,
receipt and replay assertions. The failed full log is
`integrated-full-validation-current.log`. UI and later suites were not run.

Version metadata is now 2.0.2, including all 15 locked workspace versions.
Resolved dependency tuples and dependency pins are unchanged. Release notes
and version/release contracts pass (11 checks); final source and artifact
identities must be recorded after this candidate is committed and built.

The frozen `fc5f750e` attempt built the web/Electron bundles and passed startup
bundle budgets. Native build ID was
`ba89b95731b464fca77bfa62be72570a18c0890d23fc72a15f44ecff58ad7d7b`,
with manifest SHA-256
`185746157c1ac56cdc60bdc7dfcaa1c7ecfb542f1a734a63dcad3b6baebc83e2`.
Full validation passed 663 harness tests but another durable shell-intent case
reached the runner's five-second timeout; the secondary Git failure followed
fixture teardown. Its unchanged isolated case passed in 2.94 seconds. The case
now uses a bounded 20-second runner budget and all 34 file checks pass; authority,
receipt and replay assertions are unchanged. The full failed log is retained as
`frozen-full-validation-1.log` and must be rerun after the service correction.

Compiled acceptance passed 15 cases before the human-queue fixture's 60-second
budget expired while another full validation was running. Its controller exited
physically and cleanup passed. The actual fixture journal has zero verified gaps;
this does not satisfy the three meaningful-root inventory, which was not reached.
Original result `.cache/v2-validation/package-D1pvRP/result.json` and journal
inspection remain preserved. Rerun acceptance alone before changing any deadline.

The frozen Stage F attempt refused all seven wire cells because the invocation
omitted `QA_NATIVE_ARTIFACT_ROOT`. The packaged Electron actual-backend cell
passed send/reload/cancel/reconnect and native read/write publication. The first
web cell lost its light theme at final screenshot grading; an unchanged independent
web repeat passed. Both grades remain retained, and screenshots still require
review. None of these results is rebound to later changed source.

Service review independently reproduced `prepareStartup` invoking the runtime
preparer with background Bots disabled. The shared runtime now returns
`bots_background_disabled` before runtime, catalog or Docker preparation;
19 focused checks pass. A new direct packaged service fixture covers private
owner/descriptor identity, unauthenticated refusal, no model sends before a
desktop lease, physical drain and restart. Its actual launch passed at
`bf2aa44a`: `.cache/qa/packaged-service-sDdrk8/evidence.json` records two
headless service starts, original process identities, private descriptor modes,
401 refusals, zero model sends, physical exit, lock removal and a new restart
instance. Cleanup has no errors. This direct service check does not register
launchd or qualify an authenticated desktop lease or live providers.

The corrected `bf2aa44a` cohort passed `validate:full` alone: UI 4,048 checks,
web Vitest 6,325 checks and web Bun 11 checks, with workspace lint, types and
deterministic suites. `build`, `bundle:check` and `docs:validate` also passed.
Logs are `service-correction-full-validation-2.log`,
`service-correction-build-2.log`, `service-correction-bundle-check-2.log` and
`service-correction-docs-1.log` in the recovery directory. Lock SHA-256 is
`30d8bb422ea2ab4e2ff27a31ec3591ca0f032887f334034ffa651ba216a9a247`.
Packaged source SHA-256 is
`741dfbcc801d879a65b7576194492e7dd57ac2ea40846835112e1befa1782269`,
runner SHA-256 is
`3aaf96d9ea6eb31ed7c6159745a8ffcf4f80746a444a83b07217829b6b9928a5`,
and QA archive SHA-256 is
`b096d6e5b90fb2ec1a447260f2c30d55974cb535045960e02635cf677e320732`.

Compiled acceptance alone passed 108 cases, including the earlier human queue,
all 23 retained skills and actual Electron browser publication, then failed
`compiled-document-docx-read` at its original 60-second continuation deadline.
Result `.cache/v2-validation/package-esr1QY/result.json` retains unchanged
source identities, clean physical controller exit and no cleanup errors. The
correlated document session has zero verified journal gaps. Its actual tool
completed; the following image-context worker did not publish before the
continuation deadline. An independent fresh compiled document diagnostic
passed all six document checks in 9.6–14.0 seconds with the same tool, HTTP,
publication and 60-second assertions. Its result is
`.cache/v2-validation/package-kV5sMR/result.json`; its journal gap check passed.
A second diagnostic first settled 300 genuine ledger operations, then passed
the same six document checks in 7.5–10.5 seconds with zero verified journal gaps
and clean owned-process drain. Result `package-hJlzxd/result.json` remains under
`.cache/v2-validation`. Ledger age alone did not reproduce the continuation
failure; no optimization or deadline change followed. Neither diagnostic
satisfies the complete acceptance, seeded boot or three meaningful-root gates.

A fresh full run passed 119 cases, including DOCX, then exposed a verifier
ownership error before seeded boot. The seeded fixture supplied its legacy
source checkpoint when selection requested the newly prepared bundle's own
checkpoint. The fixture now retains both genuine constructor checkpoints;
production checkpoint fences are unchanged. Two focused checks and isolated
seeded boot passed. The fresh full rerun then passed all **122 cases**, including
seed import/consumption, supervised restart and actual parent-death drain.
Result `.cache/v2-validation/package-7girmS/result.json` has SHA-256
`19fd16286ec7d7614d6d84fa68f7cbf1f626674ecc9e07b07b4408dbb2689c09`.
Acceptance source digest is
`d4a0c1a0f7323e8862e280f611c65df4e143e209cadbc81d978f2b6edd61f0f4`;
source coherence and owned cleanup passed, with the 750 ms interval unchanged.
The three meaningful durable roots passed exact tee reconciliation and explicit
`gaps --verify`: candidate **1,496 records**, baseline **12**, parent-death **109**;
all have zero gaps and no open chunks. Original 108- and 119-case failures remain
preserved. `compiled-acceptance-4-summary.json` binds the concise grade to the
original result. `seeded-checkpoint-validate-full-1.log` records a passing full
lint/type/deterministic validation, including 4,048 UI and 6,325 server tests.

The private packaged prompt rehearsal passed native conflict-notice review,
both explicit Restore actions, exact edited-file backups and Apply & Restart.
Builder and Orchestrator each received both planning/execution guidance clauses
in their original primary system prompt, then completed separate synthetic
loopback turns. No inline primary prompt override or paid provider was used.
Result `.cache/qa/packaged-prompts-oa1OcI/result.json` has SHA-256
`2237e04da8806fbc75458e033b1be4f67cab9e75b3395aa1415a977c9393cfad`;
the packaged source/archive and all 4,695 linked native inputs are unchanged.
All four screenshots were individually reviewed; the 155-record journal has
zero errors and explicit verified gaps, and owned process cleanup passed.
`packaged-prompts-3-visual-and-journal-review.json` binds that independent review
to the original result. The first two failed rehearsals remain preserved: their
oracle mistook the original SDK title prompt for a primary prompt. The corrected
rehearsal recognizes its independently verified exact hash, accepts at most one
per role, and keeps both guidance assertions for the two actual primaries.

The actual publication-disabled [release rehearsal](https://github.com/1H-Team/DevRyan/actions/runs/37392421905)
at `0c2d4235` built and verified the Mac native runtime, native helpers and web
assets. Its resolver then refused all eight missing signed input-image tags;
no image build/publication, DMG packaging, npm publication or finalization ran.
The Create GitHub Release step was skipped, and subsequent read-only API checks
found neither a `v2.0.2` release nor tag. Independent anonymous GHCR HEAD probes
reproduced 404 for each exact content-addressed tag without using Docker Engine.
`macos-release-dry-run-1-review.json` binds these observations to the original
CI status and probe receipts. This confirms the write refusal, while full
dry-run qualification remains failed until those signed image inputs exist.

The image-only preparation mode now preserves the original keyless tag trust
while skipping application assets and all release/npm/hosted database/notification
owners. Its manual purpose tag binds version and the commit prefix; core guards
refuse a wrong identity, every non-image CI operation and all dry-run registry
writes. Focused image/workflow checks pass **29 tests, zero skips**. The first
full run passed 1,189 Node checks and failed an existing exact workflow assertion;
that assertion now requires the additional image-only publication refusal. The
next run passed all **1,190 Node checks**, then passed 252 Bun script checks and
failed the AST whole-file and reviewed-resource child deadlines. Original logs
and hashes remain in `bot-input-preparation-validation-review-1.json`; neither
attempt is a full qualification pass. Those fixtures remove their roots, so no
durable journal/gap grade is available. Image preparation has not yet run and
no app release or final source freeze is established.

The unchanged AST file passes independently within its original deadline. The
reviewed-resource file passes with an explicit Bun path, and 12 unchanged
repetitions pass. A disposable dispatch fixture reproduces Bun's substring
selection of an undiscovered sibling when filenames lack `./`. The third full
attempt passes all **1,191 Node checks**, then fails in the large Bun batch with
corrupted resolver paths. A reduced four-file batch independently reproduces a
notification graph build failure (22 passed, one failed); the unchanged
notification file passes both cases alone. The script runner now uses explicit
paths and one process per Bun file. Its 34 dispatch/coverage checks pass, with
all original native assertions and deadlines retained. Original failures remain
recorded. The fourth complete validation passes after file isolation, including
all lint/type gates, the full script and harness inventory, Electron checks,
4,048 UI tests and 6,325 web tests. The required build and bundle budget check
also pass. Logs are `bot-input-preparation-full-validation-4.log`,
`bot-input-preparation-build-1.log` and
`bot-input-preparation-bundle-check-1.log`. This validates release engineering;
it does not replace final artifact, packaged updater, attended live or
continuity qualification.

Windows run `37383981687` at `a92c85e2` built pinned libsql 0.5.29 from the
unchanged official source on both native architectures using NMake. Node
22.23.3 and Bun 1.3.14 passed both ABI/transaction checks. Downloaded PE machine
identities and full SHA-256 values independently match the receipts:
`3ec054ed07b0e8cc756e77a6a52d06ea10b26611527baa869a60610cc189a8b1`
(x64), `f9a7564676a8d6b51d0db15628a68d7900783d9b2c424f190ab99365507531de`
(ARM64). `windows-libsql-ci-4` retains the artifacts. Both full Windows jobs
remain failed; these database asset candidates grant no runtime admission.

Windows runs [37393296975](https://github.com/1H-Team/DevRyan/actions/runs/37393296975)
(`b655752f`) and [37395518850](https://github.com/1H-Team/DevRyan/actions/runs/37395518850)
(`6c216d8c`) passed the pinned AST 0.45.3 and Claude 2.1.251 PE/version checks,
pinned libsql Node/Bun ABI checks, process/parent identity checks, and all 15
filesystem checks on both actual architectures. Independent downloaded receipt,
PE, pin and binary hash reviews are `windows-native-ci-6-review.json` and
`windows-native-ci-7-review.json`. All nine final step outcomes were reviewed;
both full jobs failed supervisor acceptance and the Darwin-only controller/writer
build, and compiled runtime acceptance was skipped. Run 7's feature inventory
fails before runtime construction at a missing Cursor fixture parent. The
original ENOENT is independently reproduced in
`windows-cursor-fresh-fixture-reproduction-1.json`. The x64 supervisor log records
UI boundary error 87; ARM64 records descendant/inherited-handle failures but
lacks that complete diagnostic. Supervisor manifests retain `acceptance: false`.
Deleted transient fixtures have no retained durable journal roots. Windows
changes remain isolated on `implementation/windows-port`; macOS candidate
source and archive identities are unchanged.

Run [37399204561](https://github.com/1H-Team/DevRyan/actions/runs/37399204561)
at `79cd2dd9` failed the grouped UI command and an empty-job validator mask
assumption. The exact UI command independently reproduces module-mock leakage;
the existing per-file UI runner passes all 12 corrected checks. Run
[37401394828](https://github.com/1H-Team/DevRyan/actions/runs/37401394828) at
`91bd7494` then passes the feature inventory, read-only process/job probes,
15 filesystem checks, pinned AST/Claude probes and libsql Node/Bun ABI checks
on both hosts. Both full jobs still fail supervisor acceptance and reviewed-byte
identity before native candidate compilation; compiled acceptance is skipped.
All nine actual outcomes, exact PE/source pins and downloaded receipt hashes
are independently reviewed in `windows-native-ci-{8,9}-review.json`.
The new receipts show both containing jobs permit breakaway; the empty-job
`0x3ff` UI mask is refused on Server 2022 with error 87 and accepted on ARM64.
These are diagnostics, not confinement acceptance.

A real disposable Windows-style Git checkout independently reproduces CRLF
conversion of the pinned reviewed Slim source. Scoped `.gitattributes` now
preserves original resource bytes; all four native-asset checks pass. Imported
Windows build helpers are included in macOS native identities. Two actual Mac
builds of the isolated Windows branch pass, including the corrected helper hash
record; they qualify neither Windows nor the final Mac release candidate.
The subsequent Windows supervisor change selects every available UI restriction
from the genuine OS build and requires exact kernel readback, with no reduced
retry. Three focused contract checks pass. Runs
[37402878771](https://github.com/1H-Team/DevRyan/actions/runs/37402878771) at
`e0ba65b0` and [37403407287](https://github.com/1H-Team/DevRyan/actions/runs/37403407287)
at `22e302ca` advance past reviewed byte checks and refuse the build-only
compaction helper path before inventory. Its POSIX prefix guard is replaced
with native absolute-path validation; the exact SDK byte and insertion guards
remain, and all five focused observation checks pass.
Run 11 compiles both supervisors and retains exact kernel UI readback: Server
2022 build 20348 accepts `0xff`, and ARM64 build 26200 accepts `0x3ff`.
Both containing jobs still allow explicit/silent breakaway, and command
supervision acceptance still fails. All nine actual outcomes and downloaded
PE/source/pin/receipt digests are independently checked in
`windows-native-ci-{10,11}-review.json`. Compiled controller/writer acceptance
is skipped, manifests retain `acceptance: false`, and deleted transient fixtures
have no durable journal/gap grade. Fresh native qualification remains required.

Runs [37404790881](https://github.com/1H-Team/DevRyan/actions/runs/37404790881)
at `121faa3a` and [37405887286](https://github.com/1H-Team/DevRyan/actions/runs/37405887286)
at `81f39b99` reach the controller/writer builds. Run 12 fails the x64 writer
boot refusal; ARM64 cleanup fails with `EBUSY` and masks the original error.
Run 13 retains both complete seven-file sets and exact source/build identities:
both controllers refuse empty input correctly, while both writers exit 0 with
no reply. Independent payload review finds the original exported helpers and
the eliminated `import.meta.main` protocol block. All nine outcomes and original
PE, pin, Git checkout-byte and receipt hashes are checked in
`windows-native-ci-{12,13}-review.json`. The native supervision gate remains
failed, and runtime acceptance is skipped on both architectures.

The Windows branch now uses an explicit compiled writer entry and retains
unqualified candidate files without directory promotion, which also refused
with `EPERM` on ARM64. Fifteen routing checks pass. A fresh shared macOS build,
signature/resource verification and both empty-input boot refusals pass in
`windows-candidate-shared-macos-native-build-{3,4}-review.json`. Build 4 includes
the current exclusive-output correction; both Windows reruns remain required. No Windows
admission, integrated compiled acceptance or installer pass is implied.

The fifth local full Windows-branch validation passed its preceding gates and
660 harness checks but failed four unchanged platform input cases at the default
five-second runner cutoff. Their independent unchanged reproduction passes;
the affected fixture registrations now use a bounded 120-second deadline, and
all 15 input checks pass with original confinement/receipt assertions intact.
The failed full log remains bound to `6c216d8c` in
`windows-feature-integrated-full-validation-5-review.json`. Final integrated
Windows validation remains required.

Windows run `37366300612` initially had no acquired runners; its retry compiled
both supervisors and passed both process/parent identity checks. Each retained
filesystem receipt passed 13 checks and then failed exclusive-file-lock refusal.
The original SDK attribute/security handle can bypass sharing restrictions;
the isolated Windows branch now requests read access. Run `37370143551` at
`a8810206` passed all 14 filesystem checks, including exclusive-lock refusal,
and both process/parent identity checks on x64 and ARM64. Original receipts are
retained in `.cache/release-2.0.2-recovery/windows-sdk-ci-4`. The subsequent
parent-anchored inspection change passed all 15 filesystem checks and both
process/parent identity checks on both architectures in run `37371384474` at
`0a8225ae`. Receipts are retained in `windows-sdk-ci-5`; supervisor SHA-256
values are `a8e55bdba2d6f39dae0114b6deae548bf8275b64f8c9b83fbb72dcf7beb945e4`
and `74239280e1046628be870b610597a38cf68c5d3f5e9a893c7c30fc7db17b720b`.
Full confinement and controller/writer builds remain failed.

Run `37377148453` at `17c9624d` again passed the 15 filesystem checks and
process/parent identities on both native architectures. Its pinned libsql
0.5.29 source build failed during pre-compilation identity checks; neither
compiler nor binary receipt was produced. The failed receipts and logs remain
in `windows-libsql-ci-1`. A follow-up records the finite failing stage and public
source-file hashes. Native ABI qualification remains pending.
Follow-up run `37380055984` at `c0f0d366` identified the same
`source-bytes-Cargo.toml` failure on both architectures. Its digest exactly
matches the pinned source converted to CRLF, independently reproduced in
`windows-libsql-checkout-reproduction-1.json`. Commit `91b236a2` preserves LF
bytes for the reviewed source checkout; four portable checks and documentation
validation passed. The native source/ABI rerun remains pending.

The corrected Stage F invocation passed all seven wire cells and both actual
native-runtime UI cells against the unchanged source, runner and QA archive
hashes above. Its result is `service-correction-stage-f-run-2.json`. All nine
recorded screenshots from the two actual-runtime cells were manually reviewed:
composer and cancellation controls remain visible, human agent/tool names are
readable, and the published file change survives completion. Both actual-runtime
journals have zero verified gaps and owned process cleanup has no errors.
Separate hash-bound review and gap receipts are
`service-correction-stage-f-2-runtime-visual-review.json` and
`service-correction-stage-f-2-runtime-gaps.json`. Physical devices, paid
providers and native compaction are not covered by this review; original
earlier failed grades remain preserved.

The separate manual wire screenshot review now covers **395 of 395 unique
images**, accounting for all **401 original references** and six duplicate
references across the seven cells. No actionable layout defect was found in
the recorded desktop, phone, tablet and landscape layouts in either theme.
Per-image notes distinguish controls visible in the captured scroll position
from content outside it; behavioral and disabled-state claims remain owned by
the wire assertions. The completion receipt
`stage-f-wire-visual-review-completed-1.json` has SHA-256
`03b96cb88b9e6b721887e505e7806570720a98e5725cde2753757f07d4eee61a`.
It verifies every original image hash, both provenance closures, the prepared
input and the QA archive against the original source, runner and archive
identities. `stage-f-wire-visual-review-progress-1.json` retains all review
notes. This closes the recorded wire visual gate at that frozen QA source;
final release artifact qualification remains separate.

The original seven actual lifecycle modes passed with the independently built
predecessor and current frozen artifacts in
`.cache/v2-validation/release-2.0.2-application-3CyDzw/result.json`.
The packaged recovery window was operated through computer use: its real Cancel
button returned `cancelled`, left the retained state byte-identical and started
zero native controllers. Both recorded screenshots were reviewed separately;
the native dialog's manual review receipt remains beside its original result.
Both lifecycle journals have zero verified gaps. The earlier Bun invocation
failed to import the sealed configuration module and remains failed; the
successful wrapper used Node. This cancel check does not qualify positive
Electron Resume.

The original seven CLI persistence checks passed against the frozen native
artifacts in `synthetic-cli-v2-release-2.0.2-wUaqzw/result.json` under
`.cache/v2-validation`: fresh start and restart preserved conversation IDs and
durable markers, replayed no provider requests, verified retained artifacts,
and physically drained both owners with zero verified journal gaps. The
hash-bound wrapper receipt is `service-correction-cli-persistence-1.json`.
All eight actual CLI refusal modes now pass against the unchanged packaged
source and runner `f7f48ba2038185e3307211799b2321e5c1eedc590d964cf9762ec55e74d27758`:
noninteractive, quiet, `-q`, JSON, plain, fully specified invalid flags, TTY and
TTY JSON. All exit 2 without creating owner files. The actual TTY output was
reviewed separately; original result `service-correction-cli-refusal-2.json`
has SHA-256 `d79c48b9522dbe8b2bb2a9cba2f135e9651f36ebbfaba7902da562dc22c13efd`.
The separate review is `service-correction-cli-refusal-2-manual-review.json`.
The positive native Electron Resume supplement also passed in
`.cache/release-2.0.2-recovery/positive-electron-G502jb/result.json` (SHA-256
`89100dc21ac05088f028e0c1904a198d695d6eae21b7ba99a00e3000c73fd7dd`).
Computer use clicked the actual "Resume and restart" native button. The preload
returned `restart_required` at revision 3; the real `app.relaunch` owner had a
new PID and private owner pair, matching OS boot/start/binary/argv identities.
Both health routes and the visible composer became ready. History, credential
and configuration assertions passed, the native controller retained a clean
termination receipt, and owned-process closure had no errors. The two original
held/ready screenshots were reviewed in the separate `manual-review.json`.

This supplement prospectively disabled Bots in disposable A settings before
upgrade, history and rollback crash; B retained that setting. Its source
derivation and exact hashes remain in `positive-electron-provenance-1.json`.
The original application drivers and recovery assertions remain active. The
capture intentionally stops after the cold hook; its original lifecycle
sidecar remains failed and does not substitute for the separate seven-mode
pass above. Docker, global registration and installed-app continuity are not
covered.

All six original packaged first-launch cells failed at Git helper startup and
cleaned up their owned processes. Their startup journal contains no detailed
records. Independent original-helper reproduction proved that SDK filesystem
discovery reached the enclosing checkout and correctly refused it with
`native_helper_directory_denied`. The QA fixture now creates empty-template
Git boundaries in its private HOME and eight projects. The first corrected
rerun (`service-correction-first-launch-3.json`, runner `35425679e5c0fc02f89fd3288758c974ce297ad3c9e14aa0d1d69b6bec84137c`)
recorded four passes and two selected-v2.0.0 startup failures. Independently
reproducing the genuine selected bundle proved that its workspace root also
needs a Git boundary. Manual review additionally found that both shell-export
"passed" screenshots still showed the initial runtime chooser. Their original
runner grades remain intact; `service-correction-first-launch-3-visual-review.json`
records the failed visual review. All owned processes drained cleanly.

The QA fixture now protects HOME, workspace and all eight projects. Readiness
also requires the visible enabled composer within the original 180-second
deadline. All 16 focused checks pass, including hostile inherited Git inputs
and refusal to grade a backend-ready chooser as loaded chat. Production
refusal is unchanged. The next six-cell rerun uses runner SHA-256
`f7f48ba2038185e3307211799b2321e5c1eedc590d964cf9762ec55e74d27758`;
all 4,695 linked native inputs and packaged source/archive hashes are unchanged.
Original failed results and screenshots remain preserved; the stronger
packaged rerun passed all six cases. Result `service-correction-first-launch-4.json`
has SHA-256 `453dd27f1a50bd83a3683a08cf740412ca7379ee3432cf66c344679e4930a581`.
All six original loaded screenshots were individually reviewed: each shows the
composer, eight project rows and no startup chooser. The separate review is
`service-correction-first-launch-4-visual-review.json`; all owned trees drained
cleanly. All six startup journals and both positive-recovery journals have zero
verified gaps in `service-correction-first-launch-4-positive-gaps-verified.json`.
This receipt reruns explicit `gaps --verify` for all eight roots with unchanged
index hashes; the earlier default-only gap receipt remains preserved. These
checks do not replace the compiled inventory's three meaningful-root gate.

This table must be rebound to the final source commit, lock hash, native build
identity, image manifest identity, packaging digests, and installed artifacts
before it can authorize publication. Current evidence is interim engineering
evidence in `.cache/release-2.0.2-recovery`.

Scoped Bot input preparation
[37408733885](https://github.com/1H-Team/DevRyan/actions/runs/37408733885)
passed at `b68b63964722586234cf91240aa0b8a1402b3995`. It built and signed all
eight inputs under the purpose tag `v2.0.2-bot-inputs-b68b63964722`. Independent
assembly, input-tag and source checks passed; application release, npm,
database and notification jobs were skipped. Its manifest SHA-256 is
`77fe88c7b1c74ffaf2c08d3c29d900c880c6de2ec0680465feaee91a424f83bb`.
`bot-input-preparation-ci-1-review.json` preserves the preparation grade;
the subsequent resolver owns cryptographic reuse verification.

The fresh macOS dry run
[37410353334](https://github.com/1H-Team/DevRyan/actions/runs/37410353334)
passed at the same source. All eight images were reused through the original
OIDC signature checks for each index and both platform digests (24 total),
followed by anonymous access and isolated production topology verification.
Every image build/sign/tag step and every application, npm, database and
notification publication step was skipped. The candidate application tag and
release both remain absent (original 404 probes retained).
`macos-release-dry-run-2-review.json` binds the completed CI metadata, original
logs, image receipts and exact asset allowlist. Its SHA-256 is
`ebae01ff9b520f89cddb1d8d6275b4c78f69a73dcea3103f1ad1c0d63b06e9d5`.
Local cosign replay was unavailable; the signature gate passed in the exact
frozen CI resolver, without changing its signer policy.

The downloaded **551,316,441-byte** `DevRyan-2.0.2-arm64.dmg` matches the
packaging job's SHA-256
`fd15f2c88e63200e55dfdc8bb5e324e993c82a1cf0b415b4b2bf9c19fee87a2a`.
Image integrity, read-only mounting and strict ad-hoc app signing passed.
The native inventory and all 4,695 current build-input hashes passed, as did
the 35 packaged configuration files, 18 runtime plugins, exact Bot manifest
and four Cursor native resources. The shipped Electron executable loaded the
packaged updater bridge in isolated Node mode and exposed both required
functions; no service, installer or GUI method was called. The image was
unmounted afterward. Native build ID is
`77deeb6c26d5a132aeddd467ef142dfd08141ee626b9d6f35c1daa01c140885a`,
manifest SHA-256 is
`de0417915a42053498f1e0dbf12ed7f0c00f014b48acf7ea0a89936d321d49df`,
and the app archive SHA-256 is
`9f5e20b56835de87d286a6b9014e88185b6094719ecf4a84f18db139f7932ce3`.
`macos-release-dry-run-2-mounted-artifact-review.json` has SHA-256
`2c79315bdfedb8b2c66c3343f3c996ead8afca7c147d3e16d7f167c3bdaa0717`.
Installed GUI launch, actual packaged updater cases, shipped continuity,
attended providers, final performance qualification and publication remain
outstanding. No notarization is claimed.

The downloaded DMG's complete compiled inventory passes all 122 original cases
in `package-aiDCCy/result.json`, including 23 captured skill bodies, 14 support
reads, all 507 captured files, seeded credential consumption and supervised
restart. The captured user-owned skills remain unchanged. Candidate, baseline
and parent-death journals contain 1,479, 12 and 107 meaningful records, with
sealed chunks, reconciled writer counts and zero verified gaps. All owned
processes drained, and the 730 native acceptance sources remain at digest
`d4a0c1a0f7323e8862e280f611c65df4e143e209cadbc81d978f2b6edd61f0f4`.
`macos-release-dry-run-2-compiled-acceptance-2-review.json` has SHA-256
`1c01ad2833edba0c354c9891a90be07119d7d6e248fa36921644443d27801245`.
The first 84-case run omitted captured skills and remains explicitly incomplete;
its result is not spliced into this fresh complete run.

The same downloaded native inventory passes all seven original application
lifecycle modes in `dmg-native-application-l4hERs/result.json` (SHA-256
`14faa18a9c6fde523ca0a235ec365a71f2900013664136badd8fdb31269814fd`).
Actual native Cancel returns the original preload acknowledgement and preserves
held state. Positive Electron Resume separately passes in
`dmg-native-positive-electron-nfCdXr/result.json` (SHA-256
`e972d3631fe9eaabec790a6bc58f1afcebcdea725089b6b046f49ed6888f8284`):
revision 3, natural original exit, a distinct private relaunch owner and OS start
identity, ready UI, durable controller receipt and retained history/credentials.
All 210 observed process identities are physically closed. The four retained
journals contain 121, 314, 107 and 219 records, with zero verified gaps. The
crash path retains one open chunk; these application lanes lack accepted-count
tees and do not replace the separate sealed 3/3 compiled journal gate.
The independent review SHA-256 is
`bc6d30de8435af55f2d9c5c203b1a744947e882bc8a28abdb0e51ea01d145600`.
The first lifecycle invocation correctly refused a stale default native stage
before launch. Its original 11 files were preserved byte-for-byte before
staging the verified DMG copy; the reversible staging receipt is
`macos-release-dry-run-2-default-staging-1.json`.
The predecessor is an independently built fixture, not shipped 2.0.1. These
runs use the unchanged private QA app, not an installed DMG GUI. The positive
fixture disables Bots prospectively and its intentionally partial capture
is distinct from the complete seven-mode result.

Fresh original web and Electron actual-runtime cells also pass with this DMG
native inventory. Result `dmg-native-runtime-ui-zY0haX/result.json` has SHA-256
`fb682c143ae599af94e8c8b6cdd289b813ba7ae2b05ddfdaca725e6df46630ad`.
Send, reload, cancellation, reconnect and native read/write publication pass.
All nine screenshots were individually reviewed; both completed views show
resolved one-file changes and usable composers. Their sealed archived journals
contain 255 and 252 records with zero verified gaps; all 100 observed process
identities are closed. Source, runner and served artifact proofs are unchanged
within each cell. The original exact input verifier passes before private input
cleanup; sanitized exports do not independently recover those removed inputs.
Review SHA-256 is
`64b5011262bbdda51540b9a2a87e98e1d187143645025e422379adb6e46914da`.

The same native artifact passes the existing burst diagnostic at 750 ms: three
warmup turns and two measured turns, each with eight completed writer calls.
All five timing sets retain physical provider send, first byte, first output,
first text, bridge and ledger marks. All 16 measured writer process identities
join to their receipts; owned cleanup succeeds. The sealed journal reconciles
all 642 records with zero verified gaps. The independent review digest is
`09d52547304b0d9929650d1bd0147f360b48040dacc6a6195fac7894f9fb7615`.
This diagnostic retained 34,128 KiB after cleanup. It supplies neither a full
cohort grade nor justification to change the interval.

Windows native run
[37408333818](https://github.com/1H-Team/DevRyan/actions/runs/37408333818)
at `725c354d` passes both native controller/writer builds and their exact
empty-input boot refusals. Downloaded PE/source/pin/ABI and all nine actual
outcome checks pass as evidence of failed qualification in
`windows-native-ci-14-review.json`. Supervision remains failed: x64 retains
Node initialization refusal; ARM64 reaches descendant, inherited-handle,
Unix-socket, mode and Revert durability failures. No meaningful runtime
journal roots or compiled inventory pass is supplied by these host probes.
Admission remains false and both installer gates remain not run.

Runs [37414619426](https://github.com/1H-Team/DevRyan/actions/runs/37414619426)
and [37416091535](https://github.com/1H-Team/DevRyan/actions/runs/37416091535)
repeat the independent native builds and exact boot refusals. All nine actual
outcomes remain reviewed as failed qualification: supervision fails and compiled
acceptance is skipped. Downloaded disposable startup probes verify that x64
Node/Bun initialization failures persist without UI job limits, with a private
station, and with Low token integrity. ARM64 starts the original, no-UI and Low
copies; exclusive unnamed station copies refuse error 183 with empty receipts.
These probes grant no admission. The run-16 native review digest is
`78d2f4b55043860d2c7bae9cafc85094a81a69d803a76b87d7cff3d8800b22a2`;
its separate 20-probe startup review digest is
`147ed3b446ec95621ff974e11646ac16b601efed62531d88ad2aee245454e540`.
The isolated Windows branch's macOS `validate:full` passes at `874ab3f4`,
including 6,328 web tests, 4,049 UI tests and 39 retained legacy Rust tests;
log SHA-256 is `9e90adb2a0e44ddbfc25ce7629ea08f4ae21627e5eef730dd25eee2889500b48`.
This local validation does not qualify native Windows execution.

Run [37417726695](https://github.com/1H-Team/DevRyan/actions/runs/37417726695)
at `583110a2` again passes both native builds and boot refusals while failing
required supervisor acceptance; compiled runtime acceptance remains skipped.
Its downloaded native review SHA-256 is
`ab676fa9d20dc1b4507b7c8fe0d7a2de63e593722efd7b352217bcb070362e6a`.
All 24 disposable startup probes have exact frozen-source, PE, binary/output
and receipt checks. Adding SYSTEM solely to the child process default DACL
does not change x64 Node/Bun initialization failures. ARM64 starts the original,
no-UI, Low and process-DACL probes; Bun retains ancestor configuration access
diagnostics. Exclusive station creation refuses error 183 with empty receipts.
Startup review SHA-256 is
`dcc30d661e6ed6bf07b53a30ef7a0015585646433d115792f53575372b2fb2cd`.
The next isolated probe changes only the new desktop's descriptor; production
confinement remains unchanged and admission remains unavailable.

## Main integration and retained qualification

At the owner's request, `main` fast-forwarded from `770acfda` to the macOS
branch's `7c92cd36`, then merged Windows `99d1aa08` without conflicts in
`d834eca1`. Both original branches, fresh backup refs and a verified complete
three-branch Git bundle remain preserved under
`.cache/release-2.0.2-recovery/main-integration-20261006-0627`.
Implementation continues on `main`. Windows qualification now follows pushes
to `main` with the same required native outcomes and no publication authority.
Combined-source `validate:full`, build, bundle and documentation checks pass at
`b5327d60`, including 6,328 web tests, 4,049 UI tests and 39 retained Rust tests.
The clean source tree and all four log hashes are retained in
`main-integration-20261006-0627/validation-1-review.json`, SHA-256
`db54488d41f5c8ecec94ab8c0cc1910db0bb1a6d0df27c288f937fcc3c68b158`.
The full-validation log SHA-256 is
`d2eaafd092fc518dd6dfbf0b5f2e344292f686f6ad8ac2908afedb54b5bd3625`.
The earlier macOS source/native bindings below remain historical;
the shared Windows changes require fresh final qualification, not relabeling
their retained results.

Before this merge, the downloaded DMG native inventory `77deeb6c` passed the
original seven CLI persistence cases, with 37 observed process identities
physically closed and 65 sealed journal records with zero verified gaps.
The independently reproduced sanitized controller archive and input inventory
are recorded in `macos-release-dry-run-2-cli-persistence-1-review.json`, SHA-256
`575f8053e50dac252018754838320b6ca01343743d2ebc31c1f1bfd9f932e0ce`.
Both saved-configuration host snapshots pass the original eight-role,
four-Council and three-project-file checks. The two changed primary prompt
digests were independently derived from packaged Markdown; all other role
settings stayed exact, and credential bootstrap deliberately refused.
Review SHA-256 is
`71e095657f81b5abb494b876bc3248de64f1109061eb5633f75a7d156fad9218`.

The seven retained wire cells have a scoped continuity review: all 64 files in
their script import closure and 6,578 product entries match the executed
source, all 395 unique reviewed images rehash exactly, all 294 observed process
identities are closed, and the original journal checks have zero gaps.
Review SHA-256 is
`369fe633964e8aabda03398ec14e67e3df42956698ccfface58ab4bc18827f6d`.
This does not claim those cells executed the newer native inventory or the
merged source. The fresh read-only five-file Bot input review passes at SHA-256
`7ada54f3419060a39a273132c31ce7a366791b7300ea4f526a0ab1b1eabb51bb`.

The thirteen local synthetic performance prerequisites passed for source
`83239867` and native inventory `77deeb6c`; their review SHA-256 is
`bfe12e57db939672605aabcc5c970b146ba7c32fa4fd1596b78687b3343010e8`.
The original six-launch attribution phase then failed after its first arm.
Its natural exit, closed tracking and zero remaining owned processes are
retained in `macos-release-dry-run-2-stage-e-2`. This failed cohort is not
resumed or spliced. Read-only investigation verifies zero gaps in both retained
journals and durable parent/child success; this does not prove receipt of the
exact terminal event. Calibration, frozen grading and paired launches remain
not run; the interval stays 750 ms.

Windows run [37419982853](https://github.com/1H-Team/DevRyan/actions/runs/37419982853)
at `99d1aa08` again builds both native controller/writer sets and passes their
exact boot refusals, while supervisor acceptance fails and compiled acceptance
is skipped. All nine actual outcomes and downloaded evidence are reviewed at
SHA-256 `bed1d27244712fc88c1a6a284b6330f613bb7c64eca79e270ed4e4dfebd12b38`.
Its separate 28-probe startup review has SHA-256
`881e8ec1460afa07278ab9e824129a1ce8a934f27c1845891b28b078654313bd`.
Adding SYSTEM only to the new desktop leaves x64 Node/Bun initialization
refusals unchanged. ARM64 starts that copy, with Bun retaining the ancestor
configuration access diagnostic; exclusive station creation still refuses
error 183 with empty receipts. Production confinement remains unchanged,
admission stays unavailable, and no installer or native safety pass is claimed.

`main` was pushed at `1d161d92`; local and remote heads matched and the checkout
was clean. [macOS input verification](https://github.com/1H-Team/DevRyan/actions/runs/37426159240)
passed on that exact source. [Windows qualification](https://github.com/1H-Team/DevRyan/actions/runs/37426159338)
failed on both architectures. Downloaded evidence confirms all nine actual
outcomes: candidate builds, host/filesystem boundaries, feature refusals and
pinned resources pass; supervisor acceptance fails and runtime acceptance is
skipped. The native review SHA-256 is
`9e63ac0ababe78ad4da9ed5186e985fdea1b5ac5771e450a1ae6920b52ed74b6`.
All 28 startup probes also pass independent evidence review at SHA-256
`231fd0fc551be02735ed46432e51c54cc3a9fb8bdfcf0f1cab3844018d567060`.
Their initialization/refusal behavior is unchanged; admission stays unavailable.

Fresh local native build `9311bb5b` reproduces the attribution failure with
the original 60-second deadline. Structural stream evidence confirms both
success terminals omit directory metadata; the diagnostic discarded its exact
parent's terminal. The correction accepts only that owned parent after its
reply, rejects explicit foreign directories and other sessions, and preserves
the remaining stream filters. Policy, grading and the 750 ms interval are exact.
Four regression checks and a fresh original compiled arm pass: nine cases,
measured causal timing, one observed receipt-bound writer identity, 212 observed
process identities physically closed and zero verified gaps in both journals.
The correction review SHA-256 is
`8b85245ab745bfdf6cc574d42c42cb62785ea13906ea533965e0ca67d79ad2bd`.
The first observation harness failed on its abort handler; its evidence and
closed cleanup remain preserved and supply no qualification.
`validate:quick` selected and passed full validation for this QA change,
including 6,328 web, 4,049 UI and 39 Rust tests. The exact patch/file/log review
SHA-256 is `96851091fbb11b8ce44937ee7c3f9bcf7666c10ff01e5bd69cb26255e57c9686`.
Product build inputs are unchanged from the earlier passing build/bundle gate.
This isolated arm supplies no six-arm comparison or performance retention grade;
the original failed cohort is not relabeled or resumed.

| Mandatory gate | Status | Evidence or prerequisite |
| --- | --- | --- |
| Full integrated validation, build, bundle budgets and documentation | Passed on merged `main`; QA correction also passes full validation; final freeze pending | Combined source passes all four commands at `b5327d60`; review `db54488d` retains exact source/tree/log hashes. Correction review `96851091` retains the later exact patch and full validation; product build inputs stay unchanged. Final source/artifact qualification is pending |
| Packaged prompt conflict notice and explicit restore | Passed (focused and private packaged); final freeze pending | Native notice, two explicit restores with exact backups, configuration apply, both original primary guidance requests, four reviewed screenshots and verified journal gaps |
| Tracked credential owner and synthetic rehearsal | Passed (compiled synthetic); live not run | Original SDK OAuth, compiled native key/CAS owners, held projection, ready boot and zero evidence leaks; final identities and attended live/launcher qualification pending |
| Complete B1 review closure | Consolidated (focused); qualification pending | Seven engineering scopes above retain original reproductions, corrected checks and current drift; final compiled/live/package evidence pending |
| Compiled acceptance and seeded-credential boot | Passed (122 cases from downloaded DMG); final freeze pending | Native build `77deeb6c`, exact complete captured-skills inventory, seeded import/consumption and supervised restart passed; earlier incomplete and failed runs remain preserved |
| Three meaningful durable journal roots and verified gaps | Passed (3/3 from downloaded DMG); final freeze pending | Candidate 1,479, baseline 12 and parent-death 107 meaningful records; explicit gap verification and accepted-record reconciliation passed |
| Seven lifecycle modes and seven wire cells | Seven modes passed with downloaded DMG native files; seven wire cells passed at retained source; final freeze pending | Native Cancel and exact prior/current identities retained. Application journals have zero verified gaps but one crash-open chunk and no accepted-count tees; separate compiled 3/3 gate passes |
| Two actual-runtime UI cells and reviewed screenshots | Passed with downloaded DMG native files; final freeze pending | Fresh web and private packaged Electron cells passed; all nine screenshots reviewed; archived journal counts 255/252, verified gaps zero and 100 owned identities physically closed |
| CLI persistence/refusal and Electron Resume | Passed at retained artifacts; final freeze pending | Seven original DMG-native persistence checks, eight actual refusal modes with TTY review, packaged Cancel and positive Resume/relaunch/preservation/cleanup passed; prospective Bots-disabled supplement scope above |
| Shipped 2.0.1 → candidate → 2.0.1 continuity | Unavailable on current host; VM prerequisite pending | Unmodified shipped startup registers a global LaunchServices protocol; disposable HOME cannot isolate it |
| Packaged first launch and service mode | All six first launches and service mode passed; final freeze pending | Ten-boundary/composer correction passes 16 focused checks; six original screenshots reviewed and gaps verified; all earlier failures retained; production registration and authenticated lease remain separate |
| DMG update success/refusal/interruption/rollback | Passed (focused); packaged not run | Verified downloads, native app exchange, startup acknowledgement and guarded rollback; killed-helper/native exchange checks pass; disposable package qualification pending |
| Exact provider/role graph, 12 journeys, 16 compaction boundaries | Not run | Owner sign-in window after credential-free rehearsal |
| Managed-user verification | Unavailable | Non-production Supabase environment not supplied |
| Cold/warm loopback and full performance audit | Passed (engineering baselines); final not run | Three baseline and three candidate repetitions; gains within noise, candidate removed; full audit and frozen grading pending |
| Burst, six attribution, 21 calibration, conditional 42 paired launches | Burst passed; failed attribution retained; compiled correction passed; fresh cohort not run | Downloaded DMG burst retains five complete timing sets, 40 writer calls, 16/16 measured identities and 642 reconciled journal records with zero gaps. Fresh local one-arm correction passes nine cases and causal/receipt checks; six-arm bindings, calibration and frozen grading remain pending; retain 750 ms |
| Release dry-run with no external writes and exact asset digests | Passed at `b68b6396`; final freeze pending | Scoped signed Bot preparation passed; the fresh dry run reused all eight images through the original 24-digest signature gate, passed isolated topology and packaged the exact DMG. All application, registry, npm, database and notification writes were skipped; downloaded digest matches the packaging job |
| Downloaded DMG digest, mounted app, isolated launch and updater | Digest and mounted artifact passed; installed GUI and updater not run | Strict ad-hoc signing, native inventory, 4,695 current build inputs, packaged configuration, Bot manifest, Cursor resources and the shipped Electron Node-mode updater bridge passed. Isolated installation environment remains required |
| Windows x64 / ARM64 native safety and installers | Native build and boot refusals passed; release gate failed | Runs 14–19 independently verify both native PE controller/writer sets, both canonical boot refusals, pinned resources and source-built libsql ABI receipts; run 19 is merged `main`. Supervision fails on both architectures; compiled runtime acceptance is skipped, admission stays false and installers are not run |

macOS remains ad-hoc signed. Windows packaging is unsigned. No notarization,
Authenticode, live provider, or Windows runtime pass is claimed. Verification
must keep the user's installed app, running runtime, Docker Engine, and data
untouched. Provider sign-ins remain owner actions. Trash cleanup requires
approval of exact paths and sizes; no user data or Superpowers folder has moved.
