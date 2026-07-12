# DevRyan Full Audit, Reliability, and Agent Harness Design

## Status

Approved program design for an incremental reliability pass across DevRyan's shared UI, web and Electron runtime, VS Code runtime, provider adapters, streaming path, resource lifecycle, and orchestration behavior.

This is a program-level specification. The work is deliberately decomposed into bounded workstreams with independent acceptance gates. No workstream may broaden into unrelated refactoring, and later workstreams must start from a green baseline left by earlier workstreams.

## Goal

Make DevRyan a reliable, responsive, memory-conscious, provider-agnostic agent harness while preserving current user-visible functionality and the existing separation between:

- provider-native orchestration exposed by OpenCode, ChatGPT/OpenAI, GitHub Copilot, or Cursor; and
- DevRyan-managed orchestration, which has explicit DevRyan ownership, deterministic scheduling, recovery, and a hard concurrency limit of three running tasks.

Success requires evidence from tests and a running application. Static validation alone is insufficient.

## Repository and Safety Boundaries

- `/Users/zoubair/Repositories/DevRyan` is the only product source repository.
- Forbidden upstream OpenChamber repositories and checkouts must not be read, compared, cloned, or modified.
- `../opencode` must not be read or modified.
- `/Users/zoubair/Repositories/Test` is authorized as the external provider-test project. It will be initialized as a minimal Git repository when implementation testing begins.
- The external test project must contain no credentials, provider transcripts, usage payloads, or other sensitive data.
- The four pre-existing working-tree edits in the sync abort-guard path are user-owned. They must not be overwritten or accidentally included in unrelated commits.
- No external dependency may be added without a separate, evidence-backed decision.
- Electron is the forward desktop target. No feature work will be added to the legacy Tauri shell.

## Baseline Evidence

The baseline was collected before task edits.

### Validation and build

| Check | Result | Wall time | Peak RSS |
| --- | --- | ---: | ---: |
| `bun run validate:full` | Passed | 77.41 s | 1,378,156,544 bytes |
| `bun run build` | Passed | 42.84 s | 2,152,890,368 bytes |

The passing validation covered:

- 8 script tests;
- 1,363 shared UI tests across 194 files;
- 686 web tests across 84 files;
- 43 VS Code Vitest tests across 10 files; and
- 9 VS Code quota tests.

The build emitted warnings about mixed static/dynamic imports and very large bundles. The largest observed web chunk was approximately 17.2 MB minified and 4.0 MB gzip. These warnings are optimization leads, not confirmed runtime defects.

### Running desktop process baseline

The observed packaged v1.0.7 application used the expected topology:

- one Electron main process;
- one renderer process;
- Chromium GPU/network/audio/video helpers;
- one managed OpenCode process; and
- stable Railway and Resend MCP children owned by OpenCode.

Process count remained at 10 throughout observation. There was no evidence that each provider retry created another process.

During a deterministic `Model not found gpt-5.6-luna` retry loop, aggregate RSS grew from approximately 804–805 MiB to approximately 1,209 MiB. Later physical-footprint measurements were:

| Process | Physical footprint | Peak |
| --- | ---: | ---: |
| Electron main | 148.7 MiB | 227.6 MiB |
| Electron renderer | 311.3 MiB | 436.0 MiB |
| OpenCode | 472.8 MiB | 675.6 MiB |

At the later sample, the renderer used roughly 37% CPU and the GPU helper roughly 17% CPU. The app was not idle: it displayed retry attempt 10, a live countdown, and activity animations. This proves a material failure-path cost but does not, by itself, prove an idle leak.

### Provider and harness baseline

The running instance reported these quota adapters as configured:

- Claude;
- ChatGPT/Codex;
- Cursor;
- GitHub Copilot and its add-on; and
- OpenCode Go.

No usage values or credentials were fetched or logged during the audit.

The read-only harness preflight returned eight warnings: five packaged-agent skill-announcement-policy warnings and three duplicate skill-name warnings. It had no captured runtime tool manifest for the failed-model turn. The missing manifest is not treated as a normal-turn defect until a model reaches tool initialization.

## Prioritized Findings

| Priority | Finding | Classification | Evidence and required response |
| --- | --- | --- | --- |
| P0 | Deterministic provider/model errors can retry indefinitely | Confirmed packaged-app defect; current working tree contains a candidate fix | v1.0.7 reached attempt 10 on a missing model. Validate the existing abort guard end to end and measure stopped-state cleanup. |
| P0 | Current-session completion can become green | Confirmed correctness defect | A production-path test explicitly expects a viewed session to receive a completion indicator. Reverse that expectation and derive green from terminal completion plus unread state plus `not current`. |
| P0 | Multiple-question card interaction lacks reliable component coverage | Confirmed structural flaw; reported symptom still needs an interaction reproduction | A selectable row and its nested checkbox can both own the same selection action. Add pointer/keyboard tests before changing it. |
| P0 | Usage refresh does not satisfy the 30-minute contract | Confirmed missing behavior | Polling is disabled by default, defaults to 60 seconds when enabled, cannot represent 30 minutes, has multiple potential owners, fetches every adapter, lacks in-flight deduplication, and replaces valid data on transient failure. |
| P1 | Directory eviction leaves related metadata behind | Confirmed lifecycle gap | Store disposal clears a bootstrap flag but not directory-prefetch records, routing indexes, and other directory-owned recovery state. |
| P1 | Cursor persistent-worker Agent cache is unbounded | Confirmed lifecycle gap | The cache retains an Agent for every session/model/agent-definition key until worker shutdown. |
| P1 | Cursor write-like tools can expand without useful detail | Confirmed empty-render path; live provider reproduction pending | When recognized input, diff, and diagnostics are absent, expanded result rendering returns no content even when a provider result exists. |
| P1 | Long-stream benchmark reports false byte loss | Confirmed measurement defect | It stops the pipeline after a fixed delay before the replay generator finishes. Production ordering and coalescing suites pass. |
| P1 | Retry-path memory grew materially while process count stayed flat | Confirmed growth signal; leak status unproven | Reproduce in a controlled run, compare stopped and repeated cycles, and attribute retained memory before changing allocation policy. |
| P2 | Event queues and replay/cache structures are not all dual-bounded or explicitly released | Confirmed design risk; material impact not yet measured | Add bounds or cleanup only after measuring retained payload shape and size. |
| P2 | Harness preflight is warning-only and has incomplete live tool evidence | Confirmed diagnostic result | Resolve genuine prompt-policy/duplicate-skill issues separately from unavailable warmup data. |
| P2 | DevRyan-managed orchestration does not exist | New required capability, not a regression | Build a distinct core scheduler after the existing correctness and lifecycle foundations are stable. |

Speculative concerns must stay out of the confirmed-defect list until reproduced.

## Program Decomposition

The work is split into eight workstreams. Each workstream has its own focused tests, affected validation, runtime check, diff review, and recorded result.

1. Measurement and test-fixture integrity.
2. Question-card and session-indicator correctness.
3. Usage/rate-limit refresh coordination.
4. Streaming, cache, memory, and process lifecycle.
5. Provider-native task visibility and partial-failure recovery.
6. DevRyan-managed orchestration core.
7. Cross-runtime integration and user-visible managed-task UI.
8. Full provider, packaging, performance, and regression verification.

Workstreams 1–5 stabilize existing behavior. Workstreams 6–7 introduce the new managed orchestration capability. Workstream 8 is the release gate.

Implementation planning is also split at that boundary. The first detailed plan covers workstreams 1–5 and leaves the repository green with updated measurements. The second detailed plan covers workstreams 6–8 and cannot begin until the stabilization plan's acceptance gates pass. Both plans trace to this approved program specification; neither may silently absorb work from the other.

## Workstream 1: Measurement and Test Fixture

### External project

Initialize `/Users/zoubair/Repositories/Test` as a Git repository with a small deterministic fixture:

- a README describing its test-only purpose;
- representative TypeScript/JavaScript source and test files;
- a small text/data file for read/search operations;
- a clean initial commit; and
- no package installation unless a later scenario proves it necessary.

Provider runs may edit the fixture. Each scenario must begin from a recorded clean state and reset only files created by the test harness. DevRyan's own repository remains the product source of truth.

### Benchmark repair

The event-pipeline benchmark must expose an explicit ingestion-complete signal and wait for both replay completion and a final pipeline flush. Integrity must be an assertion or failing exit condition, not a decorative report field.

The repaired benchmark records:

- input and delivered event counts;
- input and delivered delta bytes;
- flush count, size, and duration;
- wall time;
- concurrency and directory count; and
- peak process memory when the runtime makes that measurement reliable.

No production streaming change may use the current fixed-time benchmark as evidence.

## Workstream 2: Question Cards and Session Indicators

### Question-card interaction

Each selectable option has one interaction owner. The full row remains accessible to pointer and keyboard input, but its visual checkbox/radio must not invoke selection a second time through nested bubbling.

Question answers remain keyed by the flattened question entry and are regrouped by the original request ID and within-request index before submission. The card remains visible until every underlying request receives an authoritative successful SDK/HTTP acknowledgement. A partial success keeps only unresolved requests actionable and shows the failure reason without re-submitting acknowledged requests.

Submission rules:

- incomplete required answers block submit and expose validation state;
- Enter behavior remains platform-aware and IME-safe;
- pointer and keyboard submissions share one guarded action;
- repeated clicks while a request is pending are ignored;
- session switching cannot route an answer to another session;
- successful acknowledgement followed by delayed SSE removal does not cause duplicate submission; and
- reload restoration comes from authoritative pending-question state.

### Indicator state model

Indicators derive from the smallest authoritative per-session values:

- unresolved pending question requests;
- unresolved proposed plan lifecycle;
- unread error state;
- terminal assistant completion state;
- completion read state; and
- whether the session is currently displayed.

Precedence is fixed:

1. Blue: at least one unresolved question.
2. Yellow: an unresolved proposed plan awaiting user action.
3. Red: an unread terminal error.
4. Green: a settled, unread completion for a session that is not currently displayed.
5. No dot: otherwise; live work may use the existing activity spinner.

A plan becomes historical when implementation begins or it is dismissed. Historical plan availability does not keep the yellow indicator active. Green is never scheduled or rendered for the currently displayed session, and opening a background completed session clears green synchronously with its read acknowledgement.

Per-row selectors must remain leaf-level. Unrelated session events must not create new derived objects for every sidebar row.

## Workstream 3: Usage and Rate-Limit Refresh

Create one runtime-level refresh coordinator. Header, settings, desktop compact chrome, and VS Code surfaces consume store state but do not own timers.

The coordinator behavior is:

- perform configured-provider discovery and an initial load when the runtime becomes ready;
- guarantee a baseline refresh no less often than every 30 minutes while the runtime owner is mounted;
- retain the existing optional faster auto-refresh preference through the same coordinator;
- schedule only one next wake-up and deduplicate all manual, authentication-triggered, and timed requests;
- refresh only configured providers;
- maintain per-provider in-flight state;
- preserve the last successful provider result across transient failures;
- record `lastAttemptAt`, `lastSuccessAt`, `refreshError`, and a derived stale flag separately from valid data;
- refresh provider discovery after authentication/configuration changes; and
- clear timers and abort owned work on shutdown.

The global error state must be derived from per-provider results rather than being cleared by whichever request resolves last.

## Workstream 4: Streaming and Resource Lifecycle

### Streaming hot path

Existing event ordering, status replacement, and text-delta coalescing semantics remain intact. Any optimization must demonstrate at least one of:

- fewer reducer calls;
- fewer changed references;
- fewer row renders;
- lower flush time;
- lower CPU during a controlled stream; or
- lower retained memory after completion.

No optimization may drop bytes, reorder deltas, erase rich payload fields, widen historical activity heuristics, or delay visible output beyond the existing responsiveness budget.

### Directory lifecycle

Directory disposal becomes a single ownership boundary. The dispose callback clears:

- directory-prefetch cache and completed revision entries;
- directory/session/message routing-index entries;
- empty event-pipeline directory queues;
- pending materialization timers and orphaned pending deltas for that directory;
- session-child fetch entries for that directory; and
- any directory-scoped subscriptions registered by the store manager.

Pinned, booting, loading, or blocking-request directories remain protected by existing eviction policy.

### Cache bounds

Use count and byte bounds when payload sizes are knowable. Candidate structures include global replay payloads, untracked-diff text, pending deltas, and any new managed-task event history. Cursor SDK Agent objects have no reliable byte estimate, so they use count, idle TTL, and explicit session release instead.

Eviction must never remove an active task/session object. An evicted resumable Cursor Agent keeps its provider agent ID in canonical session metadata so it can be resumed without retaining the in-process object.

### Retry and process lifecycle

Validate the existing model-not-found abort guard with a controlled unavailable-model run. Record process count, renderer/OpenCode RSS, CPU, timers/listeners, and status transition before the error, after automatic abort, and after a second run.

Expected behavior:

- one automatic abort for the deterministic fatal condition;
- no infinite retry status;
- no duplicate toast or abort request;
- partial provider output preserved;
- OpenCode and MCP ownership unchanged; and
- memory returns to a stable post-run plateau rather than growing monotonically across identical cycles.

## Workstream 5: Provider-Native Compatibility and Recovery

Provider-native orchestration remains observational. DevRyan displays what the provider/OpenCode exposes and never manufactures unsupported worker state.

### Normalized activity

When provider events expose them, DevRyan may show:

- task creation and identity;
- running, completed, failed, aborted, or handed-off state;
- tool activity;
- incremental output;
- failure reason; and
- a link to the provider-created child session.

Provider IDs and session IDs remain canonical. Heuristic child linking is a fallback only when explicit metadata is absent and must remain one-to-one and ambiguity-safe.

### Cursor details

Cursor tool calls retain raw provider input and output in state. Expanded rendering chooses the first meaningful representation in this order:

1. structured diff or diagnostic;
2. structured input;
3. structured or text output;
4. provider error/failure reason; or
5. an explicit `No details supplied by provider` state.

Expansion must never reveal an empty body.

### Partial failure and abort

Interrupted provider-native tasks retain canonical child messages, tool results, completion timestamps, and failure/abort reason. Parent projection labels the result partial or interrupted and never completed. Resuming uses the provider/session identifier where supported; otherwise retry creates a new attempt linked to the prior attempt instead of overwriting it.

## Workstream 6: DevRyan-Managed Orchestration Core

### Shared runtime boundary

Create one internal workspace package, `@openchamber/orchestration-runtime`, under `packages/orchestration-runtime`. It contains the transport-neutral task contract, transition validator, deterministic queue, slot accounting, idempotency index, recovery reconciler, and persistence interface. It has no third-party runtime dependencies.

The web server owns one scheduler instance for web and Electron. The VS Code extension host owns one scheduler instance for VS Code. Thin adapters inject OpenCode session operations, atomic runtime-state persistence, clocks/ID generation for tests, and event publication. Electron does not create a second scheduler because its in-process web server is already the runtime owner.

The shared UI imports only the JSON-compatible contract types and consumes events through a dedicated narrow store. Core scheduling policy is never copied into UI, web route handlers, Electron IPC, or VS Code bridge handlers.

### Ownership boundary

DevRyan-managed tasks are a separate namespace. Provider-native task tools, Cursor internal tasks, Copilot internal workers, and OpenAI internal orchestration are not counted, scheduled, cancelled, or rewritten by the DevRyan scheduler.

Every managed event includes `owner: "devryan"`. Managed identifiers use a DevRyan-specific prefix and cannot collide with provider session/tool identifiers.

### Task record

The core record contains:

| Field | Meaning |
| --- | --- |
| `taskId` | Stable DevRyan-managed identity |
| `idempotencyKey` | Prevents duplicate creation/dispatch |
| `rootSessionId` | User-visible parent conversation |
| `parentTaskId` | Managed parent, if nested |
| `childSessionId` | Canonical OpenCode child session |
| `owner` | Always `devryan` |
| `sequence` | Monotonic ordering within the root graph |
| `mode` | `builder` or `orchestrator` ownership context |
| `providerId`, `modelId`, `agent`, `variant` | Queue-time execution snapshot |
| `status` | `queued`, `starting`, `running`, `completed`, `failed`, `aborted`, or `interrupted` |
| `attempt` and `priorTaskId` | Retry/resume lineage |
| `createdAt`, `startedAt`, `finishedAt` | Lifecycle timestamps |
| `timeoutAt` | Optional caller-selected execution deadline |
| `failureReason`, `partial` | Explicit terminal/recoverability state |

Full output and tool results remain in the canonical child session instead of being duplicated into an unbounded scheduler log. The ledger stores the child-session reference, latest durable sequence, terminal metadata, and a bounded preview needed for recovery UI.

### Scheduler

Core logic enforces a maximum of three `starting` or `running` DevRyan-owned tasks across the runtime owner. UI state cannot weaken this limit.

Queue order is deterministic by sequence, then creation time, then task ID. Dispatch uses a persisted lease token:

1. create and persist the queued task;
2. acquire a free slot and persist `starting` with a unique lease;
3. create or recover exactly one child session and persist its ID;
4. send the queue-time execution snapshot;
5. transition to `running` only after provider acceptance; and
6. release the slot exactly once on every terminal or interrupted path.

An idempotency-key index prevents duplicate execution. Repeated start requests return the existing task record.

Allowed transitions are explicit:

- `queued` → `starting` or `aborted`;
- `starting` → `running`, `failed`, `aborted`, or `interrupted`; and
- `running` → `completed`, `failed`, `aborted`, or `interrupted`.

Completed, failed, aborted, and interrupted records are immutable. Resume and retry create linked attempt records rather than reopening a terminal record.

A `starting` lease that has not reached provider acceptance within 60 seconds triggers authoritative child-session reconciliation. It becomes running if the child is live, settles if the child is terminal, or becomes interrupted if ownership cannot be proven. Running tasks are not failed merely because events are quiet; they reconcile against live session state after disconnect/restart. An explicit `timeoutAt` aborts only that task and records a timeout failure reason.

### Builder and orchestrator isolation

Each root session has one managed-graph ownership lease. Builder mode may execute direct work but cannot mutate a graph leased to orchestrator mode. Orchestrator mode may create managed children but cannot claim a graph actively owned by builder mode. Mode changes require the current owner to reach a terminal or explicitly released state.

Provider-native subagents launched inside a managed child remain provider-native and do not consume DevRyan slots.

### Cancellation

Cancellation addresses a task ID and its explicit ownership scope:

- cancelling one child does not cancel siblings;
- cancelling a queued task removes only that queue entry;
- cancelling a running task aborts only its child session;
- parent cancellation cancels managed descendants only when requested by the parent-cascade operation; and
- provider-internal workers are never directly controlled.

All terminal and interrupted paths use an idempotent finalizer that records status, partial output availability, failure reason, and slot release.

### Parent result handoff

Every completed, failed, aborted, or interrupted task emits one sequenced parent-result envelope. It contains the task and child-session identities, terminal status, partial flag, failure/abort reason, attempt lineage, latest recoverable output preview, and references to canonical child messages/tool results. The envelope is idempotent by task ID and terminal sequence.

The parent orchestrator may acknowledge the envelope and then choose exactly one follow-up action:

- continue using the recoverable result;
- resume the same provider session when supported;
- retry as a new linked attempt; or
- abandon the branch while retaining its history.

A resume never replays an already acknowledged prompt. Resume and retry both receive new task IDs and point to the prior task; resume may reuse the provider session while retry creates a new child session. No failed, aborted, or interrupted task is projected as completed merely because it produced useful output.

### Persistence and restart recovery

The scheduler uses the existing runtime state directory through an injected persistence adapter and atomic writes; it does not add an external database dependency.

On startup:

- queued tasks remain queued in their original order;
- `starting` and `running` tasks reconcile against canonical child-session status and messages;
- a terminal child settles the task without another prompt;
- a live child resumes observation;
- an unavailable child becomes `interrupted` with `partial: true` when recoverable output exists, and waits for explicit resume, retry, continue, or abandon; and
- no task is automatically duplicated merely because the application restarted.

Recoverable previews are limited to 64 KiB per task. The persisted ledger retains at most 2,000 terminal records, 90 days of unreferenced terminal history, and 20 MiB of serialized state. Compaction removes the oldest terminal records first, never removes nonterminal tasks or records referenced by retained attempt lineage, and leaves canonical session history as the source for complete output.

### Event contract

Managed task events carry:

- owner;
- task/root/parent/child identifiers;
- sequence;
- status;
- attempt lineage;
- partial/failure metadata; and
- the directory needed for routing.

Web/Electron publish them through the existing synthetic global-event path. VS Code receives the same contract through its extension-host bridge. The shared UI reducer consumes one contract in a narrow managed-orchestration store rather than adding hot state to the broad sync store.

The internal orchestration workspace package is the only owner of scheduler semantics. Web and VS Code adapters may differ in transport and persistence location but must pass the same contract and conformance suite.

## Workstream 7: Cross-Runtime Managed-Task UI

The UI presents managed tasks separately from provider-native task rows. It shows queue position, current status, activity summary, partial/interrupted state, failure reason, retry/resume actions, and child-session navigation when available.

The UI does not infer status from historical text. It subscribes by task/root identity to the dedicated managed store. High-frequency child output remains in the existing per-session message stores, so task-list updates do not repaint unrelated app chrome.

Web, Electron, and VS Code expose the same functional actions and error semantics. Native shells remain transport/integration layers, not policy owners.

## Oh My OpenCode Slim Compatibility

The local DevRyan Slim wrapper remains authoritative for packaged DevRyan prompts and agent definitions. It may preserve Slim runtime hooks while stripping Slim ownership of the agent catalog and system transform, as current local contracts specify.

The repository currently defines Slim installation, preset/model metadata, wrapper ownership, and background-subagent environment behavior. It does not define a durable DevRyan scheduler, recovery ledger, task cancellation graph, or cross-runtime managed-task API. This design supplies those DevRyan contracts without attributing them to Slim.

If implementation discovers a Slim behavior that is not present in local code, tests, or documentation, it must be recorded as an unknown contract and must not be guessed.

## Testing Strategy

### Focused automated tests

Add or update tests for:

- benchmark ingestion completion and byte integrity;
- question-card pointer, checkbox/radio, keyboard, multi-question, validation, duplicate-submit, partial-failure, retry, and session-switch behavior;
- indicator precedence and current/background/read/reload/reconnect cases;
- one quota coordinator, 30-minute baseline, faster optional cadence, overlap prevention, configured-provider filtering, stale-data retention, timer cleanup, and auth-triggered refresh;
- directory-disposal cleanup and protection rules;
- Cursor Agent cache bounds, active protection, release, and resume metadata;
- event replay/cache byte bounds where implemented;
- provider-native partial output, task failure, abort, and handoff projection;
- managed scheduler concurrency, FIFO order, idempotency, cancellation isolation, slot release, mode lease, restart reconciliation, and partial recovery; and
- web/VS Code contract parity.

### Runtime scenarios

Use `/Users/zoubair/Repositories/Test` for:

- ordinary ChatGPT/OpenAI, Copilot, and Cursor chat;
- short and sustained streams;
- tool-heavy reads, searches, edits, writes, and shell commands;
- expandable Cursor details;
- provider-native subagents where exposed;
- one, three, and more-than-three DevRyan-managed tasks;
- builder/orchestrator ownership transitions;
- multi-question cards;
- manual abort, provider failure, malformed event, timeout, restart, resume, and retry;
- background completion/read indicators;
- proposed plan indicators and implementation transition;
- initial/manual/timed usage refresh; and
- repeated create/run/delete cycles for memory and process cleanup.

Provider scenarios are marked `not exposed` rather than failed when a provider API does not emit the requested native activity.

## Execution and Validation Gates

Every meaningful change follows this sequence:

1. Reproduce or establish a measurable baseline.
2. Add a focused failing test when practical.
3. Implement the smallest correct change.
4. Run focused tests immediately.
5. Run `bun run validate:quick` or `bun run validate:affected` as required.
6. Perform the relevant runtime scenario.
7. Inspect the diff for unintended changes.
8. Record measurements and result before starting the next change.

Use `bun run validate:full` for shared configuration, cross-runtime contracts, orchestration core, risky sync/session changes, or release verification. Run `bun run build` for package exports, dependency graph, Electron/VS Code packaging, dynamic imports, or other bundling-sensitive changes. Run the web server suite for changes under `packages/web/server/**` when affected validation does not already cover it.

## Final Acceptance Matrix

The final report records `pass`, `fail`, `blocked`, or `not exposed` for each required scenario and provider. It includes:

- automated test command and result;
- runtime surface used;
- provider/model without credentials or sensitive payloads;
- process count before/during/after;
- RSS/physical-footprint baseline and post-run plateau;
- CPU during active streaming and after settlement;
- observed indicator/card/task state;
- cleanup result; and
- limitation or failure evidence.

Release acceptance requires:

- full type checking, linting, tests, and required builds passing;
- no secret or provider-content additions;
- no unrelated diff;
- no confirmed event loss or ordering regression;
- no green indicator for the current session;
- reliable multi-question submission and recovery;
- one isolated usage coordinator;
- stable process ownership after completion and abort;
- enforced three-task DevRyan concurrency with deterministic queueing;
- preserved partial output on failure/abort/restart; and
- documented provider limitations and unverified behavior.

## Documentation and Architecture Updates

Update root and module codemaps only when responsibilities or entry points change. Update the relevant module documentation for sync lifecycle, quota coordination, event transport, provider runtime behavior, and any new orchestration ownership module.

Large existing files may be split only when the work introduces a clear new owner or testable boundary. File size alone is not a refactoring justification.

## Risks and Mitigations

- **False optimization from a broken benchmark:** repair measurement first and require integrity assertions.
- **Provider-native/managed collision:** namespaced owner and identifiers; never reinterpret provider events as managed events.
- **Duplicate execution after restart:** persist child-session identity before dispatch and reconcile rather than auto-resend.
- **Lost partial work:** canonical child-session messages remain available when task status is failed, aborted, or interrupted, and the parent receives an idempotent result envelope.
- **Slot leaks/deadlocks:** one idempotent terminal finalizer and restart reconciliation tests for every non-happy path.
- **Broad render fanout:** dedicated managed-task store and leaf selectors; child output remains in per-session stores.
- **Memory regression from duplicated output:** ledger references canonical sessions and keeps only bounded previews/history.
- **Cross-runtime divergence:** one contract and shared core policy with thin web and VS Code adapters.
- **Unrelated refactoring:** change only measured or correctness-relevant ownership boundaries.

## Deliverables

The completed program will provide:

1. This initial audit and evidence baseline.
2. Workstream-specific implementation plans and recorded results.
3. Focused production changes organized by subsystem.
4. Regression tests for every corrected high-risk behavior.
5. Before/after streaming, memory, CPU, and process measurements where material.
6. A provider compatibility report for ChatGPT/OpenAI, Copilot, and Cursor.
7. A final scenario matrix.
8. Remaining limitations, risks, and recommended follow-up work.
9. A concise changed-file and architecture summary.
