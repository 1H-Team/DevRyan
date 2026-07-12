# DevRyan Stabilization And Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stabilize DevRyan's existing streaming, question, session-indicator, quota, cache, Cursor, and provider-native activity paths with measured, test-first changes before introducing DevRyan-managed orchestration.

**Architecture:** Preserve the existing OpenCode/SSE architecture and add small ownership boundaries where the audit proved that ownership is ambiguous or unbounded. One runtime effect owns quota refresh; one question-card controller owns each option and acknowledged request; directory disposal releases all directory-scoped caches; the Cursor worker owns a bounded active-aware Agent cache. Provider-native events remain observational and separate from the later DevRyan-managed scheduler.

**Tech Stack:** Bun, React, TypeScript, Zustand, Express/OpenCode SDK integration, Electron, VS Code, Node test runner, existing repository test helpers. No new dependencies.

**Global constraints:**

- Treat `/Users/zoubair/Repositories/DevRyan` as the only product source.
- Do not read or compare forbidden OpenChamber repositories or `../opencode`.
- Preserve the pre-existing edits in `packages/ui/src/sync/DOCUMENTATION.md`, `abort-retry-guard.ts`, `abort-retry-guard.test.ts`, and `sync-context.tsx`; commit them only in their own verified task.
- Initialize `/Users/zoubair/Repositories/Test` only as the authorized external fixture; never place credentials or provider transcripts there.
- Use red-green-refactor for each behavior change. Run focused tests before affected validation.
- Keep store selectors leaf-level and preserve references for unchanged state.
- Record runtime measurements without logging provider usage payloads, prompts, tokens, or credentials.
- Stop and repair any regression before advancing to the next task.

---

## File Structure

- Add `docs/audits/2026-07-10-devryan-reliability-pass.md`: append-only audit ledger, before/after measurements, compatibility report, and scenario matrix.
- Modify `packages/ui/src/sync/__tests__/event-pipeline.bench.js`: deterministic replay completion and integrity failure.
- Modify the existing sync abort-guard files: verify and finish the user-owned deterministic fatal-error fix.
- Add focused question-card controller and option-row modules/tests under `packages/ui/src/components/chat/` and simplify `QuestionCard.tsx`.
- Modify session lifecycle and `packages/ui/src/components/session/sidebar/sessionIndicator*`: authoritative unread/current-session rules.
- Add `packages/ui/src/stores/quota-refresh-coordinator.ts` and tests; modify `useQuotaStore.ts`, `AppEffects.tsx`, and remove component-owned polling hooks.
- Modify directory-scoped sync caches and tests under `packages/ui/src/sync/`.
- Add a bounded Agent-cache helper/test under `packages/cursor-sdk-runtime/`; wire it into `persistent-worker.mjs`.
- Modify `packages/ui/src/components/chat/message/parts/ToolPart.tsx` and focused helpers/tests so Cursor expansions are never empty.
- Extend existing Cursor/provider-native tests under `packages/web/server/` and shared task projection tests for partial failure/abort.
- Update module documentation/codemaps only where ownership or entry points change.

---

### Task 1: Initialize The External Fixture And Audit Ledger

**Files:**
- Create outside product repo: `/Users/zoubair/Repositories/Test/.gitignore`
- Create outside product repo: `/Users/zoubair/Repositories/Test/README.md`
- Create outside product repo: `/Users/zoubair/Repositories/Test/src/math.ts`
- Create outside product repo: `/Users/zoubair/Repositories/Test/src/math.test.ts`
- Create outside product repo: `/Users/zoubair/Repositories/Test/data/notes.txt`
- Create: `docs/audits/2026-07-10-devryan-reliability-pass.md`

- [ ] **Step 1: Confirm the external path and initialize Git**

Run:

```bash
test -d /Users/zoubair/Repositories/Test
test -z "$(find /Users/zoubair/Repositories/Test -mindepth 1 -maxdepth 1 -print -quit)"
git -C /Users/zoubair/Repositories/Test init -b main
```

Expected: the exact authorized directory exists, is empty, and becomes a Git repository. If it is no longer empty, inspect only its top-level names and do not overwrite content.

- [ ] **Step 2: Add the deterministic fixture using `apply_patch`**

Create a dependency-free TypeScript fixture:

```ts
export function add(left: number, right: number): number {
  return left + right;
}

export function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
```

The README must state that the repository is a disposable DevRyan provider/runtime fixture and must never contain credentials or captured provider content. The test file uses `node:test` and `node:assert/strict`.

- [ ] **Step 3: Validate and commit only the fixture**

Run:

```bash
node --test /Users/zoubair/Repositories/Test/src/math.test.ts
git -C /Users/zoubair/Repositories/Test status --short
git -C /Users/zoubair/Repositories/Test add .
git -C /Users/zoubair/Repositories/Test commit -m "test: initialize DevRyan provider fixture"
```

Expected: two fixture assertions pass; the external repository has one clean initial commit.

- [ ] **Step 4: Create the audit ledger**

Record the already collected baseline exactly, with `not yet measured` cells for post-change values. Include:

- full validation: pass, 77.41 s, 1,378,156,544-byte peak RSS;
- full build: pass, 42.84 s, 2,152,890,368-byte peak RSS;
- packaged retry topology: 10 processes;
- aggregate RSS growth from approximately 805 MiB to 1,209 MiB during attempt 10;
- measured Electron main, renderer, and OpenCode footprints;
- configured-provider names only, never usage values;
- confirmed defect list and the distinction between memory growth and an unproven leak; and
- a scenario matrix with `pass`, `fail`, `blocked`, or `not exposed` as the only result values.

- [ ] **Step 5: Validate documentation and commit**

Run:

```bash
bun run docs:validate
git diff --check
git status --short
```

Expected: documentation validation passes and the commit contains only the audit ledger.

Commit:

```bash
git add docs/audits/2026-07-10-devryan-reliability-pass.md
git commit -m "docs: record DevRyan reliability baseline"
```

---

### Task 2: Repair Streaming Measurement Before Optimizing Production Code

**Files:**
- Modify: `packages/ui/src/sync/__tests__/event-pipeline.bench.js`
- Test: `packages/ui/src/sync/__tests__/event-pipeline.test.js`
- Modify: `docs/audits/2026-07-10-devryan-reliability-pass.md`

- [ ] **Step 1: Add a failing deterministic-completion test**

Extract or export the benchmark replay helper so the test can await generator exhaustion. Add a test that uses a delayed async generator and asserts that the benchmark does not report before its final event:

```js
test('benchmark waits for replay completion before final flush', async () => {
  const result = await runReplayBenchmark({
    directories: 2,
    eventsPerDirectory: 100,
    replayDelayMs: 1,
  });

  assert.equal(result.inputEventCount, 200);
  assert.equal(result.deliveredEventCount, 200);
  assert.equal(result.inputDeltaBytes, result.deliveredDeltaBytes);
});
```

- [ ] **Step 2: Prove the old fixed-delay benchmark fails**

Run:

```bash
node --test packages/ui/src/sync/__tests__/event-pipeline.test.js
bun packages/ui/src/sync/__tests__/event-pipeline.bench.js
```

Expected before implementation: the new delayed replay test fails or the benchmark reports fewer delivered bytes than input bytes.

- [ ] **Step 3: Implement an explicit replay-complete barrier**

Replace the fixed sleep with these semantics:

```js
await Promise.all(replayTasks);
pipeline.flushAll();
await waitForScheduledFlushesToSettle();

assert.equal(deliveredEventCount, inputEventCount);
assert.equal(deliveredDeltaBytes, inputDeltaBytes);
```

The result must include input/delivered counts and bytes, flush count, largest flush, total flush time, wall time, directories, concurrency, and `process.memoryUsage().rss`. Any mismatch throws and exits non-zero.

- [ ] **Step 4: Run streaming regression and record a trustworthy baseline**

Run:

```bash
node --test packages/ui/src/sync/__tests__/event-pipeline.test.js packages/ui/src/sync/__tests__/event-pipeline-resume.test.js
bun packages/ui/src/sync/__tests__/event-pipeline.bench.js
bun run validate:affected
```

Expected: all ordering/coalescing tests pass, byte integrity is exact, and the audit ledger records the repaired benchmark output. Do not change production batching in this task.

- [ ] **Step 5: Review and commit**

Run `git diff --check` and inspect the entire task diff. Commit only benchmark, focused test, and ledger changes:

```bash
git add packages/ui/src/sync/__tests__/event-pipeline.bench.js packages/ui/src/sync/__tests__/event-pipeline.test.js docs/audits/2026-07-10-devryan-reliability-pass.md
git commit -m "test: make streaming benchmark deterministic"
```

---

### Task 3: Verify And Complete The Fatal Provider-Retry Abort Guard

**Files:**
- Preserve/modify: `packages/ui/src/sync/abort-retry-guard.ts`
- Preserve/modify: `packages/ui/src/sync/abort-retry-guard.test.ts`
- Preserve/modify: `packages/ui/src/sync/sync-context.tsx`
- Preserve/modify: `packages/ui/src/sync/DOCUMENTATION.md`
- Modify: `docs/audits/2026-07-10-devryan-reliability-pass.md`

- [ ] **Step 1: Audit the existing user-owned diff before editing**

Run:

```bash
git diff -- packages/ui/src/sync/abort-retry-guard.ts packages/ui/src/sync/abort-retry-guard.test.ts packages/ui/src/sync/sync-context.tsx packages/ui/src/sync/DOCUMENTATION.md
```

Expected: the diff is limited to a deterministic fatal-error classifier, one-shot abort tracking, sync integration, tests, and documentation. Preserve authorship and intent.

- [ ] **Step 2: Add any missing failing edge tests first**

The focused suite must prove:

- `Model not found` and equivalent deterministic provider/model validation errors request exactly one abort;
- rate limits, temporary network failures, and server-busy conditions remain retryable;
- repeated matching status events do not issue duplicate aborts or toasts;
- a later new run/session can be guarded independently; and
- partial assistant content remains in the session store.

Use a pure function contract such as:

```ts
expect(classifyAbortRetryError({ message: 'Model not found gpt-x' })).toBe('fatal');
expect(classifyAbortRetryError({ statusCode: 429, message: 'rate limited' })).toBe('transient');
```

- [ ] **Step 3: Run the focused suite and confirm the intended red/green state**

Run:

```bash
bun test packages/ui/src/sync/abort-retry-guard.test.ts
```

Expected: any newly added edge test fails first; after the smallest implementation adjustment, all guard tests pass.

- [ ] **Step 4: Run affected validation**

Run:

```bash
bun run validate:affected
```

Expected: UI, web, and VS Code consumers remain green because this is shared session/sync behavior.

- [ ] **Step 5: Run a controlled unavailable-model scenario**

Use the source-built app against `/Users/zoubair/Repositories/Test`. Select an intentionally unavailable model through the normal UI without modifying provider credentials. Record, without provider content:

- process count and RSS before sending;
- retry/status events until the guard acts;
- abort request count;
- final visible state and retained partial output;
- process count/RSS after settlement; and
- a second identical cycle.

Expected: one automatic abort per run, no indefinite attempt counter, no duplicate toast/abort, stable process ownership, and a post-run memory plateau. If the provider/API cannot expose this safely, record `blocked` rather than fabricating success.

- [ ] **Step 6: Commit the isolated pre-existing change**

After diff review and ledger update:

```bash
git add packages/ui/src/sync/abort-retry-guard.ts packages/ui/src/sync/abort-retry-guard.test.ts packages/ui/src/sync/sync-context.tsx packages/ui/src/sync/DOCUMENTATION.md docs/audits/2026-07-10-devryan-reliability-pass.md
git commit -m "fix: stop retrying deterministic provider errors"
```

---

### Task 4: Make Multi-Question Submission Single-Owner And Retry-Safe

**Files:**
- Modify: `packages/ui/src/components/chat/QuestionCard.tsx`
- Add: `packages/ui/src/components/chat/questionCardSubmission.ts`
- Add: `packages/ui/src/components/chat/questionCardSubmission.test.ts`
- Modify: `packages/ui/src/components/chat/questionCardOptions.ts`
- Modify: `packages/ui/src/components/chat/questionCardOptions.test.ts`
- Modify: `packages/ui/src/components/chat/questionCardRouting.test.ts`
- Modify: `packages/ui/src/components/chat/DOCUMENTATION.md`
- Modify: `docs/audits/2026-07-10-devryan-reliability-pass.md`

- [ ] **Step 1: Add failing option-ownership and partial-ack tests**

Lock these behaviors with pure helpers/source structure assertions:

```ts
it('toggles a multi-select option once per row activation', () => {
  expect(toggleOption(['a'], 'b', true)).toEqual(['a', 'b']);
  expect(toggleOption(['a', 'b'], 'b', true)).toEqual(['a']);
});

it('retries only request groups without an acknowledgement', () => {
  const pending = pendingQuestionRequests(requests, new Set(['request-a']));
  expect(pending.map((request) => request.id)).toEqual(['request-b']);
});
```

Add a source-level assertion that a selectable row does not render an interactive `Checkbox`, `Radio`, nested `<button>`, or duplicate `onChange` owner inside its outer button.

- [ ] **Step 2: Run focused tests and verify they fail**

Run:

```bash
bun test packages/ui/src/components/chat/questionCardOptions.test.ts packages/ui/src/components/chat/questionCardRouting.test.ts packages/ui/src/components/chat/questionCardSubmission.test.ts
```

Expected: partial acknowledgement and/or one-owner markup tests fail before implementation.

- [ ] **Step 3: Implement one interaction owner per option**

Keep the full row as the single accessible button. Replace nested interactive checkbox/radio controls with decorative spans/icons carrying `aria-hidden="true"`. The outer button owns `aria-pressed` or `aria-checked`, keyboard activation, and the one toggle callback.

Do not change answer routing: continue flattening by request and within-request question index, then regroup before submission.

- [ ] **Step 4: Implement acknowledged-request tracking**

Add a pure submission reducer:

```ts
export type QuestionSubmissionState = {
  acknowledgedRequestIds: ReadonlySet<string>;
  failedByRequestId: ReadonlyMap<string, string>;
};

export function applyQuestionSubmissionResults(
  previous: QuestionSubmissionState,
  results: readonly QuestionSubmissionResult[],
): QuestionSubmissionState;
```

`QuestionCard` holds the acknowledged IDs for the current session/card identity, filters them from the next attempt, disables duplicate submits while pending, keeps unresolved groups visible, and clears local acknowledgement state only when authoritative pending-question props remove the request or the card/session identity changes.

- [ ] **Step 5: Cover validation, session changes, and retry**

Extend tests for single question, multiple requests, every existing question type, incomplete answers, duplicate click, failed request retry, successful delayed SSE removal, session switch, and request-ID/question-index association.

- [ ] **Step 6: Run focused and affected validation**

Run:

```bash
bun test packages/ui/src/components/chat/questionCardNavigation.test.ts packages/ui/src/components/chat/questionCardOptions.test.ts packages/ui/src/components/chat/questionCardRouting.test.ts packages/ui/src/components/chat/questionCardSubmission.test.ts
bun run validate:affected
```

Expected: all question suites and shared runtime type checks pass.

- [ ] **Step 7: Perform a browser interaction scenario**

Run DevRyan against the external Test project and use the normal question tool to exercise:

- one question;
- two questions in one request;
- two simultaneous request groups;
- pointer and keyboard submission;
- incomplete validation;
- duplicate click;
- one injected provider failure and retry; and
- session switching while the card is visible.

Expected: every option changes once, partial success retries only unresolved requests, errors remain visible, and the card disappears only after acknowledgement/pending-state reconciliation.

- [ ] **Step 8: Review, record, and commit**

Run `git diff --check`, update the matrix, and commit only question-card files and documentation:

```bash
git add packages/ui/src/components/chat/QuestionCard.tsx packages/ui/src/components/chat/questionCardSubmission.ts packages/ui/src/components/chat/questionCardSubmission.test.ts packages/ui/src/components/chat/questionCardOptions.ts packages/ui/src/components/chat/questionCardOptions.test.ts packages/ui/src/components/chat/questionCardRouting.test.ts packages/ui/src/components/chat/DOCUMENTATION.md docs/audits/2026-07-10-devryan-reliability-pass.md
git commit -m "fix: make question submissions retry-safe"
```

---

### Task 5: Derive Sidebar Indicators From Current Authoritative State

**Files:**
- Modify: `packages/ui/src/sync/sync-context.tsx`
- Modify: `packages/ui/src/sync/sync-context.plan-lifecycle.test.ts`
- Modify: `packages/ui/src/components/session/sidebar/sessionIndicator.ts`
- Modify: `packages/ui/src/components/session/sidebar/sessionIndicator.test.ts`
- Modify: `packages/ui/src/components/session/sidebar/SessionNodeItem.tsx`
- Modify: `packages/ui/src/sync/DOCUMENTATION.md`
- Modify: `docs/audits/2026-07-10-devryan-reliability-pass.md`

- [ ] **Step 1: Reverse the confirmed current-session regression test**

Change the existing viewed-session test so terminal completion in the displayed session expects no completion indicator. Add resolver tests for the exact precedence:

```ts
question > proposedPlan > unreadError > unreadBackgroundCompletion > none
```

Required cases include active current completion, background unread completion, read completion, streaming, abort, reload/reconnect, concurrent unrelated session updates, and blue/yellow overriding red/green.

- [ ] **Step 2: Run focused tests and prove the current behavior is red**

Run:

```bash
bun test packages/ui/src/sync/sync-context.plan-lifecycle.test.ts packages/ui/src/components/session/sidebar/sessionIndicator.test.ts
```

Expected before implementation: the new current-session assertion fails because the sync lifecycle marks viewed current completions green.

- [ ] **Step 3: Fix completion scheduling at the authoritative lifecycle edge**

In `sync-context.tsx`, mark a completion only when the settled session is not viewed. Do not preserve the current active-session exception.

In `sessionIndicator.ts`, add `isActive` to the root resolver and require all of these for green:

```ts
!isWorking && !isActive && hasCompletedStatus && hasUnreadCompletion
```

Pass the existing leaf `sessionHasUnreadCompletion` and `isActive` values from `SessionNodeItem`. Keep pending questions and proposed plans independent of active state so blue/yellow persist while unresolved.

- [ ] **Step 4: Keep read cleanup synchronous**

Verify that opening a background session calls both `markSessionViewed(sessionId)` and `clearReadCompletionIndicators([sessionId])` at the existing view transition. Add a focused test if this is not already locked.

- [ ] **Step 5: Run focused, affected, and hot-fanout checks**

Run:

```bash
bun test packages/ui/src/sync/sync-context.plan-lifecycle.test.ts packages/ui/src/components/session/sidebar/sessionIndicator.test.ts packages/ui/src/sync/notification-store.test.ts
bun run validate:affected
```

Inspect selectors to confirm no row subscribes to the whole notification or completion map and no derived object is allocated on unrelated session updates.

- [ ] **Step 6: Exercise background/current/read scenarios in the app**

With two sessions in the Test project, verify current completion has no green; background completion becomes green; opening it clears green; unresolved question stays blue; proposed plan stays yellow; implementation start clears yellow; abort/error does not become green.

- [ ] **Step 7: Record and commit**

```bash
git add packages/ui/src/sync/sync-context.tsx packages/ui/src/sync/sync-context.plan-lifecycle.test.ts packages/ui/src/components/session/sidebar/sessionIndicator.ts packages/ui/src/components/session/sidebar/sessionIndicator.test.ts packages/ui/src/components/session/sidebar/SessionNodeItem.tsx packages/ui/src/sync/DOCUMENTATION.md docs/audits/2026-07-10-devryan-reliability-pass.md
git commit -m "fix: derive session indicators from unread state"
```

---

### Task 6: Create One Quota Refresh Coordinator

**Files:**
- Add: `packages/ui/src/stores/quota-refresh-coordinator.ts`
- Add: `packages/ui/src/stores/quota-refresh-coordinator.test.ts`
- Modify: `packages/ui/src/stores/useQuotaStore.ts`
- Add: `packages/ui/src/stores/useQuotaStore.test.ts`
- Modify: `packages/ui/src/apps/AppEffects.tsx`
- Modify: `packages/ui/src/components/layout/Header.tsx`
- Modify: `packages/ui/src/components/layout/DesktopRightChromeActions.tsx`
- Modify: `packages/ui/src/components/layout/VSCodeLayout.tsx`
- Modify: `packages/ui/src/components/sections/usage/UsagePage.tsx`
- Modify: `packages/web/server/lib/quota/DOCUMENTATION.md`
- Modify: `docs/audits/2026-07-10-devryan-reliability-pass.md`

- [x] **Step 1: Add failing timer/coordinator tests with an injected clock**

Define a pure coordinator interface:

```ts
export const BASELINE_QUOTA_REFRESH_MS = 30 * 60 * 1000;

export interface QuotaRefreshCoordinator {
  start(): void;
  stop(): void;
  refreshNow(options?: { forceRefresh?: boolean; rediscover?: boolean }): Promise<void>;
  settingsChanged(): void;
}
```

Tests must prove initial discovery/load, one timer owner, 30-minute default, optional faster cadence, no overlap, one queued follow-up after a request already in flight, timer cleanup, and no refresh after stop.

- [x] **Step 2: Add failing store tests**

Reset Zustand state between cases and mock `fetch`. Prove:

- only configured providers are refreshed after discovery;
- duplicate fetches for one provider return the same promise;
- a transient failure preserves the prior successful `ProviderResult`;
- per-provider attempt/success/error/stale metadata updates independently;
- one provider success cannot clear another provider's error; and
- force refresh and authentication/config changes trigger discovery safely.

- [x] **Step 3: Run focused tests and verify red**

Run:

```bash
bun test packages/ui/src/stores/quota-refresh-coordinator.test.ts packages/ui/src/stores/useQuotaStore.test.ts
```

Expected: tests fail because the current hook has component-owned intervals, no discovery filter/deduplication, and overwrites valid results on error.

- [x] **Step 4: Implement store metadata and in-flight deduplication**

Add:

```ts
type ProviderRefreshState = {
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  refreshError: string | null;
};
```

Keep the in-flight `Map<QuotaProviderId, Promise<void>>` outside Zustand render state. Preserve the prior valid result on transient failure; add an error result only when the provider has never returned data. Derive `isStale` at read time from `lastSuccessAt` and the active interval rather than running a second timer.

Configured discovery should use the existing safe quota endpoint contract: an initial probe may identify `configured: true`, after which timed refreshes target only those IDs. Do not expose response content in logs.

- [x] **Step 5: Implement the single runtime owner**

Mount one `QuotaRefreshOwner` in `SyncAppEffects`, gated by `embeddedBackgroundWorkEnabled`. It calls `loadSettings`, starts the coordinator when runtime APIs are ready, and stops/clears timers on unmount. Manual surfaces call `refreshNow`/store actions but never create timers.

Remove `useQuotaAutoRefresh` imports/calls from Header, desktop chrome, VS Code layout, and Usage page. Preserve their manual refresh buttons.

- [x] **Step 6: Add authentication/config refresh hooks at existing success seams**

At the existing provider-auth/settings success callbacks, trigger coordinator rediscovery via one exported store/coordinator action. Do not add new polling in those components. If no shared seam exists, document it and add the narrowest event bridge rather than broad store subscriptions.

- [x] **Step 7: Run focused, affected, and source-ownership tests**

Run:

```bash
bun test packages/ui/src/stores/quota-refresh-coordinator.test.ts packages/ui/src/stores/useQuotaStore.test.ts
rg -n "useQuotaAutoRefresh|setInterval" packages/ui/src/components packages/ui/src/stores/useQuotaStore.ts
bun run validate:affected
```

Expected: no component owns quota intervals, all focused tests pass, and shared UI/web/VS Code validation passes.

- [x] **Step 8: Run runtime timing and failure scenarios**

With fake time in automation and one source app runtime manually, verify initial load, no overlap on rapid manual clicks, configured-provider filtering, transient error retaining last valid data, stale/error UI, rediscovery after provider change, and unmount cleanup. Record request counts only.

- [x] **Step 9: Review, document, and commit**

Update quota documentation with coordinator ownership and stale-data semantics. Run `git diff --check`, then:

```bash
git add packages/ui/src/stores/quota-refresh-coordinator.ts packages/ui/src/stores/quota-refresh-coordinator.test.ts packages/ui/src/stores/useQuotaStore.ts packages/ui/src/stores/useQuotaStore.test.ts packages/ui/src/apps/AppEffects.tsx packages/ui/src/components/layout/Header.tsx packages/ui/src/components/layout/DesktopRightChromeActions.tsx packages/ui/src/components/layout/VSCodeLayout.tsx packages/ui/src/components/sections/usage/UsagePage.tsx packages/web/server/lib/quota/DOCUMENTATION.md docs/audits/2026-07-10-devryan-reliability-pass.md
git commit -m "fix: centralize provider usage refresh"
```

---

### Task 7: Make Directory Disposal Release Directory-Owned State

**Files:**
- Modify: `packages/ui/src/sync/child-store.ts`
- Modify/add tests: `packages/ui/src/sync/child-store.status-subscription.test.ts`
- Modify: `packages/ui/src/sync/session-prefetch-cache.ts`
- Add: `packages/ui/src/sync/session-prefetch-cache.test.ts`
- Modify: `packages/ui/src/sync/pending-part-deltas.ts`
- Modify: `packages/ui/src/sync/pending-part-deltas.test.ts`
- Modify: `packages/ui/src/sync/session-children.ts`
- Modify: `packages/ui/src/sync/session-children.test.ts`
- Modify: `packages/ui/src/sync/event-pipeline.ts`
- Modify: `packages/ui/src/sync/event-pipeline.test.ts`
- Modify: `packages/ui/src/sync/sync-context.tsx`
- Modify: `packages/ui/src/sync/DOCUMENTATION.md`
- Modify: `docs/audits/2026-07-10-devryan-reliability-pass.md`

- [x] **Step 1: Add disposal tests before production changes**

Expose test-only size/read helpers only where black-box behavior cannot prove release. Tests must demonstrate:

- `disposeDirectory` calls registered disposers once;
- `disposeAll` calls each directory disposer and the configured ownership callback once;
- prefetch cache, in-flight markers, and completed revision bookkeeping cannot repopulate stale data after disposal;
- pending deltas/materialization timers for one directory are cleared without touching another;
- session-child cache entries for one directory are cleared;
- session/message routing entries for an evicted directory are removed; and
- an empty event-pipeline directory queue is deleted after flush/release.

- [x] **Step 2: Run focused tests and establish retained-entry counts**

Run:

```bash
bun test packages/ui/src/sync/child-store.status-subscription.test.ts packages/ui/src/sync/session-prefetch-cache.test.ts packages/ui/src/sync/pending-part-deltas.test.ts packages/ui/src/sync/session-children.test.ts packages/ui/src/sync/event-pipeline.test.ts
```

Expected: new disposal assertions fail against the current ownership gaps. Record retained entry counts after 100 synthetic create/dispose cycles.

- [x] **Step 3: Make `ChildStoreManager` the single disposal boundary**

Ensure both `disposeDirectory` and `disposeAll` perform the same per-directory sequence exactly once:

```ts
for (const dispose of lifecycle.disposers) dispose();
onDispose?.(directory, childStoreSnapshot);
delete child store, lifecycle, and pins;
```

Protect pinned, booting, loading, and blocking-request directories under the existing eviction rules.

- [x] **Step 4: Add directory release APIs to each owned cache**

Implement explicit functions such as:

```ts
clearSessionPrefetchDirectory(directory);
clearPendingPartDeltasForDirectory(directory);
clearSessionChildrenForDirectory(directory);
eventPipeline.releaseDirectory(directory);
```

For in-flight async work, increment or retain a generation token long enough that late completion cannot repopulate disposed state, then remove the token when no operation can reference it. Do not merely delete an in-flight promise and allow its continuation to write back.

- [x] **Step 5: Release routing and materialization state from sync context**

Use the disposed child-store snapshot to remove only session/message IDs owned by that directory. Cancel pending materialization timers and queued work for those IDs. Do not scan unrelated live session message collections on each event; disposal is a cold lifecycle edge where bounded scans are acceptable.

- [x] **Step 6: Run focused tests and the repaired stream benchmark**

Run:

```bash
bun test packages/ui/src/sync/child-store.status-subscription.test.ts packages/ui/src/sync/session-prefetch-cache.test.ts packages/ui/src/sync/pending-part-deltas.test.ts packages/ui/src/sync/session-children.test.ts packages/ui/src/sync/event-pipeline.test.ts
bun packages/ui/src/sync/__tests__/event-pipeline.bench.js
bun run validate:affected
```

Expected: disposal cycles return all directory-owned test counts to zero, unrelated directory state remains, stream bytes remain exact, and affected validation passes.

- [ ] **Step 7: Run repeated session/directory lifecycle profiling**

In the source app, repeat create/open/stream/abort/delete and directory switch cycles against the Test project. Record process count, renderer/OpenCode RSS, and retained directory/store counts after 1, 10, and 50 cycles. A material optimization requires a lower stable plateau or provably released retained objects; do not claim a leak fix from test counts alone.

Partial checkpoint: a clean source renderer completed 50 repeated switches
between two Test-project sessions with stable process/DOM counts and a narrow
post-GC heap plateau. Production-boundary tests cover actual directory release;
the full create/stream/abort/delete lifecycle repeat remains part of final
verification.

- [x] **Step 8: Review, document, and commit**

```bash
git add packages/ui/src/sync/child-store.ts packages/ui/src/sync/child-store.status-subscription.test.ts packages/ui/src/sync/session-prefetch-cache.ts packages/ui/src/sync/session-prefetch-cache.test.ts packages/ui/src/sync/pending-part-deltas.ts packages/ui/src/sync/pending-part-deltas.test.ts packages/ui/src/sync/session-children.ts packages/ui/src/sync/session-children.test.ts packages/ui/src/sync/event-pipeline.ts packages/ui/src/sync/event-pipeline.test.ts packages/ui/src/sync/sync-context.tsx packages/ui/src/sync/DOCUMENTATION.md docs/audits/2026-07-10-devryan-reliability-pass.md
git commit -m "fix: release directory-scoped sync resources"
```

---

### Task 7b: Reap Managed OpenCode During HMR Shutdown

**Files:**
- Modify: `scripts/dev-child-utils.mjs`
- Modify: `scripts/dev-web-hmr.mjs`
- Modify: `scripts/dev.test.mjs`
- Modify: `packages/web/server/lib/opencode/cli-entry-runtime.js`
- Add: `packages/web/server/lib/opencode/cli-entry-runtime.test.js`
- Modify: `scripts/codemap.md`
- Modify: `packages/web/server/lib/opencode/DOCUMENTATION.md`
- Modify: `docs/audits/2026-07-10-devryan-reliability-pass.md`

- [x] **Step 1: Reproduce both ownership failures**

Confirm that a detached wrapper leader can exit while another member of its
process group remains alive. Then run the source HMR stack and verify Ctrl+C
leaves the managed OpenCode process alive under PPID 1 after the watcher, API,
and Vite processes exit.

- [x] **Step 2: Add focused failing regressions**

Add a macOS process-group test proving `stopChildTree` does not return when only
the wrapper leader exited. Add a CLI-entry test proving watched development
servers still attach signal cleanup while leaving final exit-code ownership to
the watcher.

- [x] **Step 3: Fix the two lifecycle boundaries**

Keep polling and escalating against the detached process group after leader
exit, wire HMR to the shared helper, and attach the server's graceful signal
handler in direct dev CLI mode. Do not change Electron's in-process ownership
or the explicit dev-shutdown route contract.

- [x] **Step 4: Run focused, package, and live verification**

Run `bun run test:scripts`, the focused CLI-entry test, and the full web suite.
Start HMR against the Test project, capture every owned PID and listener, send
Ctrl+C, and prove all captured processes plus UI/API/OpenCode ports are gone.

- [x] **Step 5: Run affected validation, review, and commit**

Run `bun run validate:affected`, `git diff --check`, and a credential-prefix
scan, then commit only the lifecycle files and documentation:

```bash
git commit -m "fix: reap managed runtime on HMR shutdown"
```

---

### Task 8: Bound Cursor Agent Retention Without Evicting Active Runs

**Files:**
- Add: `packages/cursor-sdk-runtime/agent-cache.js`
- Add: `packages/cursor-sdk-runtime/agent-cache.test.js`
- Modify: `packages/cursor-sdk-runtime/persistent-worker.mjs`
- Modify: `packages/cursor-sdk-runtime/node-worker-runtime.test.js`
- Modify: `packages/cursor-sdk-runtime/codemap.md`
- Modify: `scripts/validate.mjs`
- Modify: `scripts/dev.test.mjs`
- Modify: `scripts/test-runner-utils.test.mjs`
- Modify: `scripts/codemap.md`
- Modify: `package.json`
- Modify: `docs/audits/2026-07-10-devryan-reliability-pass.md`

- [x] **Step 1: Add failing cache-policy tests**

Define a dependency-free cache contract:

```js
export function createAgentCache({ maxEntries, idleTtlMs, now, onEvict }) {
  return { get, set, markActive, markInactive, releaseSession, prune, clear, get size() {} };
}
```

Tests must prove LRU access ordering, idle TTL, `maxEntries = 16`, active-entry protection, temporary overflow when every entry is active, immediate prune after a run becomes inactive, session release, one `onEvict` call, and full shutdown clear.

- [x] **Step 2: Run the focused test and verify red**

Run:

```bash
node --test packages/cursor-sdk-runtime/agent-cache.test.js
```

Expected: module-not-found before implementation.

- [x] **Step 3: Implement the active-aware bounded cache**

Use `Map` insertion order for LRU. Never evict an active key. Prefer an idle entry older than 30 minutes, then the least-recently-used idle entry until at most 16 remain. If all entries are active, permit temporary overflow and prune synchronously after `markInactive`.

Agent provider/session identifiers remain in canonical session metadata; eviction discards only the in-process Agent object.

- [x] **Step 4: Wire lifecycle ownership into the persistent worker**

Replace `new Map()` with the helper. Mark the cache key active before streaming and inactive in every `finally` path. Release session entries on explicit session deletion/release when the worker protocol exposes it; otherwise rely on terminal prune plus TTL and document the missing release message. Clear the cache during worker shutdown.

- [x] **Step 5: Run worker and cache regression tests**

Run:

```bash
node --test packages/cursor-sdk-runtime/agent-cache.test.js
bun test packages/cursor-sdk-runtime/node-worker-runtime.test.js packages/cursor-sdk-runtime/streaming-emit.test.js
bun run validate:affected
```

Expected: cache bounds and active protection pass; Cursor streaming/cancellation behavior remains unchanged.

- [x] **Step 6: Profile repeated Cursor sessions**

Against the Test project, run at least 20 short Cursor sessions with distinct session/model cache keys, settle each, and record worker/process count and RSS after GC/idle opportunities available to the runtime. Confirm the worker cache stays at or below 16 idle entries and active runs are never evicted.

Completed checkpoint: the production cache helper retained 16 of 20 distinct
idle keys, closed the four capacity evictions, and returned to zero on shutdown.
Twenty real Test-project sessions then prewarmed 20/20 distinct Cursor Agents on
one persistent worker. Worker RSS was 101.3 MiB at 10 and 108.2 MiB at 20, then
59.5 MiB after all 20 sessions were deleted through the release protocol. All
temporary sessions were removed and the Test Git worktree remained clean.

- [x] **Step 7: Review, document, and commit**

```bash
git add packages/cursor-sdk-runtime/agent-cache.js packages/cursor-sdk-runtime/agent-cache.test.js packages/cursor-sdk-runtime/persistent-worker.mjs packages/cursor-sdk-runtime/node-worker-runtime.test.js packages/cursor-sdk-runtime/codemap.md docs/audits/2026-07-10-devryan-reliability-pass.md
git commit -m "fix: bound Cursor agent retention"
```

---

### Task 9: Preserve Provider-Native Details And Partial Failure Output

**Files:**
- Modify: `packages/ui/src/components/chat/message/parts/ToolPart.tsx`
- Add: `packages/ui/src/components/chat/message/parts/toolExpandedFallback.ts`
- Add: `packages/ui/src/components/chat/message/parts/toolExpandedFallback.test.ts`
- Modify: `packages/ui/src/lib/i18n/messages/en.ts`
- Modify: `packages/ui/src/components/chat/message/parts/TaskToolSummary.tsx`
- Modify: `packages/ui/src/components/chat/message/parts/taskToolUtils.ts`
- Modify: `packages/ui/src/components/chat/message/parts/TaskToolSummary.layout.test.ts`
- Modify: `packages/ui/src/components/chat/message/parts/taskToolUtils.test.ts`
- Modify: `packages/ui/src/components/chat/message/parts/DOCUMENTATION.md`
- Modify: `packages/cursor-sdk-runtime/index.js`
- Add: `packages/cursor-sdk-runtime/tool-call-normalize.test.js`
- Modify: `packages/cursor-sdk-runtime/node-worker-runtime.test.js`
- Modify: `docs/audits/2026-07-10-devryan-reliability-pass.md`

- [x] **Step 1: Add failing expansion fallback tests**

Create a pure selector that returns the first meaningful representation:

```ts
structuredDiffOrDiagnostic
  ?? structuredInput
  ?? structuredOrTextOutput
  ?? providerFailureReason
  ?? { kind: 'empty', messageKey: 'chat.tool.noDetails' };
```

Test write/create/file-write aliases with output-only payloads, error-only payloads, and truly empty payloads. Ensure empty strings/objects do not count as meaningful detail.

- [x] **Step 2: Add provider-native partial-output tests**

Extend Cursor runtime tests to emit substantial child text/tool output and then fail or abort. Assert:

- emitted partial text/tool results remain available;
- finish status is failed/aborted, never completed;
- failure reason remains attached;
- no post-abort event flood occurs; and
- any parent/task projection marks the output partial/interrupted.

- [x] **Step 3: Run focused tests and prove red**

Run:

```bash
bun test packages/ui/src/components/chat/message/parts/toolExpandedFallback.test.ts
bun test packages/cursor-sdk-runtime/tool-call-normalize.test.js
bun test packages/cursor-sdk-runtime/node-worker-runtime.test.js --test-name-pattern "provider-native task output|abortSession preserves provider-native task output"
```

Expected: empty-expansion case and any missing partial projection assertion fail before implementation.

- [x] **Step 4: Implement the smallest rendering fallback**

Keep existing structured diff/diagnostic rendering first. If it returns nothing, render sanitized provider output; then failure reason; finally the translated explicit no-details state. Never invent task state or reconstruct unavailable provider activity.

- [x] **Step 5: Preserve terminal partial semantics**

Adjust only the normalization/projection seam proven by the failing test. Preserve canonical provider/session/tool IDs and child message history. A failed or aborted task with useful content remains failed/aborted with `partial: true`; do not reopen or silently retry it.

- [x] **Step 6: Run focused, web, affected, and build validation**

Run:

```bash
bun test packages/ui/src/components/chat/message/parts/toolExpandedFallback.test.ts
bun test packages/cursor-sdk-runtime
bun run validate:affected
bun run build
```

Expected: provider-native tests pass, web/Electron/VS Code build boundaries remain green, and no provider content is added to fixtures.

- [x] **Step 7: Exercise ChatGPT/OpenAI, Copilot, and Cursor compatibility**

Using the Test project, record `pass`, `blocked`, or `not exposed` for ordinary chat, long stream, tool-heavy work, expandable details, native subagent/task activity, abort after partial work, and provider failure. Do not manufacture native subagents when the provider exposes none.

- [x] **Step 8: Review, document, and commit**

Run `git diff --check` and a secret scan over changed paths. Commit only the focused provider-native/rendering files and ledger:

```bash
git add packages/ui/src/components/chat/message/parts packages/ui/src/lib/i18n/messages/en.ts packages/cursor-sdk-runtime docs/audits/2026-07-10-devryan-reliability-pass.md docs/superpowers/plans/2026-07-10-devryan-stabilization-and-reliability.md
git commit -m "fix: preserve provider task details on failure"
```

Include any additional projection files only if their failing tests required production changes.

---

### Task 10: Stabilization Release Gate And Second-Phase Plan

**Files:**
- Modify: `docs/audits/2026-07-10-devryan-reliability-pass.md`
- Add after stabilization passes: `docs/superpowers/plans/2026-07-10-devryan-managed-orchestration.md`

- [ ] **Step 1: Inspect complete stabilization history and worktree**

Run:

```bash
git status --short
git log --oneline --decorate -15
git diff 42d0ae7f..HEAD --stat
git diff 42d0ae7f..HEAD --check
```

Expected: logical commits match Tasks 1–9, no unrelated changes, and no uncommitted product edits.

- [ ] **Step 2: Run full required validation with measurement**

Run:

```bash
/usr/bin/time -l bun run validate:full
/usr/bin/time -l bun run build
bun run electron:build
bun run vscode:build
```

Expected: all checks and packaging-sensitive builds pass. Record wall time and peak RSS alongside baseline. If a command fails, repair the responsible task before proceeding.

- [ ] **Step 3: Repeat sustained runtime/resource scenarios**

Run controlled short, long, concurrent, interrupted, resumed, tool-heavy, multi-question, background-session, quota, and repeated-session cases. Record process counts and RSS/CPU before/during/post-settlement using the same measurement method as baseline. Do not claim improvement where instrumentation differs.

- [ ] **Step 4: Perform security and scope review**

Run:

```bash
git diff --name-only 42d0ae7f..HEAD
git grep -nE '(sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|Authorization: Bearer|Fe26\.2\*\*)' 42d0ae7f..HEAD -- . ':!bun.lock'
```

Expected: no secrets, usage payloads, provider transcripts, or forbidden-upstream references were added.

- [ ] **Step 5: Finish the stabilization report**

The audit ledger must include:

- initial audit/baseline;
- implemented changes by subsystem;
- focused/full commands and results;
- before/after benchmark, memory, CPU, and process measurements;
- ChatGPT/OpenAI, Copilot, and Cursor compatibility matrix;
- blocked/not-exposed scenarios and why;
- remaining risks and recommendations; and
- concise changed-file/architecture summary.

- [ ] **Step 6: Write the separately gated managed-orchestration plan**

Use `superpowers:writing-plans` again. Trace every task to Workstreams 6–8 of the approved design. The second plan must specify the dependency-free `packages/orchestration-runtime` contract, max-three core scheduler, deterministic queue, idempotency, parent/child identity, mode lease, cancellation isolation, partial-result envelopes, persistence/restart reconciliation, web/Electron and VS Code adapters, narrow UI store, runtime test matrix, and final release gate.

Do not start scheduler implementation until stabilization validation and the audit matrix are green or limitations are explicitly recorded.

- [ ] **Step 7: Commit the gate documents**

```bash
git add docs/audits/2026-07-10-devryan-reliability-pass.md docs/superpowers/plans/2026-07-10-devryan-managed-orchestration.md
git commit -m "docs: gate DevRyan managed orchestration phase"
```

---

## Plan Self-Review Checklist

- [ ] Every production behavior change begins with a focused failing test.
- [ ] Commands use repository-supported Bun/Node entry points and state their expected red/green result.
- [ ] Existing user-owned sync edits remain isolated until Task 3.
- [ ] No task accesses forbidden repositories or adds dependencies.
- [ ] No provider-native event is counted as DevRyan-managed work.
- [ ] No quota component owns a timer after Task 6.
- [ ] Current-session green is prevented both at scheduling and rendering boundaries.
- [ ] Directory cleanup cannot allow late async completion to repopulate disposed state.
- [ ] Active Cursor Agents are never evicted.
- [ ] Performance claims use comparable before/after measurements and exact stream-byte integrity.
- [ ] Full validation, builds, runtime scenarios, secret scan, and complete diff review gate the second phase.
