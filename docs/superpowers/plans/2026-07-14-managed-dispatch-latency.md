# Managed Dispatch Latency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the avoidable todo-only model round before an already-decided managed dispatch and show authoritative-safe Agent Dispatch feedback while the child task is being prepared.

**Architecture:** Keep the scheduler, durable ledger, orchestration store, and child-session contract unchanged. Improve first-action selection through the managed tool description plus the packaged orchestrator prompt, then derive a presentation-only provisional row from the active `devryan_task start` tool part until completed output provides the existing authoritative task ID.

**Tech Stack:** Bun, Vitest, React, TypeScript, Zustand selectors, Tailwind v4, OpenCode plugin tools.

## Global Constraints

- Do not change scheduler submission, persistence, child-session creation, queueing, barrier, retry, resume, cancellation, or concurrency behavior.
- Do not overwrite user-modified runtime agent files or add prompt bodies to runtime overlays.
- Do not add dependencies or persisted state.
- Provisional dispatch data is display-only; task IDs and child session IDs remain authoritative server/store data.
- Preserve the unrelated uncommitted reasoning and visual-settings work already present in the main checkout.
- Keep shared UI behavior identical across web, Electron, and VS Code.

---

### Task 1: Direct-start instruction for managed delegation

**Files:**
- Modify: `packages/web/server/default-config/plugins/devryan-managed-orchestration.test.mjs`
- Modify: `packages/web/server/lib/opencode/packaged-agent-defaults.test.js`
- Modify: `packages/web/server/default-config/plugins/devryan-managed-orchestration.mjs`
- Modify: `packages/web/server/default-config/agents/orchestrator.md`

**Interfaces:**
- Consumes: OpenCode's existing `tool({ description, args, execute })` definition and packaged agent markdown loader.
- Produces: A direct-start instruction visible through both customized-agent tool metadata and the clean-install orchestrator prompt.

- [ ] **Step 1: Add failing tool-description and packaged-prompt assertions**

Add this assertion after the plugin tool-name assertion in the first managed-orchestration plugin test:

```js
expect(plugin.tool.devryan_task.description).toContain(
  'start it before any standalone todo read/write whose only purpose is to restate that delegation',
);
```

Add this assertion to `orchestrator prompt stays condensed while preserving routing contracts`:

```js
expect(content).toContain(
  'start it before any standalone todo read/write whose only purpose is to restate that delegation',
);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
bunx vitest run packages/web/server/default-config/plugins/devryan-managed-orchestration.test.mjs packages/web/server/lib/opencode/packaged-agent-defaults.test.js
```

Expected: both new assertions fail because the direct-start sentence is absent.

- [ ] **Step 3: Add the minimal direct-start instruction**

Extend the `devryan_task` description with this exact sentence:

```text
When managed delegation is already the decided next action, start it before any standalone todo read/write whose only purpose is to restate that delegation.
```

Add the same sentence to the `**DevRyan-managed delegation.**` paragraph in `orchestrator.md`, immediately after the existing preference for `devryan_task` with `action: start`.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the same Vitest command from Step 2.

Expected: both files pass with zero failures.

- [ ] **Step 5: Commit Task 1**

```bash
git add packages/web/server/default-config/plugins/devryan-managed-orchestration.test.mjs \
  packages/web/server/lib/opencode/packaged-agent-defaults.test.js \
  packages/web/server/default-config/plugins/devryan-managed-orchestration.mjs \
  packages/web/server/default-config/agents/orchestrator.md
git commit -m "perf: start decided managed dispatches directly"
```

---

### Task 2: Provisional Agent Dispatch presentation

**Files:**
- Modify: `packages/ui/src/components/chat/ManagedTaskList.test.tsx`
- Modify: `packages/ui/src/components/chat/managedTaskDispatch.ts`
- Modify: `packages/ui/src/components/chat/ManagedTaskList.tsx`
- Modify: `packages/ui/src/components/chat/message/MessageBody.tsx`
- Modify: `packages/ui/src/lib/i18n/messages/en.ts`

**Interfaces:**
- Consumes: Active managed tool parts with `state.status`, `state.input.action`, `state.input.agent`, and `state.input.label`; authoritative managed task IDs parsed from completed tool output.
- Produces: `PendingManagedTaskDispatch` records and a `pendingDispatches` presentation prop. No store mutation or navigation capability is produced.

- [ ] **Step 1: Add failing resolver tests for active, terminal, and parallel starts**

Import the pending row view from `ManagedTaskList` next to the existing dynamic `ManagedTaskRow` import:

```ts
const { ManagedTaskPreparingRow } = await import('./ManagedTaskList');
```

Add resolver tests using these representative parts:

```ts
test('surfaces an active managed start before an authoritative task id exists', () => {
  expect(resolveManagedTaskDispatch([{
    id: 'start-part',
    type: 'tool',
    tool: 'devryan_task',
    state: {
      status: 'running',
      input: { action: 'start', agent: 'explorer', label: 'workspace-surface_map' },
    },
  }] as never)).toEqual({
    anchorPartId: 'start-part',
    taskIds: [],
    pendingDispatches: [{
      partId: 'start-part',
      agent: 'explorer',
      label: 'workspace-surface_map',
    }],
  });
});

test('replaces provisional dispatch data with the authoritative task id', () => {
  expect(resolveManagedTaskDispatch([{
    id: 'start-part',
    type: 'tool',
    tool: 'devryan_task',
    state: {
      status: 'completed',
      input: { action: 'start', agent: 'explorer', label: 'workspace-surface_map' },
      output: JSON.stringify({ task: { taskId: 'dvr_task_start' } }),
    },
  }] as never)).toEqual({
    anchorPartId: 'start-part',
    taskIds: ['dvr_task_start'],
    pendingDispatches: [],
  });
});

test('does not strand a provisional row after a terminal start failure', () => {
  expect(resolveManagedTaskDispatch([{
    id: 'start-part',
    type: 'tool',
    tool: 'devryan_task',
    state: {
      status: 'error',
      input: { action: 'start', agent: 'explorer', label: 'workspace-surface_map' },
      error: 'bridge offline',
    },
  }] as never)).toEqual({
    anchorPartId: null,
    taskIds: [],
    pendingDispatches: [],
  });
});
```

Extend the existing start/retry/wait expectation with `pendingDispatches: []`, and add a parallel-active-start case that expects two distinct records in source-part order.

- [ ] **Step 2: Add a failing render test for preparing state**

Add:

```tsx
test('renders a provisional dispatch without exposing child navigation', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <ManagedTaskPreparingRow dispatch={{
        partId: 'start-part',
        agent: 'explorer',
        label: 'workspace-surface_map',
      }} />
    </I18nProvider>,
  );

  expect(html).toContain('Workspace surface map');
  expect(html).toContain('Preparing...');
  expect(html).not.toContain('Open Subtask');
});
```

- [ ] **Step 3: Run the focused UI test and verify RED**

Run:

```bash
bun test packages/ui/src/components/chat/ManagedTaskList.test.tsx
```

Expected: the new pending type/export/expectations fail because provisional dispatches are not implemented.

- [ ] **Step 4: Implement pending dispatch extraction**

In `managedTaskDispatch.ts`, export:

```ts
export type PendingManagedTaskDispatch = {
  partId: string;
  agent: string;
  label: string;
};
```

During the existing single pass, continue to parse authoritative IDs first. When no ID exists, include a provisional record only if action is `start` and status is `pending` or `running`. Normalize agent and label strings; use `agent || 'agent'` and `label || `Managed ${agent || 'agent'} task``. Set `anchorPartId` from the first authoritative or provisional record. Return `{ anchorPartId, taskIds, pendingDispatches }`.

- [ ] **Step 5: Implement the display-only preparing row and grouping**

In `ManagedTaskList.tsx`, import `formatManagedTaskDisplayName` and the pending type. Export a memoized view with the same row geometry as `ManagedTaskRowView`:

```tsx
export const ManagedTaskPreparingRow = React.memo(({
  dispatch,
}: {
  dispatch: PendingManagedTaskDispatch;
}) => {
  const { t } = useI18n();
  return (
    <article data-managed-task-pending-id={dispatch.partId}>
      <div className="flex min-w-0 items-center gap-3 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <h4 className="truncate typography-ui-label font-medium text-foreground">
            {formatManagedTaskDisplayName(dispatch.label)}
          </h4>
          <p role="status" className="truncate typography-meta text-muted-foreground">
            {t('chat.managedTasks.summary.preparing')}
          </p>
        </div>
      </div>
    </article>
  );
});
```

Add optional `pendingDispatches` to `ManagedTaskList`, include their count in render visibility and layout notification, and merge them into the existing case-insensitive agent groups. Each group renders authoritative `ManagedTaskRow` children followed by its active `ManagedTaskPreparingRow` children. This keeps a single agent header during the provisional-to-authoritative transition.

Add this English copy beside the existing running summary:

```ts
'chat.managedTasks.summary.preparing': 'Preparing...',
```

- [ ] **Step 6: Anchor the provisional card in the assistant message**

In the existing managed-tool branch of `MessageBody.tsx`, render `ManagedTaskList` when either authoritative IDs or provisional records exist:

```tsx
if (
  toolPart.id === managedTaskDispatch.anchorPartId
  && (managedTaskDispatch.taskIds.length > 0 || managedTaskDispatch.pendingDispatches.length > 0)
) {
  rendered.push(
    <ManagedTaskList
      key={`managed-task-dispatch-${messageId}`}
      taskIds={managedTaskDispatch.taskIds}
      pendingDispatches={managedTaskDispatch.pendingDispatches}
      onContentChange={onContentChange}
    />,
  );
}
```

Keep the surrounding user-authored reasoning-presentation edits intact.

- [ ] **Step 7: Run the focused UI test and verify GREEN**

Run:

```bash
bun test packages/ui/src/components/chat/ManagedTaskList.test.tsx
```

Expected: all tests pass with zero failures.

- [ ] **Step 8: Commit Task 2**

Stage only the task's intended hunks. Because `MessageBody.tsx` and `en.ts` contain unrelated user changes, inspect `git diff` and use patch staging if a commit is created; never stage the unrelated hunks.

```bash
git diff --check -- packages/ui/src/components/chat/ManagedTaskList.test.tsx \
  packages/ui/src/components/chat/managedTaskDispatch.ts \
  packages/ui/src/components/chat/ManagedTaskList.tsx \
  packages/ui/src/components/chat/message/MessageBody.tsx \
  packages/ui/src/lib/i18n/messages/en.ts
```

Expected: no whitespace errors. If clean hunk-only staging cannot be guaranteed, leave implementation changes uncommitted rather than including user work.

---

### Task 3: Validation and live visual regression test

**Files:**
- Verify only; no planned source changes.

**Interfaces:**
- Consumes: DevRyan changed-file validation, web server tests, local browser UI, and Test project runtime.
- Produces: Fresh automated and visual evidence for the direct-start and provisional-to-authoritative transition.

- [ ] **Step 1: Run focused server and UI tests together**

```bash
bunx vitest run packages/web/server/default-config/plugins/devryan-managed-orchestration.test.mjs packages/web/server/lib/opencode/packaged-agent-defaults.test.js
bun test packages/ui/src/components/chat/ManagedTaskList.test.tsx
```

Expected: zero failures.

- [ ] **Step 2: Run affected validation and the web server suite**

```bash
bun run validate:affected
bun run --cwd packages/web test
```

Expected: zero failures. If unrelated current work causes failures, separate those diagnostics from failures in the files changed by this plan.

- [ ] **Step 3: Build the browser-tested web artifact**

```bash
bun run --cwd packages/web build
```

Expected: exit code 0.

- [ ] **Step 4: Repeat the live Test-project dispatch trace**

Start DevRyan with `/Users/zoubair/Repositories/Test` as the runtime directory and send:

```text
Dispatch one Explorer subtask to list the top-level files and directories in this Test project. Wait for it, then summarize. Do not edit files.
```

Capture timestamps for user message, first tool call, managed start, task creation, child session, first child output, and completion. Verify no standalone todo-only model round precedes the managed start.

- [ ] **Step 5: Verify the UI visually at desktop and narrow widths**

Using the in-app browser:

- Capture the Agent Dispatch card while it reads `Preparing...` and verify no `Open Subtask` button exists.
- Capture the authoritative running row and verify exactly one `Open Subtask` button appears after `childSessionId` exists.
- Open the subtask and verify the child session route and output.
- Repeat at a narrow viewport and verify no clipping, duplicated card, or horizontal overflow.

- [ ] **Step 6: Verify repository and Test-project state**

```bash
git status --short --branch
git -C /Users/zoubair/Repositories/Test status --short --branch
```

Expected: Test remains unchanged; DevRyan contains only intended implementation plus the previously identified user changes.

- [ ] **Step 7: Review the diff against the design requirements**

Confirm line by line that:

- direct start is guidance, not a weakened safety gate;
- no scheduler/store contract changed;
- pending records cannot navigate;
- terminal failures clear provisional state;
- authoritative IDs and child sessions retain their validators;
- unrelated user edits remain present and unstaged.
