# DevRyan Managed Orchestration Implementation Plan

> Execution plan for Workstreams 6–8 of the approved DevRyan reliability design. Implement each task test-first and keep every commit independently green.

**Goal:** Add a durable, provider-agnostic DevRyan-owned sub-agent scheduler with a hard three-task runtime limit, deterministic queueing, isolated cancellation, partial-result recovery, web/Electron parity, and a narrow user-visible task surface.

**Architecture:** A dependency-free workspace package, `@openchamber/orchestration-runtime`, exclusively owns task identity, transitions, admission, leases, idempotency, recovery, compaction, and result envelopes. Web/Electron each own one scheduler instance and inject OpenCode session operations, atomic persistence, a private authenticated loopback host for packaged OpenCode tools, and event publication. Provider-native task events remain observational and never enter the managed scheduler. The shared UI consumes JSON-compatible records through a dedicated store instead of the hot sync store.

**Constraints:** No new third-party dependencies. Never count or cancel opaque provider-native workers. Persist enough bounded input to dispatch queued work after restart, but do not duplicate full child output or provider transcripts in the ledger. Treat locally present Slim files and tests as authoritative; do not assign undocumented scheduling behavior to Slim.

---

## Task 1: Add the transport-neutral contract and validation gate

**Files:**

- Add: `packages/orchestration-runtime/package.json`
- Add: `packages/orchestration-runtime/index.js`
- Add: `packages/orchestration-runtime/index.d.ts`
- Add: `packages/orchestration-runtime/contract.js`
- Add: `packages/orchestration-runtime/contract.test.js`
- Add: `packages/orchestration-runtime/codemap.md`
- Add: `packages/orchestration-runtime/DOCUMENTATION.md`
- Modify: `package.json`
- Modify: `scripts/validate.mjs`
- Modify: `scripts/test-runner-utils.test.mjs`
- Modify: `packages/codemap.md`
- Modify: `codemap.md`

1. Write failing contract tests for:
   - `owner: "devryan"` and `dvr_task_`/`dvr_result_` identifiers;
   - required root, directory, execution snapshot, mode, attempt, and lineage fields;
   - the seven allowed statuses and explicit terminal classification;
   - bounded labels, text prompt input, previews, and failure reasons;
   - JSON round trips without functions, errors, or provider-native objects; and
   - rejection of provider-native records or identifiers at the managed boundary.
2. Define stable JSDoc-backed runtime shapes and matching declarations. Queue-time input is capped because queued tasks must survive restart; prompt content is never included in broadcast events or routine logs.
3. Add the new package suite to `test:full`. Teach affected validation that core changes run the orchestration suite and validate web, UI, dependents.
4. Run the focused package tests and validation-planner tests before proceeding.

## Task 2: Implement transitions, deterministic admission, and mode ownership

**Files:**

- Add: `packages/orchestration-runtime/transitions.js`
- Add: `packages/orchestration-runtime/transitions.test.js`
- Add: `packages/orchestration-runtime/scheduler.js`
- Add: `packages/orchestration-runtime/scheduler.admission.test.js`
- Modify: `packages/orchestration-runtime/index.js`
- Modify: `packages/orchestration-runtime/index.d.ts`

1. Start with failing tests for every allowed and forbidden transition. Terminal records must be immutable; retry and resume create linked attempts.
2. Add failing scheduler tests proving:
   - one and three tasks begin immediately;
   - a fourth and later task remain queued;
   - `starting` and `running` both consume capacity;
   - order is sequence, creation time, then task ID;
   - repeated idempotency keys return one record and dispatch once;
   - concurrent submissions cannot oversubscribe the three slots; and
   - provider-native activity has no admission API and cannot change capacity.
3. Serialize ledger mutations inside the scheduler. Start executor promises outside the mutation lock and finalize through one idempotent path so completion callbacks cannot deadlock queue admission.
4. Add a per-root graph mode lease. A live builder graph rejects orchestrator mutation and vice versa. Release automatically when the graph has no nonterminal task, or through an explicit release operation that refuses while work remains.
5. Run the package suite and affected validation.

## Task 3: Add dispatch, cancellation, timeouts, and parent envelopes

**Files:**

- Add: `packages/orchestration-runtime/scheduler.lifecycle.test.js`
- Add: `packages/orchestration-runtime/scheduler.cancellation.test.js`
- Add: `packages/orchestration-runtime/result-envelope.js`
- Add: `packages/orchestration-runtime/result-envelope.test.js`
- Modify: `packages/orchestration-runtime/scheduler.js`
- Modify: `packages/orchestration-runtime/index.js`
- Modify: `packages/orchestration-runtime/index.d.ts`

1. Define an injected executor contract with callbacks for child-session creation and provider acceptance, plus `start`, `resume`, `abort`, `reconcile`, and recoverable-result reads.
2. Test and implement the persisted dispatch sequence: queued → leased starting → child ID recorded → provider accepted running → exactly one terminal finalization and slot release.
3. Test cancellation isolation for queued tasks, one running child, siblings, and explicit descendant cascade. Never call the executor with provider-internal worker IDs.
4. Test timeout behavior with an injected clock. A timeout aborts only its task, retains recoverable data, and finishes as failed with an explicit timeout reason.
5. Emit one idempotent terminal envelope containing task/child identity, status, partial flag, reason, bounded preview, canonical child-message/tool references, attempt lineage, and terminal sequence.
6. Implement acknowledge actions `continue`, `resume`, `retry`, and `abandon`. Resume creates a new task that observes the existing child without replaying its prompt; retry creates a new child and linked attempt. Duplicate action keys return the same follow-up task.
7. Run focused lifecycle tests and affected validation.

## Task 4: Add atomic persistence, compaction, and restart reconciliation

**Files:**

- Add: `packages/orchestration-runtime/persistence.js`
- Add: `packages/orchestration-runtime/persistence.test.js`
- Add: `packages/orchestration-runtime/recovery.test.js`
- Modify: `packages/orchestration-runtime/scheduler.js`
- Modify: `packages/orchestration-runtime/index.js`
- Modify: `packages/orchestration-runtime/index.d.ts`
- Modify: `packages/orchestration-runtime/DOCUMENTATION.md`

1. Test a persistence interface with atomic owner-provided `load`/`save`; scheduler state writes are serialized and a failed write must not publish a transition as durable.
2. Preserve queued order across restart. Reconcile each starting/running task against its canonical child:
   - live child → resume observation without another prompt;
   - terminal child → settle once and emit/restore one envelope;
   - unavailable child → interrupted, partial when recovery data exists; and
   - malformed/stale lease → authoritative reconciliation, never blind redispatch.
3. Bound previews at 64 KiB, terminal records at 2,000, unreferenced terminal history at 90 days, and serialized state at 20 MiB. Remove oldest unreferenced terminal records first; never remove nonterminal tasks or retained lineage.
4. Test corrupt/partial ledger recovery: preserve the bad file through the adapter for diagnosis, start from an explicit empty state, and surface a recovery warning rather than guessing records.
5. Run the complete core suite repeatedly with fake clocks and controlled promise interleavings.

## Task 5: Build the web/Electron owner and managed OpenCode tool bridge

**Files:**

- Add: `packages/web/server/lib/orchestration/codemap.md`
- Add: `packages/web/server/lib/orchestration/DOCUMENTATION.md`
- Add: `packages/web/server/lib/orchestration/atomic-ledger.js`
- Add: `packages/web/server/lib/orchestration/open-code-executor.js`
- Add: `packages/web/server/lib/orchestration/private-host.js`
- Add: `packages/web/server/lib/orchestration/runtime.js`
- Add: `packages/web/server/lib/orchestration/routes.js`
- Add: `packages/web/server/lib/orchestration/*.test.js`
- Add: `packages/web/server/default-config/plugins/devryan-managed-orchestration.mjs`
- Add: `packages/web/server/default-config/plugins/devryan-managed-orchestration.test.mjs`
- Modify: `packages/web/package.json`
- Modify: `packages/web/server/index.js`
- Modify: `packages/web/server/lib/opencode/lifecycle.js`
- Modify: `packages/web/server/lib/opencode/lifecycle.test.js`
- Modify: `packages/web/server/lib/opencode/shutdown-runtime.js`
- Modify: `packages/web/server/lib/opencode/DOCUMENTATION.md`
- Modify: `packages/web/server/default-config/codemap.md`

1. Add an atomic JSON ledger at `OPENCHAMBER_DATA_DIR/orchestration/ledger.json` and a dependency-injected OpenCode executor that creates a canonical child with the correct parent, sends the queue-time provider/model/agent/variant snapshot once, polls bounded live status, reads canonical terminal messages/tools, and aborts only that child.
2. Start one scheduler for the web server process; Electron inherits it through the existing in-process server. External OpenCode remains supported for ordinary chat, but managed tools are reported unavailable if DevRyan cannot inject its private bridge into that external runtime.
3. Start a private `127.0.0.1:0` HTTP host before managed OpenCode. Require a random bearer token, enforce body limits, expose only the managed tool RPC, and stop the listener during graceful shutdown. Inject URL/token into the managed OpenCode environment without logging the token.
4. Add packaged tools for start/wait/status/cancel/retry/resume. The tool derives root session and directory from the authoritative OpenCode context; it cannot submit arbitrary provider-native IDs or claim another root.
5. Publish `openchamber:managed-task` snapshots through the existing synthetic global-event path. Add authenticated normal UI routes under `/api/orchestration/*` for list/details/cancel/acknowledge and deterministic HTTP error semantics.
6. Migrate the packaged `council_session` fanout onto managed task RPC so its locally owned parallel sessions share the same three slots. Preserve its existing result format and tests; do not change Slim hooks or claim Slim owns the scheduler.
7. Update the packaged orchestrator prompt/tool permissions to prefer DevRyan-managed delegation while retaining provider-native task activity as a distinct observational path. Builder does not gain child-creation permission.
8. Test start/shutdown, token rejection, request size limits, one/three/four task admission, cancellation, partial failure, and no retained timers/listeners.

## Task 6: Add the VS Code owner and bridge parity

**Files:**

1. Instantiate exactly one scheduler per extension host. Store the ledger atomically under `ExtensionContext.globalStorageUri`; dispose timers, private host, and observation requests on extension shutdown.
2. Reuse the same OpenCode executor semantics and private authenticated tool protocol. Inject the bridge environment only into DevRyan-managed OpenCode, never a configured external server.
3. Add bridge handlers matching the web route actions and error shape. Route `/api/orchestration/*` fetches from the webview to those handlers.
4. Publish managed events to all active DevRyan webviews with existing acknowledged message delivery. A newly opened webview performs an initial snapshot load, so missed events cannot strand the UI.
5. Run the shared core conformance suite against both adapter fixtures, VS Code focused tests, type-check, and build.

## Task 7: Add the narrow shared UI store and event routing

**Files:**

- Add: `packages/ui/src/lib/orchestrationApi.ts`
- Add: `packages/ui/src/stores/useManagedOrchestrationStore.ts`
- Add: `packages/ui/src/stores/useManagedOrchestrationStore.test.ts`
- Add: `packages/ui/src/stores/managed-orchestration-selectors.test.ts`
- Modify: `packages/ui/package.json`
- Modify: `packages/ui/src/sync/event-pipeline.ts`
- Modify: `packages/ui/src/sync/event-pipeline.test.ts`
- Modify: `packages/ui/src/sync/sync-context.tsx`
- Modify: `packages/ui/src/apps/AppEffects.tsx`
- Modify: `packages/ui/src/stores/codemap.md`
- Modify: `packages/ui/src/stores/DOCUMENTATION.md`
- Modify: `packages/ui/src/sync/DOCUMENTATION.md`

1. Add an API wrapper that preserves authoritative server errors and never optimistically removes a task or terminal result.
2. Add a dedicated Zustand store keyed by task/root ID. Upserts preserve references for unchanged records; selectors subscribe to one root or one task, not the entire ledger.
3. Route `openchamber:managed-task` events before the directory reducer. They must not clone session/message/part collections or enter provider-native task projection.
4. Load one initial snapshot from the runtime owner and reconcile it with later sequenced events. Ignore stale sequences and deduplicate reconnect replay.
5. Test unrelated-session updates, stale events, reconnect replay, root-scoped selectors, and store reset on runtime shutdown.

## Task 8: Add the managed-task presentation and recovery actions

**Files:**

- Add: `packages/ui/src/components/chat/ManagedTaskList.tsx`
- Add: `packages/ui/src/components/chat/ManagedTaskRow.tsx`
- Add: `packages/ui/src/components/chat/ManagedTaskList.test.tsx`
- Modify: `packages/ui/src/components/chat/ChatContainer.tsx`
- Modify: `packages/ui/src/components/chat/codemap.md`
- Modify: `packages/ui/src/lib/i18n/messages/en.ts`

1. Render a compact root-scoped list distinct from provider-native task tool rows. Show queue position, DevRyan ownership, mode, agent/model, running/terminal status, partial/interrupted label, failure reason, bounded preview, attempt lineage, and child-session navigation.
2. Expose cancel only for queued/starting/running tasks. Expose continue/abandon for terminal envelopes, retry for failed/aborted/interrupted work, and resume only when the owner reports the child session resumable.
3. Keep a card until the authoritative action response/event arrives. Disable duplicate clicks, retain visible errors, and allow retry.
4. Memoize rows and use leaf selectors so child streaming output does not repaint the task list or unrelated chat chrome.
5. Test status/action visibility, partial-result retention, action failure/retry, current-session switching, and provider-native/managed visual separation.

## Task 9: Runtime recovery and resource matrix

**Files:**

- Modify: `docs/audits/2026-07-10-devryan-reliability-pass.md`

1. Use `/Users/zoubair/Repositories/Test` only after confirming it is still the clean initialized fixture.
2. Exercise one, three, and at least five managed tasks; verify exactly three OpenCode child sessions are starting/running and queued order is stable.
3. Run builder/orchestrator lease conflicts, sibling cancellation, parent cascade, timeout, provider error after partial output, manual abort, retry, resume without prompt replay, and explicit abandon.
4. Restart web owners with queued/running fixtures. Confirm live children reconcile, terminal children settle, missing children become interrupted, and no prompt duplicates.
5. Repeat create/run/delete cycles while measuring scheduler record counts, timers, listeners, process topology, RSS, and post-settlement cleanup. Provider-native nested activity must not change the three managed slots.
6. Run ordinary/long/tool-heavy Copilot and Cursor checks again; record OpenAI as blocked if the account usage limit remains authoritative. Do not manufacture unsupported provider-native activity.

## Task 10: Final cross-runtime release gate

**Files:**

- Modify: `docs/audits/2026-07-10-devryan-reliability-pass.md`
- Modify: relevant codemaps and module documentation if implementation paths differ from this plan

1. Run focused suites after every task, then:

   ```bash
   /usr/bin/time -l bun run validate:full
   /usr/bin/time -l bun run build
   bun run electron:build
   ```

2. Inspect the complete branch diff, run `git diff --check`, and scan only added/changed content for credentials, provider transcripts, forbidden-upstream references, and accidental fixture changes.
3. Verify Electron shutdown leave no scheduler listener, timer, child session observer, OpenCode child, or shell process owned by the tested runtime.
4. Finish the audit ledger with exact test counts, runtime scenario results, before/after measurements where methods are comparable, provider limitations, changed files, and architectural decisions.

## Non-negotiable acceptance checks

- The fourth DevRyan-owned task never reaches `starting` while three managed slots are occupied.
- Duplicate submit, retry, or resume requests cannot execute work twice.
- Cancelling one task cannot abort a sibling, root conversation, or provider-native worker.
- Failed/aborted/interrupted tasks keep partial output and never render completed.
- Restart recovery never blindly replays a prompt.
- Builder and orchestrator cannot concurrently mutate one managed root graph.
- Web, Electron, use the same core scheduler semantics.
- High-frequency provider output remains in existing child-session stores, outside the managed-task store.
- Slim compatibility claims are limited to locally verified wrapper/preset/tool behavior.
