# Agent Evaluation Causal Repair Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make repair-and-test grading accept only a root-session read → RED → mutation → GREEN sequence whose authoritative tool intervals are finite, unambiguous, and non-overlapping.

**Architecture:** `client.mjs` will retain raw tool intervals in a module-private `WeakMap` exposed through a tiny internal evidence module, so timestamps never become enumerable sanitized fields. `graders.mjs` will consume and delete those intervals, find one deterministic causal chain, and only then add safe ordinals to the selected events. Failed or ambiguous grading leaves no usable ordinal chain, while reports continue receiving only existing whitelist projections.

**Tech Stack:** Node.js ESM, `node:test`, private `WeakMap` state, Bun workspace validation.

## Global Constraints

- Strict TDD: change tests first and observe the expected failure before production edits.
- Work only in `/Users/zoubair/Repositories/DevRyan/.worktrees/ecc-performance-pass`.
- Do not call live providers or use the configured evaluation fixture.
- All selected evidence intervals require finite non-negative `start` and `end` values with `start <= end`.
- Adjacent boundaries are valid when `previous.end <= next.start`; tied completion timestamps remain ambiguous.
- Repair-relevant evidence must remain root-session-only.
- Raw commands, output, exit codes, timestamps, and session IDs must never enter reportable projections.

---

### Task 1: Add causal-chain regression coverage

**Files:**
- Modify: `scripts/agent-evals/graders.test.mjs`
- Modify: `scripts/agent-evals/client.test.mjs`

**Interfaces:**
- Consumes: `collectSanitizedTools(sessionTree, options)` and `gradeToolRequirements('repair-and-test', events)`.
- Produces: executable specifications for overlapping, boundary, invalid/tied, privacy, and multiple-candidate behavior.

- [x] **Step 1: Add a timed repair-event fixture helper**

Build real tool parts with root session identity, `state.time.start/end`, exact owned-test commands, and structured exit codes. Feed them through `collectSanitizedTools` instead of fabricating reportable timing fields.

- [x] **Step 2: Add the adversarial overlapping regression**

Use read `[1,10]`, RED `[5,20]`, mutation `[6,30]`, and GREEN `[7,40]`. Assert repair grading fails and no event receives a usable ordinal chain.

- [x] **Step 3: Add positive boundary and multiple-candidate regressions**

Assert `[1,10] → [10,20] → [20,30] → [30,40]` passes. Add invalid-first RED/mutation/GREEN candidates followed by one valid causal combination; assert only that selected combination receives ordinals `1..4`.

- [x] **Step 4: Add invalid/tied/privacy assertions**

Assert missing, non-finite, reversed, or tied completion timing cannot establish a chain. Assert `JSON.stringify(events)` contains no `start`, `end`, `time`, command, output, numeric exit metadata, or raw session ID before or after grading.

- [x] **Step 5: Run tests to verify RED**

Run: `node --test --test-name-pattern='causal|overlap|boundary|multiple candidate' scripts/agent-evals/client.test.mjs scripts/agent-evals/graders.test.mjs`

Expected: the overlapping fixture is incorrectly accepted and/or every event already receives completion-order ordinals, proving the current implementation lacks causal interval validation.

### Task 2: Retain private timing and grade one causal chain

**Files:**
- Create: `scripts/agent-evals/tool-evidence.mjs`
- Modify: `scripts/agent-evals/client.mjs`
- Modify: `scripts/agent-evals/graders.mjs`

**Interfaces:**
- Produces: `retainPrivateToolInterval(event, interval)` and `consumePrivateToolIntervals(events)` backed by a module-private `WeakMap`.
- Consumes: sanitized event references and raw `part.state.time.start/end` values.

- [x] **Step 1: Implement the private interval handoff**

Store `{ start, end }` only in a module-private `WeakMap`. `consumePrivateToolIntervals(events)` must return a local `Map` keyed by event reference and delete every corresponding `WeakMap` entry immediately.

- [x] **Step 2: Stop assigning completion-order ordinals in the client**

Keep sanitized enumerable fields limited to `tool`, `status`, `final`, `sessionScope`, and optional `ownedTestOutcome`. Register raw start/end values privately for each event and preserve traversal order.

- [x] **Step 3: Select a deterministic causal chain in the grader**

Drain timing at the start of `gradeToolRequirements`. For repair evidence, reject child-session relevant events, validate intervals, withhold candidates whose completion time is tied, and search sorted candidates for read/end `<=` RED/start, RED/end `<=` mutation/start, and mutation/end `<=` GREEN/start. Search every candidate combination so an early invalid candidate cannot hide a later valid chain.

- [x] **Step 4: Project ordinals only after selection**

When a chain exists, assign ordinals `1..4` only to its read, RED, mutation, and GREEN events. When no chain exists, leave all events without usable ordinals and return the stable failed grader result.

- [x] **Step 5: Run focused tests to verify GREEN**

Run: `node --test scripts/agent-evals/client.test.mjs scripts/agent-evals/graders.test.mjs`

Expected: every client and grader test passes, including overlap rejection and boundary/multiple-candidate acceptance.

### Task 3: Update injected harness fixtures and documentation

**Files:**
- Modify: `scripts/agent-evals/cases.test.mjs`
- Modify: `scripts/agent-evals/runner.test.mjs`
- Modify: `scripts/agent-evals/codemap.md`
- Modify: `.superpowers/sdd/task-5-report.md` (ignored evidence report)

**Interfaces:**
- Consumes: `retainPrivateToolInterval` for tests that inject already-sanitized session results.
- Produces: integration fixtures that exercise the same private timing contract as real client output.

- [x] **Step 1: Give injected repair evidence finite non-overlapping intervals**

Replace ordinal-only repair fixtures with privately registered intervals such as read `[1,10]`, RED `[10,20]`, mutation `[20,30]`, and GREEN `[30,40]`.

- [x] **Step 2: Update module documentation**

Document that repair grading consumes private tool intervals, accepts only a unique-timestamp non-overlapping root chain, and retains only selected safe ordinals.

- [x] **Step 3: Run the complete native harness**

Run: `node --test scripts/agent-evals/*.test.mjs`

Expected: all harness tests pass with zero failures.

### Task 4: Verify, report, and commit

**Files:**
- Modify: `.superpowers/sdd/task-5-report.md` (ignored evidence report)
- Commit: all tracked Task 5 causal-ordering changes in one separate commit.

**Interfaces:**
- Produces: fresh verification evidence and one commit SHA for the parent task.

- [x] **Step 1: Run declared Node 20 coverage**

Run: `npx --yes node@20 --test scripts/agent-evals/*.test.mjs`

Expected: all tests pass under Node v20.20.2 with zero failures or cancellations.

- [x] **Step 2: Run repository script and affected validation**

Run: `bun run test:scripts`

Run: `bun run validate:affected`

Expected: script tests, full lint, type-check, and all affected/full tests pass.

- [x] **Step 3: Run static and safety checks**

Run `git diff --check`, `node --check scripts/agent-evals/*.mjs`, and the existing destructive-command/shell/upstream-reference safety scan.

Expected: every command exits zero and no forbidden production pattern is found.

- [x] **Step 4: Append the Task 5 report**

Record exact RED/GREEN counts, final suite counts, privacy behavior, and that no live or billable provider was called.

- [x] **Step 5: Commit separately**

Run: `git add scripts/agent-evals docs/superpowers/plans/2026-07-16-agent-eval-causal-repair-evidence.md`

Run: `git commit -m "fix(scripts): require causal repair evidence"`

Expected: one new commit containing only this final P1 remediation and its tracked plan/documentation.
