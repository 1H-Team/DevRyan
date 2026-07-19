# Managed pending-start idle recovery

## Problem

The managed-orchestration plugin registers a pending start in `tool.execute.before` so direct work emitted in the same assistant response cannot race ahead of the managed `start` submission. The normal tool implementation claims that registration and settles it in `finally`.

OpenCode invokes plugin pre-execution hooks sequentially before it calls the tool implementation. If DevRyan's hook registers the start and a later plugin hook throws, DevRyan's tool implementation never runs. The registration therefore remains pending forever, and every later direct tool for that session waits forever in `drainPendingStarts`.

## Lifecycle source of truth

OpenCode emits `session.idle` only after its session runner has no remaining work. At that boundary, no managed start from the interrupted turn can still legitimately be waiting between its pre-execution hook and its tool implementation.

## Design

- Keep the existing registration, claim, and `finally` settlement as the normal path.
- Add a synchronous plugin `event` hook.
- On `session.idle`, settle every remaining pending-start registration for that session.
- Ignore unrelated events and sessions with no local state.
- Do not use an elapsed-time fallback. A timeout cannot distinguish an abandoned registration from a valid slow start and could weaken the same-response barrier.

## Safety properties

- A genuine start still blocks same-response direct work until submission finishes.
- A failed or aborted start that reaches the tool implementation still settles through `finally`.
- A start abandoned after DevRyan's pre-hook but before tool execution is released only when OpenCode declares the session idle.
- Other sessions remain isolated.

## Verification

- Reproduce a registered start whose tool implementation never runs.
- Prove direct work remains blocked before the idle event.
- Deliver `session.idle` and prove the direct tool continues to the bridge check.
- Keep the existing delayed-submit test green to prove the normal race barrier is unchanged.
