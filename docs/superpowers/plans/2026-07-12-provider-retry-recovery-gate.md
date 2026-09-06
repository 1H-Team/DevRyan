# Provider Retry Recovery Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent live provider retry events from aborting active turns or showing model recovery while preserving explicit Stop and terminal-error recovery behavior.

**Architecture:** Remove automatic retry interception from the sync event boundary and keep the abort guard manual-only. Continue using the existing active-to-idle terminal error hook as the sole recovery-card gate for standard provider failures.

**Tech Stack:** React, TypeScript, Zustand, Bun test

## Global Constraints

- Work only inside `/Users/zoubair/Repositories/DevRyan`.
- Do not add dependencies.
- Preserve shared web and Electron behavior through the shared UI sync layer.
- Keep hot-path state updates narrow and source-of-truth-driven.

---

### Task 1: Make provider retries authoritative

**Files:**
- Modify: `packages/ui/src/sync/sync-context.plan-lifecycle.test.ts`
- Modify: `packages/ui/src/sync/sync-context.tsx`
- Modify: `packages/ui/src/sync/abort-retry-guard.ts`
- Modify: `packages/ui/src/sync/abort-retry-guard.test.ts`

**Interfaces:**
- Consumes: OpenCode `SessionStatus` events and the existing `registerManualAbortGuard()` API.
- Produces: `session.status: retry` remains unchanged unless a manual abort guard is already active.

- [ ] **Step 1: Write the failing sync-boundary regression test**

Change the existing deterministic retry test to assert that the retry does not activate a guard and remains authoritative:

```ts
test("keeps an unguarded provider retry authoritative at the sync event boundary", () => {
  // existing child-store setup
  const retry = {
    type: "retry",
    attempt: 1,
    message: "Model not found gpt-5.6-luna",
    next: Date.now() + 1_000,
  } as SessionStatus

  applySyncEventForTest(DIRECTORY, sessionStatusEvent(retry), childStores, routingIndexFor([]))

  expect(isAbortGuardActive(SESSION_ID)).toBe(false)
  expect(store.getState().session_status[SESSION_ID]).toEqual(retry)
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun test packages/ui/src/sync/sync-context.plan-lifecycle.test.ts -t "keeps an unguarded provider retry authoritative"`

Expected: FAIL because the current handler registers an abort guard and stores `{ type: "idle" }`.

- [ ] **Step 3: Remove automatic retry interception**

In `sync-context.tsx`, keep status observation but remove the `registerProviderRetryAbortGuard()` call and immediate `offerRecovery()` path:

```ts
if (payload.type === "session.status") {
  const sessionID = getSessionIdFromPayload(payload)
  if (sessionID) markStatusEventObserved(resolvedDirectory, sessionID)
}
```

Remove the now-unused provider recovery imports from that file. Delete `registerProviderRetryAbortGuard()` from `abort-retry-guard.ts`; manual registration remains owned by `registerManualAbortGuard()`.

- [ ] **Step 4: Align abort-guard unit tests with manual ownership**

Remove tests that explicitly register all provider retry statuses. Keep and run the tests that prove an unguarded retry passes through and that a manually guarded retry is coerced and re-aborted.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
bun test packages/ui/src/sync/sync-context.plan-lifecycle.test.ts packages/ui/src/sync/abort-retry-guard.test.ts packages/ui/src/hooks/providerErrorRecoveryDecision.test.ts
```

Expected: all selected tests pass.

### Task 2: Correct recovery ownership documentation

**Files:**
- Modify: `packages/ui/src/stores/DOCUMENTATION.md`
- Modify: `packages/ui/src/sync/DOCUMENTATION.md`

**Interfaces:**
- Consumes: behavior established in Task 1.
- Produces: documentation that identifies terminal assistant errors as the recovery-card source and explicit Stop as the abort-guard source.

- [ ] **Step 1: Update provider recovery documentation**

Document that live retries stay authoritative, terminal errors create recovery through `useProviderErrorRecovery`, and only explicit Stop activates the retry abort guard.

- [ ] **Step 2: Verify documentation contains no stale automatic-retry claim**

Run:

```bash
rg -n "Every provider retry|first provider retry|never permits OpenCode's backoff" packages/ui/src/stores/DOCUMENTATION.md packages/ui/src/sync/DOCUMENTATION.md
```

Expected: no matches.

### Task 3: Validate the regression fix

**Files:**
- Verify all files changed by Tasks 1 and 2.

**Interfaces:**
- Consumes: completed implementation and regression coverage.
- Produces: evidence that the shared UI remains valid.

- [ ] **Step 1: Run affected validation**

Run: `bun run validate:affected`

Expected: exit code 0.

- [ ] **Step 2: Re-run the live Test project prompt**

Observe the directory event stream while sending a read-only prompt. If a retry occurs, verify that the UI remains in retry/working state and no recovery card appears before an authoritative terminal error.

- [ ] **Step 3: Review the final diff**

Run: `git diff --check && git diff --stat && git status --short`

Expected: no whitespace errors and only the planned UI sync, test, documentation, spec, and plan files are changed.
