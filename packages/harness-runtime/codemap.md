# packages/harness-runtime/

## Responsibility

Dependency-free shared Node runtime for durable DevRyan harness state,
diagnostics, lifecycle correlation, worktree operations, and optional turn
evidence. Web/Electron are hosts; the renderer consumes only host
API contracts.

## Where to change things

- Journal compression in `lib/journal.js` uses asynchronous zlib inside the existing bounded serial writer. Per-bucket rotation is single-flight so writes cannot reopen a segment while its compressed replacement publishes. Shutdown drains the writer and rotations; active plain segments retain crash recovery.

- Retained request/step/message accounting and purpose cohorts: `lib/usage.js`. Shared normalization lives in `packages/shared-runtime/lib/usage-observation.js`; `lib/sanitizer.js` attaches the optional contract to final runtime events, and `lib/export.js` includes `DevRyan-usage.json`. Exact title diagnostics preserve deleted-helper attribution in `lib/session-id.js`. See `docs/CACHE_EFFICIENCY.md`.

- Selective mutation ownership: exported `lib/session-mutations.js` and internal
  `lib/session-mutation-text.js`, with immutable bases, replacement ancestry,
  generation fences and recoverable publication receipts. Exported
  `lib/session-revert-coordinator.js` coordinates conversation boundaries,
  acknowledged target-tree cancellation and the durable commit decision.
  `lib/session-execution-owner.js`, `lib/session-execution.js` and
  `native/session-execution.c` and `native/session-execution-windows.c` own the
  native confinement boundary. The host connects captured writers and file
  Undo/Redo only after verifying matching accepted artifacts. Contracts are in
  `docs/CONCURRENT_REVERT.md`; platform verification is recorded in
  `docs/audits/2026-09-20-concurrent-revert/README.md`.

- Session-owned tool captures, cumulative revisions, stored diffs and conflict-checked restore: `lib/session-changes.js`; authenticated host HTTP/plugin adapter: `lib/session-changes-host.js`. `lib/session-changes-tools.js` owns shared tool/receipt normalization; `lib/session-changes-receipts.js` persists exact evidence and immutable segments. Snapshot observations never establish ownership. Call-scoped repair, monotonic exact evidence, retained descendant lineage and pending reconciliation are covered by `lib/session-changes-recovery.test.js`; the host acknowledges private Cursor execution receipts after persistence. `lib/session-changes-git.js` streams Git I/O; `lib/session-changes-snapshot.js` owns scoped capture and the bounded stat cache; `lib/session-changes-store.js` owns individually indexed metadata and atomic publication. `lib/session-changes-scale.test.js` covers large capture, pagination, migration and collection. See `docs/SESSION_CHANGES.md`.

- Primary OpenAI/Claude liveness, provider mode/conformance gates, durable attempt/cancellation fences and read-only recovery: `lib/provider-recovery.js`, `lib/provider-recovery-policy.js`; shared host HTTP adapter: `lib/provider-recovery-host.js`.
- Managed continuation ownership across providers: the same primary controller reserves a real-user-scoped continuation before dispatch. `lib/objective-identity.js` recognizes maintenance without replacing the user anchor; `lib/objective-progress.js` persists exact pre-execution rejection limits and report-only progress evidence. Collection does not spend repair attempts. Transport replay remains separately provider/conformance gated.
- `lib/builder-todo-continuation.js` admits managed Builder nudges only when current canonical open TODOs match a completed native write since the objective anchor. Hashes, stagnation and structural-progress watermarks persist in the existing recovery record; two unchanged nudges exhaust stagnation allowance without changing the objective's total budget. The host fetches current TODOs only for this admission path. Missing owner records require a new real user instruction and emit `managed_objective_unavailable`.
- Derived task checkpoints and project-scoped canonical user decisions: `lib/task-context.js`. Existing atomic record stores hold bounded, regenerable task views and provenance/validity-qualified decisions; neither view authorizes execution or replaces native history. Compaction anchors spend their 12 KiB final budget on the objective and mandatory scope before optional detail, retain incomplete-scope guidance, and pass the remaining encoded budget to the child assignment owner.

- Atomic private persistence and cross-process file locking: `lib/atomic-file.js`, `lib/record-store.js`
- Host storage layout: `lib/paths.js`
- Turn correlation: `lib/lifecycle.js`
- Worktree receipts: `lib/worktree-bootstrap.js`
- Worktree post-checkout execution: `lib/git-post-checkout-hook.js`
- Session attribution: `lib/session-id.js`. Exact DevRyan-owned managed-task events resolve to their root and establish their canonical child relation even when native session-created history has expired. Conflicting explicit session IDs and unknown ownership cannot add child scope; same-directory foreign roots remain excluded from task exports.
- Hot-event trim/coalescing policy: `lib/journal-trim.js`
- Sanitization/session-partitioned journal/export: `lib/sanitizer.js`, `lib/journal.js`, `lib/export.js`
  Question settlement records retain request IDs for exact asked/replied correlation; credentials remain excluded.
  Bot event connection records retain subscription correlation, snapshot bytes,
  stage/timing and safe failure metadata through a narrow content-free allowlist.
- Git evidence: `lib/evidence-git.js`, `lib/evidence-ledger.js`,
  `lib/evidence-runtime.js`
- Diagnostic export selection/ZIP adapter: `lib/export.js`
- Bounded Chrome Trace projection and evidence-qualified measurements: `lib/trace.js`; included as `DevRyan-trace.json` in existing exports. Journal aggregation preserves distinct causes and generations; retention writes its eviction reason before deletion. See `docs/HARNESS_OPTIMIZATION.md` for gates, compatibility and measurement limits.

- Rejected historical-receipt memoization remains in `lib/session-changes.js`; `lib/bounded-read-pool.js` bounds and shares authenticated host summary reads. `lib/managed-collection-continuation.js` validates the narrow transport-failure collection proof; `provider-recovery.js` persists and reconciles wake identity before dispatch.

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
- `warm({ directory, maxFiles, maxBytes })` builds a project's first ledger in the background (skipping non-Git directories, the home directory, built ledgers, an unavailable listing, and trees over 20k eligible files or 512 MiB ingested). It is one best-effort pass that never certifies a real call's observation: a real call waits for it, then runs or joins an authoritative pass. Walks classify gitignored directories as inputs (linked into views, never ingested; dependencies read-only, output folders written through on macOS; the lease persists them as `inputs`) and yield to the event loop between levels and batches. `mutationDiff`/`applyMutationText` bound their synchronous work and fall back to coarser, exact replacements. `maintainLedger` packs the private Git store in the background and prunes unreachable objects (`DEVRYAN_LEDGER_PACK=0`).
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
