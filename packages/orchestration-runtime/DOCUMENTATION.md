# Managed Orchestration Runtime

## Purpose

This package is the single policy owner for DevRyan-managed sub-agent work. It is deliberately separate from OpenCode/provider-native task events, which remain observational and are never admitted, counted, or cancelled by this runtime.

## Contract boundary

Managed tasks use `owner: "devryan"` and `dvr_task_` identities. A record carries stable root/parent/child identity, directory, deterministic sequence, builder/orchestrator ownership mode, a queue-time provider/model/agent/variant snapshot, attempt lineage, lifecycle timestamps, and explicit partial/failure metadata.

Queued work must survive application restart, so the private durable record includes its text prompt. Labels are limited to 512 UTF-8 bytes and prompts to 256 KiB. Broadcast task events omit prompt, idempotency key, and lease token; compaction emits an identity-only `openchamber:managed-task-removed` event. Recoverable previews are limited separately to 64 KiB; complete output stays in the canonical OpenCode child session.

## Scheduler policy

`createManagedTaskScheduler()` serializes every ledger mutation and enforces a hard maximum of three `starting` or `running` tasks. Queue sequence is monotonic across the runtime, which also preserves order within each root graph and prevents a newer root from jumping ahead of older queued work. Idempotency is scoped by root session and key.

The scheduler owns explicit transitions, per-root builder/orchestrator mode exclusion, child-session and provider-acceptance checkpoints, isolated task/descendant cancellation, bounded provider-abort waits, execution deadlines, and the 60-second starting-lease reconciliation check. Provider-native workers have no admission path into this package.

Durable mutations and event publication use separate serialized lanes. A slow or reentrant event sink therefore cannot hold the ledger mutation lock, while event invocation order still follows committed task order. Shutdown attempts executor cleanup even when the final durable save fails, and shutdown before initialization never overwrites an existing owner ledger.

Terminal tasks are immutable. Each gets one result envelope retaining status, partial flag, failure reason, bounded preview, canonical child message/tool references, and attempt lineage. Successful completion requires a useful final assistant response after the child leaves live `busy`/`retry` state and every observed tool part is final. The first observed provider `retry` settles the managed attempt as a resumable failure and starts bounded abort cleanup without submitting another prompt. An assistant `finish: "tool-calls"` record is an intermediate handoff even when it has a completed timestamp, and stable idle state alone never promotes tool activity to success. A bare completed assistant-message shell is recorded as a resumable failure with `partial=false` only after the child is no longer live and has no in-flight tools. Continue/abandon acknowledge without work; retry creates a new child; resume only observes the existing child; `retry_in_place` waits for retry cleanup and sends a fixed continuation into the same child with a new provider/model/variant snapshot.

`formatManagedTaskDisplayName(label)` is the shared presentation boundary for durable task labels. The raw label remains immutable in the ledger and safe event projection, while both canonical child-session creation and Agent Dispatch rows use the same trimmed, separator-humanized display name.

On restart, queued tasks retain order. Starting/running children are reconciled: live children resume observation, terminal children settle without another prompt, and unavailable children become interrupted while preserving recoverable output. Shutdown clears owned timers/waiters while leaving nonterminal records durable for the next owner.

## Persistence bounds

Owner adapters provide atomic `load()` and `save()` operations. Before every save, the core removes the oldest unreferenced terminal history to enforce 2,000 terminal records, 90 days, and 20 MiB of UTF-8 serialized state. Each successfully persisted removal is published before the task event whose commit caused it, and a task removed by its own terminal commit is not republished. This lets long-lived renderers release the same projection without polling or retaining tombstones. Nonterminal work and retained attempt lineage are never compacted; new work is rejected honestly when protected state alone cannot fit the byte boundary.

## Public entrypoints

- `createManagedTaskRecord(input)`: creates and validates a queued task record.
- `formatManagedTaskDisplayName(label)`: derives the shared child-session and Agent Dispatch display name without mutating the durable label.
- `validateManagedTaskRecord(task)`: rejects malformed, provider-owned, non-JSON, or over-limit records.
- `isTerminalManagedTaskStatus(status)`: classifies immutable terminal states.
- `toManagedTaskEvent(task)`: creates the safe `openchamber:managed-task` projection.
- `toManagedTaskRemovalEvent(task)`: creates the safe identity-only `openchamber:managed-task-removed` projection.
- `createManagedTaskScheduler(options)`: creates the runtime scheduler owner.
- `createManagedOpenCodeExecutor(options)`: executes and reconciles canonical child sessions through an injected web/VS Code transport without owning HTTP or provider state.
- `resolveProviderPromptTools(providerId)`: returns the shared, minimal provider prompt-tool override; Copilot disables both OpenCode names for the optional Resend MCP namespace.
- `createManagedTaskResultEnvelope(task, options)`: creates a terminal parent handoff.
- `compactManagedOrchestrationState(state, options)`: applies durable count/age/byte policy.
- `assertManagedTaskTransition(previous, next)`: validates lifecycle and immutable identity.

## Testing

Run `bun test packages/orchestration-runtime`. The current suite covers contract validation, transition immutability, capacity/fairness, idempotency races, mode leases, dispatch checkpoints, canonical OpenCode execution (including empty completed assistant shells), provider prompt-tool isolation, cancellation isolation/cascade, partial envelopes, retry/resume, active/queued timeouts, bounded aborts, 60-second lease recovery, restart reconciliation, durable-write failure, corrupt result/task mismatches, reentrant publication, compaction, and shutdown cleanup. The root full test gate and changed-file validation planner include this package and its web/UI/VS Code dependents.
