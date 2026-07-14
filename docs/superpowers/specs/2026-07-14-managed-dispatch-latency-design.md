# Managed Dispatch Latency Design

## Problem

A live dispatch probe from `/Users/zoubair/Repositories/Test` completed correctly and left the project unchanged, but exposed three separate waits. The parent model spent about 39 seconds before starting the managed task because it emitted a standalone `todowrite` call and then needed another model round to call `devryan_task`. Once that call started, the durable scheduler created and linked the child in about five seconds. The child model then needed about 15 seconds to produce its first meaningful reasoning text.

The avoidable delay is the extra parent-model round. The scheduler interval protects durable task ownership, while the child-output interval is provider/model latency. The UI also renders nothing for an active `devryan_task start` part until the completed tool output contains an authoritative `dvr_task_` ID, so the user receives no dispatch-specific feedback during the scheduler interval.

## Desired Behavior

- When managed delegation is already the decided next action, the orchestrator starts it without a standalone todo read/write whose only purpose is to restate that delegation.
- As soon as a `devryan_task start` tool part is pending or running, the assistant turn shows an Agent Dispatch card with the requested agent, task label, and `Preparing...` status.
- The provisional row never shows `Open Subtask` because no authoritative child session exists yet.
- When the tool output supplies a valid managed task ID, the provisional row is replaced by the existing store-backed task row. The existing button appears only after that task receives an authoritative `childSessionId`.
- Completed, failed, or malformed starts without a task ID do not leave a permanent provisional row.
- Existing retry, resume, wait, cancellation, barrier, queue, persistence, and concurrency behavior remains unchanged.

## Scope and Architecture

The parent-model optimization will be expressed in two existing behavior surfaces:

1. The `devryan_task` tool description in `packages/web/server/default-config/plugins/devryan-managed-orchestration.mjs` will state that a decided managed start should be the first tool action and must not be preceded by a standalone todo operation solely for restatement.
2. The packaged orchestrator prompt in `packages/web/server/default-config/agents/orchestrator.md` will carry the same concise rule for clean/default installations.

The tool description is the compatibility path for user-modified orchestrator prompts because it reaches any runtime that exposes the managed tool without replacing customized agent files. The packaged prompt keeps default behavior explicit. No runtime agent overlay will replace prompt bodies, and no user-owned agent configuration will be overwritten.

The UI change will remain local to assistant-message presentation:

- `managedTaskDispatch.ts` will identify active `start` parts from their existing tool input and return bounded provisional display records alongside authoritative task IDs.
- `MessageBody.tsx` will use the first provisional or authoritative managed part as the single Agent Dispatch anchor for the assistant message.
- `ManagedTaskList.tsx` will render provisional records with the same card and agent grouping language as authoritative rows, but as display-only rows without navigation.
- English UI copy will add the `Preparing...` status. The existing i18n fallback model will continue to apply.

The resolver performs one linear pass over the already memoized visible message parts. It will not add store state, subscriptions, polling, scheduler events, or work to the streaming reducer.

## Data Flow

1. OpenCode creates a managed tool part with `state.input.action === "start"`, plus its label and agent.
2. While `state.status` is pending or running and no valid task ID can be parsed from output, the resolver emits a provisional record keyed by the tool-part ID.
3. The assistant message renders one Agent Dispatch card at that part. The row uses only sanitized label and agent strings from the tool input and announces `Preparing...`; it does not infer a task ID or child session.
4. The managed tool submits through the existing private RPC. The scheduler durably records the task and creates the child under its current contract.
5. Once completed tool output contains a valid `dvr_task_` ID, the resolver stops emitting that provisional record and emits the authoritative ID instead.
6. The existing managed orchestration store supplies task status and `childSessionId`. `ManagedTaskRow` continues to own the `Open Subtask` visibility rule.

Multiple active starts in one assistant message remain bounded by the number of visible tool parts and are grouped by their declared agent. Authoritative task rows keep their existing order and windowing behavior.

## Alternatives Considered

### Return from scheduler submission before pumping

Returning the queued task before the scheduler starts its pump could expose the task ID earlier, but it would save only part of the observed five-second scheduler interval. It would also broaden the durability contract, require recovery guarantees for an asynchronously scheduled pump, and still would not make a child-session link immediately available. This is not justified by the measured bottleneck.

### Create or expose a child session before durable task creation

This could make the button appear sooner, but it risks orphaned child sessions when persistence or scheduling fails. It conflicts with the repository rule to prefer authoritative state over optimistic guesses and is rejected.

### UI-only placeholder

A provisional card alone improves perceived responsiveness but does not remove the observed standalone todo round. It is included as one half of the design, paired with the tool/prompt instruction that targets the largest avoidable delay.

## Failure and Regression Safety

- Provisional data is presentation-only and is never inserted into the managed orchestration store.
- Only `start` actions in pending/running state qualify. Retry/resume reconciliation and existing task IDs are not reinterpreted.
- A malformed output cannot create navigation because task IDs still require the existing `dvr_task_` validation.
- A terminal tool state without an authoritative task ID removes provisional content rather than leaving stale activity.
- The UI does not derive live status from historical messages after the tool becomes terminal.
- The tool instruction does not forbid todos for genuinely multi-step work; it only removes a todo operation whose sole purpose is to restate an already-decided delegation.
- The scheduler remains the only source of task, queue, child-session, and completion state across web, Electron, and VS Code.
- No dependency or persisted-data format changes are introduced.

## Testing and Acceptance

Test-driven implementation will add focused regressions before production changes:

1. The packaged managed-tool test verifies the direct-start/no-todo-prelude instruction is exposed to customized orchestrators.
2. The packaged-agent test verifies the default orchestrator carries the matching rule.
3. Resolver tests verify an active start produces one provisional record, completed output replaces it with an authoritative task ID, terminal failure removes it, wait-only calls remain omitted, and parallel starts remain distinct.
4. Render tests verify the provisional card contains Agent Dispatch, the agent label, the humanized task label, and `Preparing...`, while omitting `Open Subtask`.
5. Existing tests continue to prove that authoritative running and terminal rows render correctly and the button remains absent until `childSessionId` exists.

After focused tests, run `bun run validate:affected` and the web server test suite because both shared UI and a packaged server plugin change. Then launch DevRyan from `/Users/zoubair/Repositories/Test`, send the same bounded Explorer dispatch prompt, and visually verify at desktop and narrow viewport widths that:

- the provisional card appears as soon as the managed start tool begins;
- it transitions without duplication or layout jump to the authoritative task row;
- `Open Subtask` appears only when navigation is valid;
- opening the child shows the expected child session and output;
- the Test project remains unchanged.

The timing trace will be repeated to confirm that the parent no longer emits a standalone todo-only model round before a directly requested single dispatch. Provider/model output latency will be reported separately rather than attributed to the UI or scheduler fix.
