# Full Reasoning Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve and display every reasoning part supplied by the runtime when reasoning traces are enabled, regardless of provider or activity-group expansion.

**Architecture:** Keep synchronization loss-preserving by limiting reasoning normalization to mechanical transport cleanup. Render reasoning once through the normal message-part path, while grouped activity continues to own tools and justification only. Use a small pure render-policy module so provider-neutral grouping and visibility rules have focused tests without mounting the full chat runtime.

**Tech Stack:** React, TypeScript, Zustand, Bun test, OpenCode SDK v2 message parts

## Global Constraints

- Work only inside `/Users/zoubair/Repositories/DevRyan`.
- Do not add dependencies or change runtime API contracts.
- Preserve the existing `showReasoningTraces` setting and its default.
- Keep web, Electron, and VS Code behavior aligned through shared UI code.
- Retain mechanical duplicate-frame and internal tool-runner diagnostic cleanup.
- Use test-first red/green cycles and run `bun run validate:affected` before completion.

---

### Task 1: Preserve reasoning in synchronization

**Files:**
- Modify: `packages/ui/src/sync/part-delta.test.ts`
- Modify: `packages/ui/src/sync/message-fetch.test.ts`
- Modify: `packages/ui/src/sync/pending-part-deltas.test.ts`
- Modify: `packages/ui/src/sync/__tests__/event-reducer.test.ts`
- Modify: `packages/ui/src/sync/part-delta.ts`

**Interfaces:**
- Consumes: runtime `Part` records whose `type` is `reasoning`.
- Produces: `normalizeAssistantReasoningText(value: string): string`, preserving model-authored prose while retaining mechanical normalization.

- [x] **Step 1: Replace destructive normalization expectations with preservation tests**

Update `part-delta.test.ts` and `message-fetch.test.ts` so intent restatements, skill/action narration, headings, and dangling list fragments remain unchanged. Add one reasoning case containing an explicit internal diagnostic and verify only the diagnostic is removed.

```ts
const completeReasoning = `${meta}\n\n${reasoning}`
expect(normalizeAssistantReasoningText(completeReasoning)).toBe(completeReasoning)
```

- [x] **Step 2: Add live-path regression tests**

In `pending-part-deltas.test.ts`, exercise `applyPendingPartDeltasToParts` with `sanitizeAssistantText: true` and assert a reasoning delta containing `The user requests...` is preserved. In `event-reducer.test.ts`, complete an assistant reasoning message and assert the same semantic text survives final normalization.

- [x] **Step 3: Run the sync tests and verify the new expectations fail**

Run:

```bash
bun test packages/ui/src/sync/part-delta.test.ts packages/ui/src/sync/message-fetch.test.ts packages/ui/src/sync/pending-part-deltas.test.ts packages/ui/src/sync/__tests__/event-reducer.test.ts
```

Expected: failures show semantic reasoning text is still being removed.

- [x] **Step 4: Make reasoning normalization mechanical only**

Delete the reasoning semantic-pattern constants and helpers from `part-delta.ts`. Keep visible-text compatibility cleanup separate, and implement reasoning normalization with only duplicate-frame and internal-diagnostic cleanup:

```ts
export function normalizeAssistantReasoningText(value: string): string {
  return stripInternalToolRunnerDiagnostics(collapseExactAdjacentTextRepeats(value))
}
```

- [x] **Step 5: Re-run the sync tests**

Run the command from Step 3. Expected: all selected tests pass with zero failures.

### Task 2: Render reasoning inline for every provider

**Files:**
- Create: `packages/ui/src/components/chat/message/reasoningRenderPolicy.ts`
- Create: `packages/ui/src/components/chat/message/reasoningRenderPolicy.test.ts`
- Modify: `packages/ui/src/components/chat/message/parts/ReasoningPart.test.tsx`
- Modify: `packages/ui/src/components/chat/message/parts/ReasoningPart.tsx`
- Modify: `packages/ui/src/components/chat/message/MessageBody.tsx`

**Interfaces:**
- Produces: `filterGroupedActivityReasoning<T extends { kind: string }>(parts: T[]): T[]`.
- Produces: `shouldRenderInlineReasoning(showReasoningTraces: boolean): boolean`.
- Consumes: `TurnActivityRecord[]` and the existing `showReasoningTraces` flag.

- [x] **Step 1: Add failing render-policy and renderer tests**

Create pure tests proving grouped previews exclude reasoning while retaining tools and justification, and the inline visibility policy mirrors the global setting:

```ts
expect(filterGroupedActivityReasoning([
  { id: 'r1', kind: 'reasoning' },
  { id: 't1', kind: 'tool' },
])).toEqual([{ id: 't1', kind: 'tool' }])
expect(shouldRenderInlineReasoning(true)).toBe(true)
expect(shouldRenderInlineReasoning(false)).toBe(false)
```

Update `ReasoningPart.test.tsx` so Cursor-marked reasoning is expected inline with no `<details>` element and semantic prose is preserved.

- [x] **Step 2: Run the rendering tests and verify failure**

Run:

```bash
bun test packages/ui/src/components/chat/message/reasoningRenderPolicy.test.ts packages/ui/src/components/chat/message/parts/ReasoningPart.test.tsx
```

Expected: the policy module is missing and the current Cursor renderer still emits `<details>`.

- [x] **Step 3: Implement provider-neutral inline rendering**

Add the pure policy functions. In `ReasoningPart.tsx`, remove sync normalization, Cursor metadata detection, the `compact` prop, and the `<details>` branch. Keep quote-prefix/blank-line presentation cleanup, throttling, and the empty active “Thinking…” indicator.

In `MessageBody.tsx`, filter reasoning out of grouped activity segments with `filterGroupedActivityReasoning`, then allow every visible reasoning part through the normal part loop when `shouldRenderInlineReasoning(showReasoningTraces)` is true. Remove the branch that skips reasoning merely because it has an activity projection.

- [x] **Step 4: Re-run the rendering tests**

Run the command from Step 2. Expected: all selected tests pass with zero failures.

- [x] **Step 5: Run all focused changed-path tests together**

```bash
bun test packages/ui/src/sync/part-delta.test.ts packages/ui/src/sync/message-fetch.test.ts packages/ui/src/sync/pending-part-deltas.test.ts packages/ui/src/sync/__tests__/event-reducer.test.ts packages/ui/src/components/chat/message/reasoningRenderPolicy.test.ts packages/ui/src/components/chat/message/parts/ReasoningPart.test.tsx
```

Expected: all tests pass with zero failures.

### Task 3: Validate and finish

**Files:**
- Modify if required: `packages/ui/codemap.md` only if ownership or entrypoints changed; no update is expected for this focused behavior change.

**Interfaces:**
- Consumes: all Task 1 and Task 2 changes.
- Produces: a validated shared UI change ready for integration.

- [x] **Step 1: Run affected validation**

```bash
bun run validate:affected
```

Expected: affected lint, type checks, and tests exit successfully.

- [x] **Step 2: Review scope and whitespace**

```bash
git diff --check
git status --short
git diff --stat
```

Expected: no whitespace errors and only the plan plus intended shared UI/test files are changed.

- [x] **Step 3: Commit the implementation**

```bash
git add docs/superpowers/plans/2026-07-12-full-reasoning-output.md packages/ui/src/sync packages/ui/src/components/chat/message
git commit -m "fix: show complete reasoning output"
```
