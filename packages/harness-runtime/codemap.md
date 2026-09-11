# packages/harness-runtime/

## Responsibility

Dependency-free shared Node runtime for durable DevRyan harness state,
diagnostics, lifecycle correlation, worktree operations, and optional turn
evidence. Web/Electron are hosts; the renderer consumes only host
API contracts.

## Where to change things

- Unexported concurrent-revert implementation work: `lib/session-mutations.js`
  and `lib/session-mutation-text.js`, with adjacent disposable tests. These are
  not connected to host routes or execution adapters. Required integration and
  confinement contracts are tracked in
  `docs/audits/2026-09-09-concurrent-revert/README.md`.

- Session-owned tool captures, cumulative revisions, stored diffs and conflict-checked restore: `lib/session-changes.js`; authenticated host HTTP/plugin adapter: `lib/session-changes-host.js`. `lib/session-changes-tools.js` owns shared tool/receipt normalization; `lib/session-changes-receipts.js` persists exact evidence and immutable segments. Snapshot observations never establish ownership. Call-scoped repair, monotonic exact evidence, retained descendant lineage and pending reconciliation are covered by `lib/session-changes-recovery.test.js`; the host acknowledges private Cursor execution receipts after persistence. `lib/session-changes-git.js` streams Git I/O; `lib/session-changes-snapshot.js` owns scoped capture and the bounded stat cache; `lib/session-changes-store.js` owns individually indexed metadata and atomic publication. `lib/session-changes-scale.test.js` covers large capture, pagination, migration and collection. See `docs/SESSION_CHANGES.md`.

- Primary OpenAI/Claude liveness, provider mode/conformance gates, durable attempt/cancellation fences and read-only recovery: `lib/provider-recovery.js`, `lib/provider-recovery-policy.js`; shared host HTTP adapter: `lib/provider-recovery-host.js`.
- Managed continuation ownership across providers: the same primary controller reserves a real-user-scoped continuation before dispatch. `lib/objective-identity.js` recognizes maintenance without replacing the user anchor; `lib/objective-progress.js` persists exact pre-execution rejection limits and report-only progress evidence. Collection does not spend repair attempts. Transport replay remains separately provider/conformance gated.
- `lib/builder-todo-continuation.js` admits managed Builder nudges only when current canonical open TODOs match a completed native write since the objective anchor. Hashes, stagnation and structural-progress watermarks persist in the existing recovery record; two unchanged nudges exhaust stagnation allowance without changing the objective's total budget. The host fetches current TODOs only for this admission path. Missing owner records require a new real user instruction and emit `managed_objective_unavailable`.
- Derived task checkpoints and project-scoped canonical user decisions: `lib/task-context.js`. Existing atomic record stores hold bounded, regenerable task views and provenance/validity-qualified decisions; neither view authorizes execution or replaces native history.

- Atomic private persistence and cross-process file locking: `lib/atomic-file.js`, `lib/record-store.js`
- Host storage layout: `lib/paths.js`
- Turn correlation: `lib/lifecycle.js`
- Worktree receipts: `lib/worktree-bootstrap.js`
- Worktree post-checkout execution: `lib/git-post-checkout-hook.js`
- Session attribution: `lib/session-id.js`. Exact DevRyan-owned managed-task events resolve to their root and establish their canonical child relation even when native session-created history has expired. Conflicting explicit session IDs and unknown ownership cannot add child scope; same-directory foreign roots remain excluded from task exports.
- Hot-event trim/coalescing policy: `lib/journal-trim.js`
- Sanitization/session-partitioned journal/export: `lib/sanitizer.js`, `lib/journal.js`, `lib/export.js`
- Git evidence: `lib/evidence-git.js`, `lib/evidence-ledger.js`,
  `lib/evidence-runtime.js`
- Diagnostic export selection/ZIP adapter: `lib/export.js`
- Bounded Chrome Trace projection and evidence-qualified measurements: `lib/trace.js`; included as `DevRyan-trace.json` in existing exports. Journal aggregation preserves distinct causes and generations; retention writes its eviction reason before deletion. See `docs/HARNESS_OPTIMIZATION.md` for gates, compatibility and measurement limits.
