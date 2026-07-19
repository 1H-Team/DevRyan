# ECC Wrapper Carrier Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and superpowers:verification-before-completion while executing this plan task-by-task.

**Goal:** Require a successful authoritative outer carrier exit before the canonical owned-test wrapper's private inner marker can become evaluator evidence.

**Architecture:** Keep direct-command outcome logic unchanged. In the wrapper-only branch, independently validate the strict Cursor envelope and bounded `state.metadata.exitCode`, reject invalid or conflicting carrier channels, require at least one authoritative outer exit of zero, and only then parse the private trailing marker from the appropriate raw or Cursor stdout carrier. Add test-only integration coverage that sends the actual Cursor runtime record through the evaluator collector.

**Tech Stack:** Node.js ESM, `node:test`, Vitest, Bun, Cursor SDK runtime fixture.

## Global Constraints

- Follow strict RED/GREEN TDD for the Important wrapper behavior.
- Preserve exact-empty and `null` Cursor no-signal acceptance and reject signaled envelopes.
- Keep raw command output, exit metadata, and session identifiers private.
- Do not change direct non-wrapper outcome behavior or add production dependencies/coupling.
- Restore the external Test fixture exactly after one pinned live Cursor repair run.
- Commit this follow-up separately from `9d2e6415`.

---

### Task 1: Fail closed on wrapper carrier evidence

**Files:**
- Modify: `scripts/agent-evals/client.test.mjs`
- Modify: `scripts/agent-evals/client.mjs`
- Modify: `scripts/agent-evals/codemap.md`

**Interfaces:**
- Consumes: `buildOwnedTestEvidenceCommand(path)` and `collectSanitizedTools(sessionTree, options)`.
- Produces: wrapper-only carrier validation inside `ownedTestExitCode(part, "wrapper", "completed")`; sanitized event shape remains unchanged.

- [ ] **Step 1: Write the failing wrapper carrier regressions**

Add real collector cases covering Cursor and metadata outer exits `1` and `137` with both marker `0` and marker `1`, Cursor/metadata disagreements in both directions, malformed metadata, marker-only output with no carrier, and accepted outer `0` with both GREEN and RED inner markers.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test --test-name-pattern="wrapper carrier" scripts/agent-evals/client.test.mjs`

Expected: FAIL because abnormal or absent outer carrier evidence currently still projects `ownedTestOutcome`.

- [ ] **Step 3: Implement the minimal wrapper-only check**

Within the wrapper branch, derive optional metadata and Cursor carrier exits, reject a present malformed metadata exit, reject an invalid Cursor envelope, reject differing present exits, require at least one present carrier exit, require every present carrier exit to equal zero, then parse the marker from strict Cursor stdout or raw output. Do not modify the direct branch.

- [ ] **Step 4: Run focused and complete evaluator suites to GREEN**

Run: `node --test --test-name-pattern="wrapper carrier" scripts/agent-evals/client.test.mjs`

Run: `node --test scripts/agent-evals/*.test.mjs`

Expected: all tests pass with no raw evidence projected.

### Task 2: Join the actual producer and consumer in one test

**Files:**
- Modify: `packages/web/server/lib/opencode/cursor-sdk-runtime.test.js`

**Interfaces:**
- Consumes: actual records returned by `createCursorSdkRuntime(...).getSessionMessages(...)` and test-only `collectSanitizedTools(...)`.
- Produces: one assertion that the provider edit survives sanitation while the runtime-derived synthetic patch card is excluded.

- [ ] **Step 1: Extend the existing synthetic-patch integration fixture**

Import the evaluator collector only in the test module, pass the actual runtime records through it with the actual root session identity, and assert the sanitized events contain exactly the completed real `edit` event.

- [ ] **Step 2: Run the focused integration test**

Run: `bun run --cwd packages/web test -- server/lib/opencode/cursor-sdk-runtime.test.js`

Expected: all focused runtime integration tests pass without new production coupling or dependencies.

### Task 3: Live recheck, documentation, and release gates

**Files:**
- Modify: `docs/audits/2026-07-15-ecc-performance-and-agent-eval-pass.md`
- Modify ignored report: `.superpowers/sdd/task-6-report.md`

**Interfaces:**
- Consumes: pinned Cursor repair configuration and exact fixture manifest helpers.
- Produces: sanitized audit evidence, a clean fixture, stopped source processes, and one standalone commit.

- [ ] **Step 1: Run one exact pinned live Cursor repair**

Use `cursor-acp/composer-2.5`, Builder, explicit `null` variant, `repair-and-test`, and one repetition. Require 1/1 run plus 3/3 graders, exact fixture restoration, and stopped source processes.

- [ ] **Step 2: Run the requested gates**

Run: `bun run validate:full`

Run: `bun run build`

Run: `bun run bundle:check`

Run: `bun run electron:build`

Run: `bun run vscode:build`

Expected: every command exits zero; Electron may retain the documented local notarization limitation while deep signature verification succeeds.

- [ ] **Step 3: Update sanitized evidence and commit separately**

Update the audit, ignored task report, and nearest codemap with final test counts and live duration. Run syntax, whitespace, fixture, listener, artifact-boundary, branding, and safety checks; then commit only the intended source, tests, plan, codemap, and audit files.
