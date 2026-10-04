# packages/web/server/lib/orchestration/

## Responsibility

Web/Electron owner adapter for the transport-neutral DevRyan-managed task scheduler.

## Files

- `parent-read-freshness.js`: host-owned before/after native read identities and existing-target mutation admission. Reads overlapping possible child writes are provisional; unavailable or stale identities require refresh. New-file creation remains valid. This does not classify arbitrary shell effects or replace native freshness checks.
- `required-check-observer.js`: exact declared native command and effective-workdir matching, canonical call/message identity and numeric exit receipts tied to bounded file manifests. All matched names reserve atomically before canonical identity lookup; explicit start/bind/complete phases reject superseded or conflicting identities. Missing hooks, raced files, lost pre-execution hashes and stale leases remain unverified.
- `runtime.js`: composes one scheduler, overlays the durable root owner's
  personal-or-host agent execution before admission and retry/resume agent
  changes, preserves explicit plan-safe and Model Recovery attempts, rejects
  unsupported read-only providers and implementation-only Designer dispatch,
  acquires cross-process persistence ownership before bridge/recovery startup,
  suppresses non-owner recovery, safely projects ownership conflicts, handles
  validated 25-second maximum wait slices, eager/reference result projection
  and scoped stateless `read_result` paging, barrier inspection and confirmed
  agent handoff, atomic parent-recovery continuation claims, external-runtime gating, event publication, and exact-owner
  shutdown. It wires the scheduler's automatic-resume hooks (`resolveOwnerKey`,
  `resolveBackupExecution`, `resolveProviderReset`, and an `attempt` that re-enters
  the acknowledge RPC under an internal context, with quota/transport backup configuration/catalog revalidation and bounded replanning after selection changes and a 90-second quota catalog deferral window), exposes the scoped
  `set_auto_resume` RPC, and cancels plans on `session.deleted` events. Optional `auxiliaryRpcHandlers` dispatch named bridge methods before
  scheduler initialization or availability gating, so lightweight private
  integrations can reuse the loopback bridge without touching managed-task state.
- The same private runtime negotiates `harness_capabilities`, `wait_any`, `watch_result_commits`, `parent_tool`, `required_check`, compact result headers and context metadata. Commit watches notify the existing collection owner; unchanged transport slices never create model turns. Runtime flags and rollback contracts are documented in `docs/HARNESS_OPTIMIZATION.md`.
- `atomic-ledger.js`: private atomic JSON persistence with an exclusive heartbeat owner lock, dead-process recovery regardless of heartbeat age, per-operation token fencing, legacy dispatch-group hydration, and corrupt-ledger quarantine.
- `open-code-executor.js`: typed native OpenCode transport and Cursor SDK routing for the shared executor state machine, including per-executor status single-flight scoped to directory, runtime start identity and native event URL. A cancelled observer detaches without aborting other status waiters; replaced-runtime responses are refused, transcript requests retain their budget with caller cancellation, and cross-owner stale-child abort/deletion cleanup and reserved recovery POST cancellation remain owned by the shared executor.
- `application.js` resolves local managed dispatch and the private agent-execution RPC through the same saved project agent/model/variant resolver; cloud dispatch retains its account owner. Missing local agents or models refuse before scheduler admission, without borrowing the parent execution. `application-managed-agent-model.test.js` executes those original composition closures and the existing core catalog refusal.
- Default agent/model catalog reads require an explicit native client. Missing, legacy or unknown identities never fall back to raw HTTP; typed catalog errors retain their admission/recovery semantics.
- Native child create/prompt calls use the constructor-only `nativeTaskDispatch` adapter. Its `runtime.verifyNativeTaskDispatch` proof rereads persistence ownership, the scheduler's cancellation-aware lease, child identity and saved execution tuple. Neither the verifier nor lease metadata is exposed as a public RPC or native request-body authority.
- Native deletion uses constructor-only `cancelSessionsForRemoval`: a fence closes dispatch, retry and auto-resume for the exact session set; settlement requires actual native termination or separately verified prior deletion. The executor still closes its observers, tasks become terminal and uncollected results are abandoned. The native mutation ledger owns durable removal and restores these scheduler fences on restart.
- The composed native transport captures host-construction async context. Deferred child registration, observations and cleanup therefore cannot inherit a completed parent tool's permit; create/prompt calls still acquire fresh scheduler-bound native authority. Construct the executor during host setup, outside model/request contexts.
- `private-host.js`: authenticated IPv4-loopback RPC listener with bounded bodies and deterministic close. After bearer admission, its host-supplied action authority checks canonical current root Orchestrator ownership before model delegation, collection or context actions; Builder tool access is limited to separately authorized selected-plan actions. Internal recovery/compaction hooks and trusted UI actions retain their existing admission paths.
- `provider-reset-probe.js`: the scheduler's `resolveProviderReset` hook for Anthropic-routed children — resolves the loopback Meridian proxy (shared quota resolver, per-directory cache) and reads its raw quota buckets into `{ limited, resetAt }`, cached per proxy for 60 s with single-flight; null for external runtimes, other providers, or failures.
- `routes.js`: authenticated UI snapshot, task, cancellation, acknowledgement, auto-resume toggle, and Orchestrator-to-Builder handoff endpoints.
- `*.test.js`: focused owner, transport, persistence, security, and lifecycle coverage.

## Integration

The owner feeds canonical and Cursor synthetic message events into the shared
assistant-activity registry, preserving directory scope. Executors subscribe
before prompting and publish their first output through ordinary progress
updates. The server journals `managed_task.first_assistant_activity` once per
successful attempt stamp, with content-free identity and detection-source fields.
The same canonical event feed separately wakes healthy child completion waits
on session status/terminal/user and reconnect hints. Events do not establish
completion; canonical reads and the existing bounded reconciliation backstop
remain authoritative. Stream deltas do not trigger repeated status reads.

`packages/web/server/index.js` creates this runtime before OpenCode bootstrap, registers its UI routes, supplies its private environment to `lib/opencode/lifecycle.js`, publishes synthetic managed events, and disposes the owner through `lib/opencode/shutdown-runtime.js`.

- Private `verify_recovered_collection` RPC resolves the caller's task scope before returning scheduler proof to the primary recovery adapter. It is not a model-facing tool or public UI endpoint.
