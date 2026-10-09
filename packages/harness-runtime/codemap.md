# packages/harness-runtime/

## Responsibility

Native OpenCode admission uses the existing session ledger for lineage
revisions, durable holds and deferred continuation records. The Revert
coordinator passes its durable transaction identity to conversation-only
stage/clear operations and releases native holds only after ledger commit or
cancellation. Recovery also retries hold cleanup for settled transactions.

Dependency-free shared Node runtime for durable DevRyan harness state,
diagnostics, lifecycle correlation, worktree operations, and optional turn
evidence. Web/Electron are hosts; the renderer consumes only host
API contracts.

## Where to change things

- Journal compression in `lib/journal.js` uses asynchronous zlib inside the existing bounded serial writer. Per-bucket rotation is single-flight so writes cannot reopen a segment while its compressed replacement publishes. Shutdown drains the writer and rotations; active plain segments retain crash recovery.

- Retained request/step/message accounting and purpose cohorts: `lib/usage.js`. Shared normalization lives in `packages/shared-runtime/lib/usage-observation.js`; `lib/sanitizer.js` attaches the optional contract to final runtime events, and `lib/export.js` includes `DevRyan-usage.json`. Exact title diagnostics preserve deleted-helper attribution in `lib/session-id.js`. See `docs/CACHE_EFFICIENCY.md`.

- Selective mutation ownership: exported `lib/session-mutations.js` and internal
  `lib/session-mutation-text.js`, with immutable bases, replacement ancestry,
  generation fences and recoverable publication receipts. The runtime method
  `recoverNativeTransientHolds` releases only exact temporary bundle-owner holds
  during verified constructor recovery, under one bounded ledger decision;
  durable Revert, retention, removal and foreign fences stay intact. Bounded
  execution-wake discovery shares the existing deferred continuation inventory
  and revision-bound acknowledgement. Exported
  `lib/session-revert-coordinator.js` coordinates conversation boundaries,
  acknowledged target-tree cancellation and the durable commit decision.
  `lib/session-execution-owner.js`, `lib/session-execution.js` and
  `native/session-execution.c` and `native/session-execution-windows.c` own the
  native confinement boundary. The host connects captured writers and file
  Undo/Redo only after verifying matching accepted artifacts. Contracts are in
  `docs/CONCURRENT_REVERT.md`; platform verification is recorded in
  `docs/audits/2026-09-20-concurrent-revert/README.md`.
  Windows selects every OS-supported UI restriction from the genuine build
  number and requires exact kernel readback. Its version-2 diagnostic records
  the SDK and requested masks; diagnostic success grants no admission.

- Session-owned tool captures, cumulative revisions, stored diffs and conflict-checked restore: `lib/session-changes.js`; authenticated host HTTP/plugin adapter: `lib/session-changes-host.js`. `lib/session-changes-tools.js` owns shared tool/receipt normalization; `lib/session-changes-receipts.js` persists exact evidence and immutable segments. Snapshot observations never establish ownership. Call-scoped repair, monotonic exact evidence, retained descendant lineage and pending reconciliation are covered by `lib/session-changes-recovery.test.js`; the host acknowledges private Cursor execution receipts after persistence. `lib/session-changes-git.js` streams Git I/O; its constructor-only `createOwnedGitRunner` binds one absolute executable, frozen environment, argument prefix and synchronous scope validator for the offline Windows bundle job. `openChangeStore` accepts that owned runner and an explicit object durability callback while keeping the original indexed metadata/ref transactions; ordinary callers keep their existing Git and durability behavior. Windows mutation stores pass their constructor-owned launcher to `lib/object-durability.js`, which awaits the SDK objects-directory namespace flush before ledger publication and retains failed flushes for retry. `lib/session-changes-snapshot.js` owns scoped capture and the bounded stat cache; `lib/session-changes-store.js` owns individually indexed metadata and atomic publication; its `records()` streams a whole snapshot (batched `gitRecords`, ignores pending), so whole-ledger listings never buffer through `git()` (1 MiB stdout cap). `lib/session-changes-scale.test.js` covers large capture, pagination, migration and collection. See `docs/SESSION_CHANGES.md`.

- Startup recovered inputs reuse the primary recovery owner: dedicated same-ID
  adoption and pre-cancel/event-backed disposition CAS preserve tools and fallback
  attempt budget. The host constructor adapter exposes bounded descriptors,
  lazy exact contents and explicit Resume/Discard; ordinary Continue/intent cannot
  mutate a paused backlog. Stop remains session settlement. Controller SSE is
  explicitly a partial record projection; full GET/action snapshots authoritatively
  refresh or clear the recovered inventory without native callbacks under owner locks.
- Primary OpenAI/Claude liveness, provider mode/conformance gates, durable attempt/cancellation fences and read-only recovery: `lib/provider-recovery.js`, `lib/provider-recovery-policy.js`; shared host HTTP adapter: `lib/provider-recovery-host.js`.
- Native retry before the SDK's lazy `Step.Started` reserves an inert choice in the existing provider recovery record. The first genuine canonical Step binds the same current turn, controller, cancellation generation, native attempt and original operation permit; an earlier completed Step cannot supply authority. Replacement leaves the choice closed; fresh explicit adoption of the same original input retires that stale choice. Failed publication settles before unavailable/exhausted attention or the existing single read-only fallback dispatch.
- Generation-2 primary admission uses a trusted effective-selection receipt from the server admission owner. `provider-recovery-host.js` carries request ownership through `AsyncLocalStorage`; canonical provider/model/agent/effort are persisted before dispatch and explicitly reused for continuation. Missing selection evidence or an uncertain dispatch stays closed. Private native continuation adoption requires canonical sequence and host proof, preserving the original user anchor and budgets.
- The direct host-only `helloNative()` method verifies exact native versions 2.0.20 and 2.0.24 (retained rollback) and 2.0.26 through bounded, generation-fenced `/api/info` evidence. One native instance cannot change between those release identities. The legacy provider recovery version list remains separate and unchanged. Public plugin handshakes still require full readiness even when a caller supplies a native transport label; native version observation does not enable provider recovery.
- `provider-recovery-host.js` and `session-changes-host.js` require an explicitly identified generation-2 client or getter. They use projected session, history, status, interaction and catalog operations; unsupported identities fail closed without HTTP fallback. Streaming read options preserve the 16 MiB response limit, cancellation/deadlines and change-host response metrics, with a second bound on projected records. Recovery retains its 32 MiB transcript and existing owner/conformance gates. Native file Undo/Redo requires `restoreOwned`; status omission never grants filesystem mutation authority.
- `session-revert-coordinator.js` accepts only conversation-only native markers under its existing ledger transaction. Imported history/blob readers remain inspectable; old receipt-only or interrupted compatibility records cannot authorize native markers or file publication. They refuse mutation or require explicit recovery instead of replaying the retired companion path.
- Managed continuation ownership across providers: the same primary controller reserves a real-user-scoped continuation before dispatch. `lib/objective-identity.js` recognizes maintenance without replacing the user anchor; `lib/objective-progress.js` persists exact pre-execution rejection limits and report-only progress evidence. Collection does not spend repair attempts. Transport replay remains separately provider/conformance gated.
- `lib/builder-todo-continuation.js` admits managed Builder nudges only when current canonical open TODOs match a completed native write since the objective anchor. Hashes, stagnation and structural-progress watermarks persist in the existing recovery record; two unchanged nudges exhaust stagnation allowance without changing the objective's total budget. The host fetches current TODOs only for this admission path. Missing owner records require a new real user instruction and emit `managed_objective_unavailable`.
- Derived task checkpoints and project-scoped canonical user decisions: `lib/task-context.js`. Overlapping checkpoint reads share only an exact session/directory/project/query key; each caller rechecks scope and its own write authorization before committing. Existing atomic record stores hold bounded, regenerable task views and provenance/validity-qualified decisions; neither view authorizes execution or replaces native history. Compaction anchors spend their 12 KiB final budget on the objective and mandatory scope before optional detail, retain incomplete-scope guidance, and pass the remaining encoded budget to the child assignment owner.

- Atomic private persistence and cross-process file locking: `lib/atomic-file.js`, `lib/record-store.js`. Replacement permissions and directory flush failures propagate; published bytes remain for recovery when durability cannot be confirmed. JSON quarantine flushes both affected directories. Windows requires a native durable publication owner and cannot qualify through suppressed POSIX flush errors. `lib/windows-private-files.js` parses strict native identities and binds private read bytes to one SDK handle. Windows execution receipt reads require the constructor-owned launcher; remaining recovery/storage callers stay held until they receive that owner.
  Windows cross-process locking accepts a constructor-owned `windowsLauncher`
  and reuses the SDK keeper in `lib/execution-host-owner.js`; it requires a
  protected private parent/file, retains kernel ownership, reports keeper loss,
  and confirms graceful release. It never steals a lock using stale PID bytes.
  Native architecture checks and storage/updater constructor composition remain
  separate gates from this primitive.
  Native private publication retains exact parent/file identities, content
  hash/size, nonce-bound intent and backup across compare-and-swap replacement,
  deletion and quarantine. `record-store.js` routes Windows deletion through
  that owner; corrupt JSON uses owned quarantine rather than Node rename/unlink
  or mode-bit repair. Namespace durability errors remain visible. Completed
  backups/receipts have a bounded native pruner that preserves current recovery
  proofs and removes historical artifacts by retained identities. Actual native
  cleanup and namespace durability remain qualification gates.
  `lib/windows-private-files.js` validates bounded native file identity receipts
  and routes exclusive execution-root and policy creation through the Windows
  SDK owner. Existing unowned/widened ACLs are refused, never repaired. This
  private adapter grants no execution admission; Windows durability, locks and
  publication still require independent native qualification.
- Host storage layout: `lib/paths.js`
- Turn correlation: `lib/lifecycle.js`
- Worktree receipts: `lib/worktree-bootstrap.js`
- Worktree post-checkout execution: `lib/git-post-checkout-hook.js`
- Session attribution: `lib/session-id.js`. Exact DevRyan-owned managed-task events resolve to their root and establish their canonical child relation even when native session-created history has expired. Conflicting explicit session IDs and unknown ownership cannot add child scope; same-directory foreign roots remain excluded from task exports.
- Hot-event trim/coalescing policy: `lib/journal-trim.js`
- Sanitization/session-partitioned journal/export: `lib/sanitizer.js`, `lib/journal.js`, `lib/export.js`
  Windows journal bytes and mutations use `lib/windows-journal-files.js` with
  native 64 KiB append batches and a 16 MiB file/read ceiling. Legacy
  truncation/rename and gzip deletion preserve the captured byte/identity
  compare-and-swap proof; staged clear uses private tree transitions. Node
  enumerates metadata only, and this adapter grants no execution admission.
  This does not qualify the separate
  managed orchestration ledger's actual Windows execution. Its constructor now
  owns a kernel keeper and explicitly bounded 64 MiB native atomic adapter;
  keeper loss fences subsequent mutations and shutdown drains queued writes
  before confirmed native release. Native durability and bundle/credential
  composition remain held behind existing Windows core admission.
  Native request/compaction evidence uses the finite shared `native-observation`
  contract, stable hashed directory witnesses and dedicated journal/export
  projection. Prompt/reasoning content and arbitrary provider options remain
  excluded; malformed evidence becomes a journal gap.
  Question settlement records retain request IDs for exact asked/replied correlation; credentials remain excluded.
  Bot event connection records retain subscription correlation, snapshot bytes,
  stage/timing and safe failure metadata through a narrow content-free allowlist.
- Git evidence: `lib/evidence-git.js`, `lib/evidence-ledger.js`,
  `lib/evidence-runtime.js`
- Diagnostic export selection/ZIP adapter: `lib/export.js`
- Bounded Chrome Trace projection and evidence-qualified measurements: `lib/trace.js`; included as `DevRyan-trace.json` in existing exports. Journal aggregation preserves distinct causes and generations; retention writes its eviction reason before deletion. See `docs/HARNESS_OPTIMIZATION.md` for gates, compatibility and measurement limits.

- Rejected historical-receipt memoization remains in `lib/session-changes.js`; `lib/bounded-read-pool.js` bounds and shares authenticated host summary reads. `lib/managed-collection-continuation.js` validates the narrow transport-failure collection proof; `provider-recovery.js` persists and reconciles wake identity before dispatch.

- Windows mutation/Revert storage and read-only execution roots require the constructor-owned `WindowsPrivateFileOwner`: create protected directories before acquiring native locks or launching workers; POSIX mode bits never establish Windows privacy. Working directories in empty control views and provider views are native-created, and owner refusals propagate without repairing foreign ACLs.

- `lib/session-execution.js`, `lib/session-execution-owner.js` and `native/` own native confinement, process termination receipts and publication ownership. `lib/session-mutations.js` and `lib/session-revert-coordinator.js` share durable operation decisions with file Undo/Redo. See [Concurrent Revert](../../docs/CONCURRENT_REVERT.md).

- `lib/execution-admission.js`: scoped admission deadlines, cancellable queue waits, preparation checkpoints and sanitized phase diagnostics. Bounded `toolOrigin`, `executionTier` and `fallbackReason` enums identify native/custom execution; preparation timing uses existing `elapsedMs` phase summaries, never tool contents. `withExecutionSummary` journals the same step summary for work that must not gain a deadline (the host's `direct_finish`); `executionStep`/`timedExecutionStep` add timing-only steps (the session-changes queue) that never check cancellation. Durable publication retains ownership through settlement.

- Context projection trace metadata separates planned/applied reductions, summary/checkpoint phases and transform duration from unavailable final-wire sizes; production exports contain no conversation bodies.

## Execution preparation v2

- `lib/execution-io-pool.js` owns four fair per-project preparation slots. `lib/execution-admission.js` separates bounded admission from supervised preparation and cancellation settlement.
- `lib/session-mutation-files.js` streams file observation/materialization; observation hashes before copying, so known content is never rewritten. `lib/object-durability.js` defers the objects-directory sync to the next ledger commit (`session-changes-store.js` commit). Text up to 8 MiB retains granular ownership; larger text and binary files retain whole-content ownership with independent modes. Conflicts live outside normal revisions and remain explicit through Revert.
- `lib/session-mutations.js` reserves before observation, pins the reconciled base durably, shares immutable listings and materializes outside the project lock. A view the preparation created is filled by `createViewMaterializer` (`lib/session-mutation-files.js`: per-preparation directory memo, exclusive in-place clones; `DEVRYAN_VIEW_FAST_MATERIALIZE=0`), and identical-content re-stamps install in large batches (`DEVRYAN_LEDGER_RESTAMP_BATCH=0`). Trusted control leases use empty views; they cannot claim a process launcher. `lib/session-changes-receipts.js` streams trusted in-process receipts into Git.
- `lib/execution-host-owner.js` and the native supervisor prove host lifetime through an OS lock. Cleanup requires terminal state, no consumers and verified writer termination; it preserves receipts, conflicts and live base refs.

- Preparation observers share actual progress meters across admission contexts and bound both observation retry causes to four passes. `workspace_changing` preserves both stamp and ledger guards. Terminal leases remain discoverable through `pendingCleanup`.
- `lib/execution-cleanup.js` removes settled private directories without following symlinks and reports deferred cleanup without masking publication. Snapshot identities commit before their ref is installed. Host initialization only retries after reaping the failed keeper; recovery isolates individual lease failures.
- Owned worker adapters may supply `inputForLease` to finalize immutable input after preparation but before process launch; the returned `workerInput` is the exact checked input for interactive transports.

## Execution preparation v3 (companion 2.1.0)

- `lib/session-mutations.js` `admitDirect`/`finishDirect` record one direct receipt for a built-in read, glob, grep or skill: a lock-free admission snapshot (generation, cancellation, existing call) and one idempotent locked commit that writes the call, operation and a published lease, fenced on the admitted generation. A crash before the commit leaves the call `uncertain`.
- `warm({ directory, maxFiles, maxBytes })` builds a project's first ledger in the background (skipping non-Git directories, the home directory, built ledgers, an unavailable listing, and trees over 20k eligible files or 512 MiB ingested). It is one best-effort pass that never certifies a real call's observation: a real call waits for it, then runs or joins an authoritative pass. Walks classify gitignored directories as inputs (linked into views, never ingested; dependencies read-only, output folders written through on macOS; the lease persists them as `inputs`) and yield to the event loop between levels and batches. `mutationDiff`/`applyMutationText` bound their synchronous work and fall back to coarser, exact replacements. `maintainLedger` converts inline baseline runs to content references (`DEVRYAN_LEDGER_BASELINE_REFS=0`), packs the private Git store in the background and prunes unreachable loose objects after each pack (`DEVRYAN_LEDGER_PACK=0`); the store's `prefixIdentities` checks many subtrees in one listing.
- First builds install observed rows in larger batches, carry parsed state between batches and skip empty-document scans (`DEVRYAN_LEDGER_FAST_INGEST=0`); parsed records are cached by immutable tree identity (`DEVRYAN_LEDGER_RECORD_CACHE=0`, `DEVRYAN_LEDGER_SNAPSHOT_REUSE=0`); ancestor symlink checks are memoized per pass (`DEVRYAN_LEDGER_ANCESTOR_MEMO=0`).
- `lib/execution-inputs.js` owns input policy: the dependency names that are always inputs, and which ignored inputs the macOS profile writes through (`writableInputDirectories`, kill switch `DEVRYAN_IGNORED_WRITE_THROUGH=0`). `lib/session-execution.js` exports the durable per-session `DEVRYAN_SESSION_TMP` inside the execution cache (`sweepSessionTemporaryDirectories`).
- `lib/session-execution.js` gives every confined worker `OPENCODE_DISABLE_LSP_DOWNLOAD=true`, so download-backed language servers are not rebuilt in each scratch cache (`DEVRYAN_WORKER_LSP_DOWNLOAD=1`). On macOS it also gives each execution a short private `XDG_RUNTIME_DIR` (`/tmp/dr-<uid>/<digest>`; the only local sockets the profile can reach besides the resolver), removed at cleanup or by `sweepExecutionSocketDirectories`. Session-scoped macOS executions get the host Playwright cache, a Node preload restoring the spawn adapter, and the single Chromium rendezvous mach lookup (`DEVRYAN_WORKER_BROWSERS=0`). The same preload names the group of each detached child and delivers `process.kill(-pid)` through the launcher, so a command that stops its own dev server ends instead of waiting for the task deadline (`DEVRYAN_WORKER_GROUP_SIGNALS=0`; `native/codemap.md`).
- `lib/session-changes.js` treats a confined publication's byte-exact receipt as the authority for its call: receipts rebuilt from tool metadata (plugin after hook, canonical part events, history replay) fill gaps only, and a confined receipt replaces them (`DEVRYAN_CONFINED_RECEIPT_AUTHORITY=0`).
- `lib/usage.js` continuity separates provider cache resets to the shared-prefix floor from partial breaks within the warm gap.
- `lib/host-stall-clock.js` measures the time this process's event loop did not run (a 250 ms ticker that fires 1 s or more late). Local deadlines count only time the host could run, each with a wall-clock cap: the admission idle limit (25 s, capped by the 50 s admission), the preparation stall (60 s, cap 180 s), cleanup (5 s, cap 60 s) and, in the web host, the lost-poller watchdog (60 s, cap 180 s, never while a poll is being answered). `DEVRYAN_STALL_AWARE_DEADLINES=0` restores wall-clock deadlines. The web host journals every stall of 2 s or more as lifecycle `host_stall`.
- `lib/execution-idle-watchdog.js` samples the process table every 30 s while a confined process call runs and ends the leaf processes of a supervised group that used less than 0.5 % of one core for ten minutes, so their parents finish and return their output. A group that contains an explicit `sleep` is left alone; it never delays or limits a launch (`DEVRYAN_EXECUTION_IDLE_WATCHDOG=0`, `DEVRYAN_EXECUTION_IDLE_MS`).
- `lib/session-changes-tools.js` observes an `apply_patch` envelope only at the files its headers name (`*** Add File`, `*** Update File`, `*** Delete File`, `*** Move to`) instead of snapshotting the whole project before and after the call; any other patch format keeps the whole-project observation (`DEVRYAN_PATCH_CAPTURE_PATHS=0`).
- `lib/provider-recovery.js` polls only what it can act on: a progress cutoff is evaluated only for a record this runtime enforces, an unfinished recovery's fallback poll backs off from 5 s to 5 min while the record is unchanged (its events still settle it at once), and a failed observation no longer marks the recovery storage unhealthy (only a failed store write does). `DEVRYAN_RECOVERY_ADVISORY_PLUGIN=0` restores the one-second poll of every record.

`execution-admission.js` exposes the remaining request budget for bounded host polls; completed workspace enumeration, stamp checks and reconciliation batches advance preparation progress. Typed stall and cleanup failures remain distinguishable in diagnostic phases.

- Native shell notification binding retains an immutable schema-encoded completion
  item hash and delivery from the exact sealed preflight in the existing process
  lease. Replacement shell recovery verifies that proof with the fresh terminated
  confined process receipt; SDK event retention is optional and supplies no shell
  authority. Earlier leases without this proof remain closed for automatic replay.

- Automatic native retention uses an exact current-boot marker on the existing admission hold. `beginNativeRemoval` may atomically transfer that sole hold into a quiet removal intent. Only an own preparing quiet intent with no disposition/removed member may be abandoned; committed removals retain the existing member-generation and native ACK recovery contract. No retention scheduler or separate authority store is introduced.

Queued native primary admission captures the existing controller cancellation epoch before enqueue and forwards its final write guard through the host. Stop/supersede during awaited callbacks fences the write; the guard permits only admission's own single invalidation. No new execution grant or durable queue owner is introduced.
