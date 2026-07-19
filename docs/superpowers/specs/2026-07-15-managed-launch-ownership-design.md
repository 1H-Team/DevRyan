# Managed launch ownership design

## Problem

A managed task can remain inside a slow `createSession` or `promptSession` call after its
starting lease is reconciled as unavailable, or after cancellation settles the task. The
scheduler currently ignores late checkpoint writes, but the executor cannot distinguish
that ignored write from a successful ownership checkpoint. It can therefore prompt or
continue observing a child after the durable task is terminal.

## Decision

`ManagedTaskControl.setChildSessionId()` and `markAccepted()` return a boolean ownership
result. They return `true` only while the same task lease still owns a nonterminal task
(including idempotent already-recorded checkpoints), and `false` after shutdown, terminal
settlement, or lease replacement.

The shared OpenCode executor treats `false` as a hard stale-launch boundary:

- after child creation, it does not prompt;
- after a late prompt acknowledgement, it does not observe;
- it aborts the child in either case;
- for a newly created child, it also deletes the session so an unowned child is not left
  in history;
- retry-in-place only aborts because its child is pre-existing canonical history.

Web/Electron and VS Code transports implement the same child deletion contract. Cleanup
attempts abort and delete independently so one failure does not prevent the other.

## Verification

A scheduler/executor integration regression defers child creation past starting-lease
recovery and asserts the late child is aborted and deleted without a prompt. Executor
tests cover both stale checkpoint boundaries and cleanup partial failure. Package,
affected-runtime, and build validation follow because the public workspace type contract
and both runtime transports change.
