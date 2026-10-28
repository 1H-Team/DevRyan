# Web Managed Orchestration

Native model RPCs capture `maxOutputBytes` from their reviewed configuration generation. Result projection bounds the escaped serialized output, including metadata and references. Submit and disposition reserve receipt capacity before scheduler mutations; disposition also checks the current retained projection first. If projection fails after a durable mutation, the tool returns a bounded `committed` receipt with the exact task/envelope/action identities and an enumerated projection failure. Callers must read current status rather than repeat a committed operation as new work. Ordinary UI/API reads retain their existing eager shape.

Managed model admission retains provider/model/variant refusal reasons and records `managed_model_validation_failed` for every provider before scheduler admission. Records include the bounded model tuple and root/agent/task/tool-call identities when available; unsupported variants keep the existing 409 compatibility code with `details.reason: variant_missing` and an actionable Settings message. Unreadable catalogs remain 503; injected boolean/null validators remain supported. No rejected selection creates a child or silently substitutes an effort.

Constructor-only `withSubmissionPreparation` resolves the exact agent/model tuple
outside the parent mutation lock. Its asynchronous local scope is consumed once
by the same serialized submission; it does not cache credentials, permits or
physical-use authorization. The locked commit rechecks captured Plan policy and
the live native invocation. Scheduler reservation and durable insertion both run
the constructor's authorization callback, so Stop or changed configuration during
preparation cannot leave a queued task. Child registration and the parent control
lease retain their existing mutation ownership. The executor's constructor-owned
`prewarmExecutionView` hint requests `prewarmView: true` for Cursor children
(including inspection-only Explorer) or children whose task may write
(`managedTaskMayWrite`: not Plan-mode read-only, not Explorer, Librarian,
Oracle or Council). Cursor's confined worker requires a private view even for
inspection. The hint grants no write capability and preserves read-only tool
policy. The execution host prepares that view in the background (best effort;
`DEVRYAN_CHILD_VIEW_PREWARM=0` disables it; see `prewarmView` in
`packages/harness-runtime/DOCUMENTATION.md`).

Native `status`, `wait`, `wait_any` and `read_result` use the constructor-owned
`withManagedResultRead` scope. It checks the exact managed-tool permit before and
after the read without retaining the parent mutation lock. Stop remains available
while a read waits; a revoked read cannot return data under stale authority.
Starts, cancellation and dispositions keep their separate mutation lock.

Version 2 model reads reserve response capacity across report pages, typed
metadata pages, references and batch framing. `read_result` accepts exact
task/cursor pairs; unreturned batch items remain explicit and require another
read. V2's raw page ceiling is 24 KiB; the full escaped JSON reply must still fit
`min(48 KiB, native byte limit - 2 KiB)`. V1 retains its 8 KiB ceiling. The native owner stages exact publication candidates only after a bounded
response is ready. It grants collection and later-Step review from canonical
completed native tool parts through the constructor reader, then supplies a
private final recheck to scheduler acknowledgement. JSON RPC parameters cannot
manufacture that review grant. Automatic continuation of clean `wait_any`
results (next call or session idle, see the runtime-host documentation) uses the
same later-Step review and private recheck; the idle path substitutes
root-Orchestrator authority, an idle session and a completed later step for the
live tool call. `context_state` also projects each task's `agent` and `createdAt`
for the plan-mode read advisory. The executor's event-driven child waits follow
`DEVRYAN_EVENT_DRIVEN_CHILD_WAIT`. Bulk continuation reserves lean receipt capacity
before each state effect and preserves committed truth if Stop or an observer
failure happens after a durable acknowledgement. Internal barrier/snapshot reads
do not apply the model cap to full retained sibling reports; only returned model
projections consume that cap.

Publication payloads remain freshly read on every review/staging check. The
current constructor reader has no immutable canonical-history revision receipt;
a primary revision alone does not prove that an earlier completed output stayed
unchanged. No whole-snapshot or authorization memoization is admitted. The v2 CPU/latency regression and the smaller transport-call improvement are retained.

## Purpose

Canonical OpenCode and Cursor synthetic message events feed the shared active-child
assistant-activity registry. It preserves directory scope and supplies the
executor's optional subscription hook without another SSE connection. First
reasoning, text or tool activity publishes the existing progress timestamp without
waiting for transcript polling. The content-free journal event
`managed_task.first_assistant_activity` identifies task, child, assistant message,
observation time and `event`/`transcript` detection source.

This module owns the single DevRyan-managed scheduler for the web server process. Electron inherits the same owner because it starts this web server in-process. Provider-native task events do not enter this module and are never counted or cancelled here.

## Ownership and startup

`runtime.js` composes the shared `@devryan/orchestration-runtime` scheduler with the web OpenCode transport, atomic ledger, synthetic-event publisher, and private tool host. `lifecycle.js` asks the runtime for bridge environment immediately before spawning managed OpenCode. The runtime must acquire the ledger's cross-process owner lease before it starts the private bridge or initializes recovery, so two web/Electron processes cannot manage the same data directory. A competing live owner fails closed with `managed_orchestration_owner_conflict`; snapshots remain empty and surface a sanitized warning without running scheduler recovery. OpenCode spawn continues without injecting the private bridge, so a leftover or competing owner cannot brick the rest of the app. Only `DEVRYAN_ORCHESTRATION_URL`, `DEVRYAN_ORCHESTRATION_TOKEN`, and the fixed capability marker `DEVRYAN_ORCHESTRATION_ACCOUNT_DEFAULTS=1` are injected; configured external OpenCode runtimes keep managed orchestration unavailable.

The private host binds `127.0.0.1:0`, requires a random bearer token, caps JSON input, exposes only `/rpc`, and is stopped before provider runtimes during graceful shutdown. URL/token values are never returned by diagnostics, UI routes, events, or routine logs.

Constructor-only native `settle` verification binds cleanup to the existing child,
provider/model/agent/variant and current scheduler attempt lease. It survives the
cancellation dispatch fence and an admission hold so final cancellation persistence
can complete, but never grants prompt/tool execution or an RPC capability. Terminal
tasks, removal fences, lost ownership and shutdown remain denied.

Private task-result RPCs accept `resultMode: "eager" | "reference"`; omission is eager for UI routes, Council, older plugins, and compatibility callers. Reference mode lazifies only a matching retained preview above 8,192 UTF-8 bytes and exposes the first page beside the existing wrapper. `read_result` requires exact task/root/directory scope plus the opaque `resultCursor`, performs no scheduler mutation, and returns only the next `resultReference`. Malformed cursors use `invalid_result_cursor` (400), retained identity/payload changes use `result_reference_mismatch` (409), and existing scope/result 403/404 errors remain authoritative. Snapshots and UI routes remain eager.

## Persistence and recovery

The atomic ledger reports content-free physical progress to its constructor
save observer: write completion, file sync, rename, directory sync and final
owner verification. Windows reports its native CAS commit as one physical
boundary. The scheduler's independent `managed_persistence` journal observation
can require attention while a save holds the mutation queue. It retains uncertain
write ownership and leaves terminal/action publication withheld until actual
settlement; a healthy process heartbeat does not count as write progress. This
diagnostic adds no task status or presentation threshold.

`withNativePromptContext` privately scopes that readonly barrier reader through
the current asynchronous constructor action. Only exact `barrier_status` reads
for its captured root and directory use it; other RPCs retain normal ownership.
Native Plan settlement includes directory in its request and still requires a
clear barrier, idle native statuses, settled process leases and current source,
controller/configuration and cancellation-generation checks. JSON parameters
cannot create a prompt context or turn the read into mutation authority.

Managed OpenCode retry status preserves optional structured action metadata. The shared executor treats the exact `action.reason: free_tier_limit` signal as immediate provider exhaustion, falls back to normalized usage-limit message wording for compatibility, and never waits for the provider's multi-hour `next` timestamp before exposing Model Recovery.

`atomic-ledger.js` writes `DEVRYAN_DATA_DIR/orchestration/ledger.json` through a private mode-0600 temp file, file sync, atomic rename, and best-effort directory sync. Saves are serialized and every load, save, and quarantine verifies the immutable owner token in `orchestration/owner.lock`. The lock is created with an atomic hard-link claim, heartbeats through file timestamps, and is released only after exact-token verification. A lock whose recorded process is confirmed dead is recovered immediately, even when its heartbeat is still fresh. A live owner is never stolen, including when the heartbeat looks stale. Unreadable locks are never stolen automatically. Shutdown drops the lock before waiting for an in-flight ledger save, and a process-exit handler unlinks the file only when this runtime still holds the matching token. Losing the token fences the former owner before further ledger access. Pre-barrier tasks missing `dispatchGroupId`, tasks predating exact dispatch correlation missing `dispatchCallId`, and tasks predating wave labels missing `dispatchWaveId` hydrate to `null`; tasks predating plan-mode propagation hydrate with `readOnly: false`. Invalid JSON, oversized input, duplicate identity, and task/result contradictions are moved to a timestamped `.corrupt-*` file before the scheduler starts from an explicit empty state. Reading accepts up to 64 MiB, well above the 20 MiB the scheduler writes, so a ledger a previous version grew is compacted instead of quarantined. A save that shrinks a ledger of at least 5 MiB to less than half first copies the previous file to `ledger.json.before-compaction` (mode 0600, only the first time, best effort); it may be deleted once the removed history is not wanted back. Runtime diagnostics expose only sanitized ownership state, while the UI snapshot receives only a safe warning; ledger content, owner PID/token, and quarantine paths remain private.

The shared executor records a child session before sending one queue-time provider/model/agent/variant snapshot. Web transport routes normal providers to managed OpenCode and Cursor to the existing Cursor SDK owner. Scheduler checkpoints confirm that the launch still owns its durable lease before prompting and after provider acceptance; a stale fresh child is aborted and deleted through OpenCode, with Cursor state cleaned through its SDK owner as well. Provider `busy` and transient `retry` status remains live, while definite usage/quota exhaustion, including an exhausted provider session allowance, settles as an immediately user-recoverable failure and starts bounded retry-loop cleanup. Transient status/message polling failures retry against the same child while retaining the last successful preview and references. A terminal assistant request, response-header, stream-idle, or connection transport failure receives one idempotent fixed continuation in the same child with the captured execution snapshot, without replaying the original task; restart reconciliation preserves the first failure for that recovery and a repeated transport failure settles normally. A managed `resume` observes a still-live canonical child or sends one transcript-marked continuation when it is already terminal; restart reconciliation relaunches only a missing continuation and never duplicates a recorded one. A temporary managed-port transition is typed as HTTP-style 503 unavailability; restart reconciliation keeps the task active and retries the same canonical child under its existing lease and deadline instead of emitting an interruption or replaying the prompt. Non-retryable observation failures become resumable interruptions instead of provider failures. The same shared prompt-tool policy used by the UI is applied to managed children, including both OpenCode names for Copilot's optional Resend MCP namespace. Every OpenCode-backed managed child prompt explicitly disables provider-native `task`, including initial execution and ordinary retry, resume, manual same-child model recovery, restart, and automatic continuations, so delegation remains root-owned even when an agent definition or task record is writable. A plan-mode parent turn additionally marks the private task read-only before admission and disables every mutation surface on each prompt. Native Cursor prompts use the same fresh managed task authority, derive read-only policy from the verified durable task, and restrict SDK tools to `read`, `grep`, `glob`, and `ls`. Hosts without that capability continue to refuse read-only Cursor dispatch.

Normal-provider status reads are single-flighted only while pending, using the exact fully resolved status URL as the per-executor key. Overlapping observers of the same port and normalized directory share one parsed status map without mutation; directory or port changes and every post-settlement poll create a new request. Cursor status never enters this path.

Plan-safe starts resolve the parent turn before provider selection. Designer is implementation-only, so the provisioned plugin rejects it from a read-only parent with `MANAGED_READ_ONLY_AGENT_UNSUPPORTED` before provider resolution or RPC. Both host owners and the shared scheduler repeat that guard before persistence, including recovery agent overrides, and the executor fails closed before child creation or same-child prompting. Native read-only specialists retain their configured Cursor selection under the restricted SDK capability. The compatibility plugin preserves their agent identity and prompt while using the active non-Cursor parent execution first or the configured non-Cursor Plan-agent execution second. If neither execution is available, the plugin rejects with `MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED`.

Every managed child start privately resolves the requested agent against the
root session's durable owner before plan-safe provider checks. Admission repeats
that resolution before persistence. Precedence is the owner's personal
single-model default, then the live host agent configuration; administrators
inherit the host directly. Retry/resume agent changes are re-resolved. An
already selected plan-safe fallback remains authoritative for that read-only
attempt, while explicit same-child Model Recovery choices are never replaced
or persisted. Council bypasses the account overlay and retains its shared host
roster. Missing ownership or assignment evidence fails closed instead of
guessing from the current browser.

## Contracts

The bundled Orchestrator maps broad goals into independent discovery questions,
including concerns within one subsystem, and dispatches bounded Explorer briefs
together. A single coherent concern keeps one Explorer. The parent synthesizes
paths, contracts, and unresolved gaps before presenting the plan; empty or failed
child output cannot ground it. Parallel implementation briefs name sibling
ownership and shared interfaces, preserving existing specialist ownership and
the optional late Oracle review gate.

Both managed tool registrations hide policy-disabled optional actions and their
arguments. The compatibility plugin follows inherited harness flags; the native
controller receives `waitAny` and `contextProjection` from the authoritative
scheduler projection. `DEVRYAN_CAPABILITY_TOOL_SCHEMA=0` keeps the full rollout
schema; existing host authorization and policy checks remain mandatory.
The static `harness_capabilities` projection does not initialize the scheduler,
acquire ledger ownership, or reconcile children. Native startup can read it before
controller readiness; stateful scheduler RPCs still require initialization.

Version-2 result projections inline as much of the first 24 KiB report page as
the reply budget fits. `wait_any` fits every selected result's metadata first,
then spends the remaining budget on first pages in selection order. It skips a
page shorter than 1 KiB, which `read_result` delivers instead. A complete inline
page needs no `read_result`. These projections omit the per-result
`capabilities` copy; only the `wait_any` reply keeps one top-level copy. They
also drop scheduler bookkeeping the model never acts on: owner, sequence, wave
and lineage identities, creation and timeout times, child timing and transport
recovery. Version 1 keeps its full projection.

Submission carries the private caller's cancellation signal through exact agent
and native catalog validation to the scheduler's pre-persistence gate. Native
authority errors retain their bounded code and status, with a code-only public
message. Unconfirmed process termination retains its explicit marker and maps to
`native_process_settlement_unconfirmed`; it cannot become unknown model evidence
or a successful late admission. Signals are omitted from authoritative scope
clones and remain local to the operation.

- Private tool RPC methods: `resolve_agent_execution`, `submit`, `status`, `wait`, `read_result`, `wait_result_action`, `list_provider_recovery_continuations`, `claim_provider_recovery_continuation`, `release_provider_recovery_continuation`, `barrier`, `barrier_status`, `handoff`, `cancel`, `snapshot`, `acknowledge`, and `set_auto_resume`. `resolve_agent_execution` is owner/directory scoped and returns only provider/model/variant plus safe source metadata. `wait` accepts an optional positive-safe-integer `waitTimeoutMs`, clamps it to 25 seconds, and forwards that polling slice without changing the task's execution deadline; omission preserves the legacy unbounded terminal wait. `read_result` returns a stateless page from the retained immutable preview and never acknowledges or mutates the task. `wait_result_action` remains a task/root/directory-scoped compatibility primitive that can observe a durable UI acknowledgement, but ordinary model-facing waits do not call it. `list_provider_recovery_continuations` retains its compatibility name and is private-host-only; it reports unacknowledged terminal grouped results as collectable `collect` entries. Parked Model Recovery results are omitted so the plugin cannot wake the parent to narrate or collect them; the envelope stays unacknowledged for the UI recovery card. Claim/release are task/root/directory scoped and give the packaged plugin one atomic 60-second parent-wake lease; a failed prompt releases it, while acknowledgement, compaction, shutdown, or expiry makes the task claimable or ineligible as appropriate. `barrier` is root-scoped, abortable, and remains unbounded while it waits for grouped children to become terminal before reporting result IDs that still need disposition. `barrier_status` is the non-blocking plugin gate, while `handoff` inspects or confirms the Orchestrator-to-Builder cleanup under a temporary root lock.
- Authenticated UI routes: `GET /api/orchestration/snapshot`, `GET /api/orchestration/task/:taskId`, `POST /api/orchestration/task/:taskId/cancel`, `POST /api/orchestration/task/:taskId/acknowledge`, `POST /api/orchestration/task/:taskId/auto-resume` (body `{ rootSessionId, directory?, enabled }`, answering `{ resultEnvelope }` or 409 `auto_resume_not_applicable` / `auto_resume_stale` / `result_already_acknowledged`), and `POST /api/orchestration/handoff`. The handoff route is inspection-first, requires an idempotency key for confirmed cleanup, returns valid operation states with HTTP 200, and exposes only safe task projections and generic per-task cleanup failures. Confirmed cleanup never abandons active work unless provider abort is authoritatively confirmed; rejection, timeout, and an explicitly declined abort remain blocked and retryable. Grouped Orchestrator tasks allow one ordinary agent `retry` or `resume`; a resumable failure after that attempt, like a first provider-limit failure, rejects every ordinary agent disposition with `manual_model_recovery_required` and HTTP 409 without acknowledging the envelope. A separately confirmed handoff may abandon that parked result through the scheduler's private cleanup capability so Builder can take ownership without weakening normal Model Recovery. A `provider_prompt_rejected` result instead rejects every same-child recovery and requires its single `retry` to provide a different prompt for a fresh child; a second rejection remains dispositionable but cannot create attempt 3. Only UI `retry_in_place` may acknowledge ordinary manual recovery, with an explicit provider/model/variant selection, and it reuses the canonical child. Non-resumable extra retry/resume attempts retain `managed_retry_limit_reached`. New `recover_in_place` acknowledgements are rejected while historical records remain readable. Web/Electron map both prompt-rejection policy errors to HTTP 409.
- Events: safe `openchamber:managed-task` projections omit prompt, idempotency key, the private dispatch-group value, private read-only policy, and lease token while retaining the originating `dispatchCallId`, the display-only `dispatchWaveId` the chat groups Agent Dispatch cards by, a non-secret `dispatchGrouped` policy boolean, live-policy `agentRetryAvailable`, and derived `failureKind`. Definite usage, session, quota, or rate-limit exhaustion projects the flag as false on the initial terminal attempt. Verified prompt rejection projects `provider_prompt_rejected`; authoritative model-not-found events project `model_unavailable`; scheduler-owned timeouts project `deadline_exceeded`. Canonical OpenCode ingestion feeds a bounded child-session terminal-error registry, and each start/resume/retry-in-place uses its own prompt boundary so stale events cannot settle later attempts. User Stops recorded through `recordOperatorAbort` (withdrawn by `withdrawOperatorAbort` when the abort was rejected) feed a bounded operator-abort registry with the same per-attempt boundary, so the executor settles a stopped child as `aborted` instead of continuing it. The host's `readRuntimeStartedAt` (the managed OpenCode spawn time; null for external runtimes and Cursor children) lets the executor interrupt children orphaned by an OpenCode restart. Directory-scoped `/config/providers` validation rejects an exact missing model before child creation when the catalog is readable and tolerates catalog transport failure for normal providers. Cursor exact-selection validation fails closed when discovery is unavailable. Native catalog discovery uses a private verified tool invocation; detached automatic recovery rechecks ledger ownership, task identity, active cancellation generation, and the current configured backup. Authorization refusals record a bounded `managed_model_validation_failed` reason without raw provider errors or credentials. Identity-only `openchamber:managed-task-removed` events mirror durable compaction so connected UIs release history immediately.
- Packaged OpenCode surface: one `devryan_task` tool multiplexes start/status/wait/cancel/continue/retry/resume/abandon to minimize provider tool-count pressure. The module exposes exactly one loader-visible factory, preventing OpenCode from instantiating duplicate recovery observers. On start its pre-execution hook captures the exact OpenCode `callID`, keeps parallel calls isolated even when execution order differs, and submits it as `dispatchCallId`; the scheduler projection can therefore replace a still-pending tool row even if the terminal tool-part update is missed. It also resolves the invoking assistant message and its exact parent user record; a synthetic plan-mode marker or authoritative plan metadata sets the private `readOnly` submit field, while an available message API that cannot resolve the parent fails closed. Every ordinary tool-driven wait stays attached while the plugin repeats 25-second private polling slices; live snapshots remain internal and only a terminal result returns to the parent model. A result requiring manual model recovery returns immediately with `manualRecoveryRequired: true` and remains unacknowledged while the UI presents Model Recovery. Parked results do not send a parent notice if a wait detaches; idle scans wake only collectable recovered work. Immediately before a synthetic wake, the plugin re-reads the candidate, skips acknowledged or compacted work, and atomically claims the task before prompt delivery. After the user selects a model and thinking level, the durable `retry_in_place` lineage runs in the same child; once it settles, the plugin double-checks that the root is idle and sends one marker-bearing synthetic continuation using the root's latest authoritative execution. Child idle/error edges start a bounded trailing-scan window so the observer and durable terminal commit cannot lose either notification; overlapping triggers coalesce without becoming a permanent poller. Start timeouts are constrained to 900–86,400 seconds. Web/Electron give focused Oracle reviews 15 minutes, accept an explicit 30-minute deep-review window, retain 60-minute Designer/Fixer floors, and keep 30 minutes for other ordinary specialists. Recovery attempts inherit at least the source task's original window; `timeout_seconds` on retry/resume may extend it but cannot reduce the agent floor. A hard timeout preserves its deadline cause, bounds provider-abort cleanup, and leaves an existing canonical child resumable when immediate recovery cannot read it. Council retains its private three-minute deadline. Runtime agent-catalog provider/model/variant choices remain authoritative over model-supplied IDs.
- Parent-model tool serialization keeps terminal task identity and lifecycle metadata but removes `recoverablePreview`, `failureReason`, and `canonicalRefs` from the task copy when they exactly match the result envelope. The complete envelope remains authoritative for acknowledgement and recovery. Divergent fields are retained fail-safely; `dispatchCallId` is the only additive task-correlation field in the scheduler, ledger, private RPC, UI event, and snapshot shapes. Because the bundled plugin is provisioned into managed web/Electron runtimes, this context reduction and correlation contract are shared across providers and shells.

The packaged orchestrator alone receives `devryan_task`. Builder, Council, Plan, and specialists explicitly deny it. Packaged Orchestrator sessions are managed-only: their prompt tool overlay sends `task: false`, their agent permission unconditionally denies provider-native `task`, and the managed plugin rejects any stray native-task execution before child creation or scheduler mutation. Project-defined non-Orchestrator agents retain their existing native-task contracts. Orchestrator starts carry the parent assistant message as a private dispatch group. The plugin's `tool.execute.before` gate permits `skill` alongside `devryan_task`, `todowrite`, and `todoread` until the scheduler barrier clears; synchronous pending-start registration prevents a start and work tool emitted in one assistant response from racing. A registration normally settles in the start tool's `finally`; if a later OpenCode pre-execution hook aborts the call before DevRyan's tool runs, the plugin settles the orphan only when OpenCode emits the authoritative `session.idle` lifecycle event. Known Orchestrator ownership remains gated, Builder direct tools bypass stale Orchestrator barriers without receiving graph mutation access, and unknown ownership under a locked barrier fails closed. Every result must be collected through `wait` before disposition, and successful results require `continue`. A known local or recovered barrier fails closed if its private bridge cannot be verified, while direct work remains available when no managed dispatch has ever been found. The orchestrator may consume partial managed output and perform at most one ordinary managed retry or resume when resumable. A provider-limit result or a resumable failure after that agent recovery leaves the barrier awaiting user acknowledgement and returns `manualRecoveryRequired` to the parent; the parent cannot discard it with `abandon` or truthfully report it as still running. The UI asks the user to select a model/thinking level and click Try Again; the recovered same-child terminal result then wakes the idle root exactly once for normal collection and disposition. Council's locally owned fanout stays ungrouped while using the private RPC when present, so all of its parallel children receive the same durable lifecycle and immediate admission without entering the primary-agent barrier. Without bridge environment, Council retains its existing direct behavior for external compatibility, and its separate three-minute councillor timeout is unchanged.

The packaged plugin adds `read_result` to that model-facing surface. Unset `DEVRYAN_MANAGED_RESULT_MODE` selects reference mode for `submit`, `status`, `wait`, `cancel`, and `acknowledge`; exact `eager` omits the parameter and preserves the previous eager serialization. The override is read when the plugin starts, so operators must restart managed OpenCode after changing it, and the override remains supported for at least one release. A terminal wait registers only its expected next cursor in process memory. Each `read_result` must match exactly, advances only after a valid page, never acknowledges the envelope, and leaves the collected result available for normal disposition. Reads before a terminal wait, repeated/reordered cursors, and reads after completion fail with `DEVRYAN_TOOL_INPUT_INVALID`; after plugin restart, another wait recreates the ephemeral cursor state from the retained terminal result. Internal recovery scans do not request reference mode.

If `status`, `wait`, or acknowledgement encounters `task_not_found`, the plugin reads both the root-scoped `snapshot` and `barrier_status`. Only an available, bridge-ready snapshot with no recovery warning and a well-formed clear barrier produces `state: "stale_task_reference"`, `dispositionRequired: false`, and a direction to continue from confirmed parent state without recreating the child. A retained terminal envelope whose action is already set produces `state: "already_dispositioned"` after restart and reports the current barrier rather than requiring a second acknowledgement. Active or unacknowledged tasks remain blocking and identify their current task IDs; unavailable ownership, warnings, bridge failures, and malformed responses preserve fail-closed `task_not_found` behavior. Successful `continue`, `retry`, `resume`, and `abandon` calls remove their local collected-result cache entries.

Managed OpenCode launches intentionally omit `--pure` and do not set `OPENCODE_DISABLE_DEFAULT_PLUGINS`: either switch suppresses the bundled managed tool itself. The generated runtime overlay remains the plugin allowlist owner, while prompt-scoped provider rules bound only the reproduced provider-specific tool surface.

While the host reports a work admission block (a harness prompt-admission hold
or a pending Supabase restart), new `submit` and work-launching result actions
(`retry`, `resume`, `retry_in_place`, and `recover_in_place`) return HTTP 503
with the block's code (`work_admission_blocked` when it names none); status, wait, cancellation, successful-result `continue`,
abandonment, and shutdown remain available so active work can drain. A
successfully completed result supplied with any action other than `continue`
returns `DEVRYAN_TOOL_INPUT_INVALID` together with the completed state and the
exact required next action. `retry` remains reserved for eligible failed
results.

## Automatic resume after a provider usage limit

The runtime wires the scheduler's `autoResume` hooks. `resolveOwnerKey` (default
`'local'`) keys provider breakers per account; `index.js` maps managed sessions
to `user:<id>` through the multi-user runtime. `resolveBackupExecution` (default
none) returns the agent's backup model: the host-managed backup for a managed
session, otherwise the packaged/local agent config via
`resolveLocalAgentBackupExecution`. `resolveProviderReset` (default none) is the
Meridian probe from `provider-reset-probe.js`: for Anthropic-routed providers on
a managed OpenCode runtime it resolves the loopback Claude proxy from
`/config/providers` (shared `createClaudeProxyBaseUrlResolver`, per-directory
cache) and reads `/v1/usage/quota`, answering `{ limited, resetAt }` from the raw
buckets (`rejected` status or 100% utilization); external runtimes, other
providers, a missing proxy, or a failed read answer null, and successful signals
are cached per proxy for 60 s with single-flight coalescing.

The `attempt` callback re-enters `handleRpcInternal` with the scheduler's
`retry_in_place` acknowledgement under an internal `{ autoResume: true }`
context. Every backup attempt, including quota recovery, revalidates the current configured model and thinking level plus model availability before acknowledgement. A changed or removed backup returns `backup_changed`: the scheduler replans immediately without spending a provider attempt, retains the same child and cancellation generation, and counts repeated changes toward the five-host-failure cap. Only that context forwards `autoResumeGeneration` to the scheduler, so
routes and the private bridge can never replay a stale generation. Planning excludes backups confirmed absent from the catalog. If a quota backup disappears between planning and dispatch, the host rejects it and replans toward the primary reset; transient unknown catalog availability defers 30 seconds without consuming provider attempts or host failures. These catalog checks stop after 90 seconds or when the primary reset arrives, then skip the unverified backup and retain primary reset/backoff scheduling. Transport recovery retains its single-backup and host-failure bounds. A work
admission block or any 503 answers `deferred` (30 s);
`auto_resume_stale`, `result_already_acknowledged`, and
`result_already_acknowledging` answer `started` without a follow-up because the
result already moved on; other errors answer `rejected`. `set_auto_resume`
(`{ taskId, rootSessionId, directory?, enabled }`) is the scoped user toggle,
and `session.deleted` OpenCode events cancel every active plan for that session
once the scheduler is initialized. The packaged plugin marks such results
`manualRecoveryRequired` with an `autoResume: { scheduled, state, nextAttemptAt, target }`
summary and an instruction to leave the result parked, so the orchestrator
ends with at most one brief status sentence. Recovery instructions and model-selection steps stay in the task card.

## Launch admission

No DevRyan host wires the scheduler's optional admission hook (`packages/orchestration-runtime` keeps it inert); sub-agent launches are never capped or held (user requirement, 2026-09-04). The scheduler admits every queued task immediately, in FIFO order.

## Testing

Run the module files under `packages/web/server/lib/orchestration/*.test.js`, the packaged managed-tool and Council plugin tests, the OpenCode lifecycle/shutdown tests, and `bun test packages/orchestration-runtime`. Runtime tests cover immediate one/three/five admission without a concurrency cap, root/barrier scope, result-action waiting and recovered lineage delivery, inspection and confirmed handoff cleanup, idempotent retries, grouped retry-limit conflicts, manual retry-in-place exemption, partial failure, bounded same-child transport continuation, ordinary 30-minute, Designer/Fixer 60-minute, and Oracle 15/30-minute start/follow-up deadlines, safe projection, legacy hydration, corrupt-ledger quarantine, atomic overlapping saves, exclusive two-process ownership, dead-process owner recovery, lost-token fencing, process-exit lock release, second-runtime recovery suppression, bearer/body rejection, normal/Cursor transports, same-turn plugin races, idle recovery for starts abandoned between pre-hook and execution, authoritative agent gating, fail-closed unknown ownership, external-runtime unavailability, and deterministic cleanup.

Managed native OpenCode prompts translate a captured `variant: null` into the
verified empty-string wire value that clears configured agent effort. Undefined
keeps omission, and explicit efforts pass through. Cursor SDK prompts retain
their existing adapter contract. This applies to starts and same-child
continuations, using the durable task's captured selection.

Plan-card implementation starts additionally verify a preceding visible implementation statement in the bundled plugin before creating a pending dispatch barrier or submitting work; no workflow skill is required. Unreadable history evidence fails explicitly. The policy is provider-neutral and leaves specialist-specific skills with the child.

## Transport recovery and automatic backup

The shared executor routes live provider connection errors through the same
settlement policy as transcript errors. The owner supplies durable recovery
checkpoints through its scheduler, and the HTTP adapter forwards cancellation to
recovery POSTs. Exact reserved message IDs are observed after ambiguous delivery;
they are never blindly resent. One same-model continuation may be followed by one
configured backup in the existing child session. Before automatic fallback the
owner rechecks the configured execution and catalog availability; unavailable
backups leave manual recovery. This policy uses `autoResume.trigger =
provider_transport` and never probes quota or marks a provider quota-limited.
See [the shared recovery contract](../../../../orchestration-runtime/DOCUMENTATION.md).

The constructor-only `readManagedTitleAssignment` returns a frozen bounded child
assignment tuple, without prompts, reports, lease tokens or a public RPC. It
rechecks persistence ownership and work admission after each ownership await,
then compares the complete immutable assignment again. The scheduler reader uses
the durable read view during uncommitted saves; equal creation times use the
existing sequence so a cancelled newer child assignment cannot reveal an older
title grant. This read does not change task, control-lease or cancellation state.

## Native dispatch readiness and stopped work

Detached managed aborts use the native task-dispatch owner with `operation: abort`, the exact task lease and canonical child. The runtime verifies settlement authority (so cancellation can clean up its own live attempt), while create/prompt still require dispatch authority. No HTTP principal or expired submitting-tool permit is borrowed.

Snapshots expose `dispatchReady` from the injected native controller readiness, ledger ownership, shutdown state and admission hold. `bridgeReady` continues to report only private loopback bridge startup; native consumers must not mistake that legacy diagnostic for native dispatch availability. UI confirmation and native barrier validation use `dispatchReady` when present, with legacy fallback. Every work dispatch independently rechecks native readiness at admission. Authenticated cancellation/disposition routes supply a private context grant; body fields cannot grant user-stopped recovery authority. Explicit Resume as task and dismissal preserve the scheduler's immutable terminal result and create work only through its retained-envelope/idempotent follow-up path.


## Required-check observations and user waivers

`declare_checks` binds root requirements to the canonical current objective,
using the same declarations and before/after observer as child checks. A root
Builder or Orchestrator may declare/correct its objective through the narrow
native authority path; Builder gains no delegation or child-result controls.
The derived task checkpoint reads objective-wide current verification from this
owner, including collected children, and retains source references, immutable
plan/interface references and bounded coverage. It never creates readiness from
historical receipts or grants execution authority.

`GET /api/orchestration/objective/verification` accepts the root session and
directory query scope and returns `{objectiveId,verification}` for current root
declarations. Reads follow normal local/managed session and directory access.
An optional `expectedObjectiveId` is a comparison fence; the host still chooses
the current objective and rejects a mismatch. Completion reads may additionally
send `originatingMessageId`. The host checks that message against the current
turn before and after reading verification, including unchanged ownership and
cancellation/execution generations, and returns the attested message ID with the
canonical objective. A synthetic continuation can therefore finish its original
objective without treating the continuation message as a new objective. Missing
or superseded turn authority refuses the read.
`POST /api/orchestration/objective/verification/waive` accepts
`{rootSessionId,directory,objectiveId,checks:[{name,contentHash}],reason}` and
requires authenticated user authority. It rechecks current objective and source
hashes at commit; a stale objective or hash refuses the waiver. It shares the
existing receipt owner and never exposes a model waiver operation.

`required-check-observer.js` records declared exact commands against canonical invocation identities and source hashes in the existing scheduler receipts. Root shells may rerun a settled child's check. Native V2 `session-execution-host.js` invokes the trusted before hook immediately before launch and the after hook after publication/verified termination, before delivering a terminal tool result. Missing, cancelled, unconfined or lost completions remain unverified; they never preserve an older pass. The legacy plugin hook remains compatible. Check execution uses no child summary prose.

Snapshots and task events with declared checks carry `verification: {objectiveId,ready,status,remaining,checks,observedAt}`. Each snapshot recomputes current declared source and visual-artifact identities. Observation times advance per task so a terminal task can acquire fresh verification without changing its execution outcome. Visual JSON reports are bounded to 64 KiB, evidence to sixteen project-contained files of at most 8 MiB each and 32 MiB total. The visual report requires populated state, explicit fixture/live data source, named assertions and matching artifact digests. A screenshot by itself cannot pass.

`POST /api/orchestration/task/:taskId/verification/waive` accepts `{rootSessionId,directory,checks:[{name,contentHash}],reason}`. The route requires a live authenticated cookie user and current session ownership; an unprotected loopback request, invented cookie, body `userWaived` flag or model RPC cannot authorize it. Local-owner authentication or an enabled protected UI session supplies a private live grant; managed sessions recheck the current app session and project ownership. The dedicated runtime method rehashes current content before the scheduler commit. Stale hashes return `check_content_changed` (409), and missing user authority returns `user_waiver_required` (403). The response contains `{taskId,verification}`. No waiver method is exposed through `handleRpc`.


Visual reports and screenshots are retained verification outputs, not source inputs: exclude their paths from the declared `paths` list. Prefer the project's existing ignored `.artifacts/` output convention; `.cache/` is for tooling that must stay inside the repository. A QA run retains these bytes only with its existing explicit `--keep-artifacts` or `DEVRYAN_KEEP_ARTIFACTS=1` option. Default success/failure/interruption scratch deletion is unchanged. OS-temporary or removed reports do not silently become permanent proof: this project-relative artifact contract cannot verify them, and removing a report or evidence file intentionally makes the visual check pending again. The user can rerun with retained evidence or explicitly waive the requirement; no parallel artifact store is introduced.

When every child in an outstanding dispatch group has settled but declared checks remain unmet, `barrier_status` advertises `verificationRecovery`. The parent-tool route rechecks this condition before permitting root inspection, corrective edits and exact check reruns, retaining read-before-write freshness. Active children never receive this exception. The parent can then record a current-content pass and `continue` the original result; a waiver is not required for ordinary remediation. Terminal execution fields remain immutable; only bounded required-check receipt metadata can advance after settlement.

`required-check-runner.js` resolves the supported mistaken Vitest Edge declaration to the repository-owned Deno runner without executing a command. `resolveRequiredCheckRunnerCorrection({directory,check,previousReceipt?,verifyRunner,now?})` requires the exact root `package.json` alias `test:edge: node scripts/testing/run-deno-tests.mjs`, existing Deno-test selectors and declared paths confined to the same function. A trusted host-constructor `verifyRunner(identity)` must authorize that exact script/manifest digest and `edge-deno-function-v1` selector contract; a model payload cannot supply the callback. Absence of proof returns `required_check_runner_unverified`. Test dialect recognition is not a static proof of arbitrary JavaScript runner semantics; root execution authority and the host policy authorize the repository-defined runner, and only a later observed check run can satisfy verification. Common package aliases outside this exact convention, shell composition, unrelated selectors, visual requirements, missing tests and escaping symlinks are explicitly unsupported. Source/runner changes during resolution refuse correction. `verifyRequiredCheckRunnerIdentity({directory,check,correction,verifyRunner})` rechecks manifest and runner bytes before admission or receipt use; ordinary source freshness remains owned by the existing observer. Corrections retain old declarations and receipts through `check-correction.js` rather than altering old success/failure evidence.

The native root tool advertises `correct_check` with only `task_id`, `check_name` and `expected_command`. The current native root invocation supplies a private Symbol context and rechecks canonical objective ownership before the scheduler commit; ordinary private RPC payloads, child tools and model-provided callbacks cannot grant it. Exact stale command/receipt state refuses the update. Known Deno declarations using the supported wrong Vitest convention are resolved before child dispatch, or fail with an actionable unverified-runner refusal. A committed correction whose expanded response exceeds the tool budget returns a committed receipt instead of pretending the write failed.

Owner setup: inspect `<target-repository>/scripts/testing/run-deno-tests.mjs` (a target-project convention, not a DevRyan source file) and confirm `--function NAME` runs the complete corresponding `supabase/functions/NAME/__tests__` Deno suite and preserves failure exits. Compute that file's SHA-256. Configure the trusted host constructor's `requiredCheckRunnerPolicies` as `[{"kind":"edge-deno-function-v1","scriptSha256":"<64 lowercase hex>"}]`, or provide the same JSON through `DEVRYAN_REQUIRED_CHECK_RUNNER_POLICIES` when launching the host. This is an explicit owner attestation of selector coverage, not automatic semantic proof of arbitrary JavaScript. No policy is inferred from a script merely mentioning Deno; model action input cannot provide or change the policy. The selected script digest must remain approved. Changed manifest bytes invalidate prior evidence; when the exact alias and approved script remain intact, a fresh observed run can establish proof against the new manifest. Script changes need renewed owner review and an applicable declared/corrected runner identity.

For corrected checks, the observer fingerprints the current repository manifest and runner script alongside the unchanged declared source coverage in both private execution and published views, before launch, after completion and on projection. Changed runner bytes, alias changes or withdrawn approval keep verification blocked even if a shell reports exit zero. Legacy assistant-group checks are bound only through canonical native ownership; a different ordinary user objective is excluded, while unavailable or ambiguous synthetic lineage stays blocked. Ordinary result collection never waives these requirements.

This runner pinning is bounded to the supported corrected Edge convention. Other npm/Bun scripts retain the ordinary declared-path evidence contract; their manifests and transitive runner configuration are not automatically resolved or pinned. Include those files explicitly in declared coverage when they affect an ordinary check. No generic package-alias verifier or arbitrary-runner semantic proof is claimed.

Required-check exit evidence accepts simple argv commands and `&&` chains.
`required-check-command.js` recognizes quotes and escapes but refuses shell
separators, pipelines, substitutions, background execution, redirections and
shell/control wrappers. A zero exit from an ambiguous legacy declaration cannot
establish a pass; the observer keeps it blocked with
`required_check_command_exit_ambiguous` and a standalone-command hint. Actual
nonzero failure receipts remain available. Declarations and stored ledgers stay
readable; operators can correct and rerun the check rather than losing history.

Required-check evidence binds the command, project-relative `cwd`, named execution `environment`, and declared content into one hash. Only complete canonical native process output may diagnose a Docker/UID prerequisite as `skipped` with `environment_unavailable`; the original nonzero exit, call/message identity, content hash and actionable hint remain attached. Skips allow closeout with status `skipped`, never `passed`. Truncated output, SQL, assertions and application failures remain unskipped. Native capability replies advertise independent read overlap from native admission rather than a legacy rollout flag.

Missing-socket `ENOENT` diagnostics from `stat`/`lstat` recognize only known Docker locations: `/var/run/docker.sock`, `/run/docker.sock`, `/run/user/<uid>/docker.sock`, and `/Users/<user>/.docker/run/docker.sock` or `/home/<user>/.docker/run/docker.sock`. They retain the `docker_daemon_unavailable` reason. An unrelated missing file or a mixed application failure still fails. A probe or preflight command does not establish evidence for another declared check, even when both name the same environment.
