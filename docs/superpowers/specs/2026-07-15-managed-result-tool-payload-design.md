# Managed result tool-payload compaction design

## Problem

`devryan_task wait` currently serializes a terminal task projection beside its
result envelope. Both objects carry `recoverablePreview`, `failureReason`, and
`canonicalRefs`. A deterministic 60,014-byte preview produced a 121,212-byte RPC
result with two identical copies before pretty-printed tool serialization. The
duplicate is then persisted as parent tool output and consumes avoidable model
context.

## Decision

Compact only the model-facing `devryan_task` output. When a task and result
envelope have the same task identity and an identical terminal payload, remove
the duplicate preview, failure, and canonical references from the serialized
task projection. Preserve task identity, configuration, status, timing, and
retry availability, and keep the complete result envelope authoritative.

Apply the same compaction to nested projected task results such as cascade
cancellation. If task and envelope content disagree, preserve both copies so a
contract violation remains visible instead of hiding data.

## Safety boundary

The scheduler record, durable ledger, private RPC response, UI snapshot/events,
and acknowledgement contract remain unchanged. The bundled plugin is shared by
managed web and Electron OpenCode runtimes, so one serialization rule
preserves runtime parity and does not alter provider prompts, models, tools, or
execution.

## Verification

- A tool-level regression test must fail against the duplicate output and prove
  the terminal preview appears exactly once after the change.
- The existing managed-plugin and orchestration suites must stay green.
- Re-run the 60,014-byte deterministic measurement and compare serialized tool
  bytes and occurrence count.
- Exercise a real managed wait/continue journey through DevRyan and inspect the
  rendered Agent Dispatch result and raw tool output.

## Rejected alternatives

- Removing `resultEnvelope`: it owns acknowledgement, resumability, lineage,
  and canonical result semantics.
- Changing durable task/event projections: this would widen a model-context
  optimization into persistence and UI contracts without evidence of benefit.
- Converting the result to prose: compact JSON retains deterministic machine
  structure for follow-up actions.
