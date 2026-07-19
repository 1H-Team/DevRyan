# Provisional Assistant Parent Hydration Design

## Problem

When message.part.updated arrives before its owning message.updated, the event
reducer can create a provisional assistant message so live output has an entity
to attach to. That provisional record intentionally contains only the
message/session identity, assistant role, and creation time; it has no
parentID.

The later owning message.updated currently takes a fast no-op path when role,
finish, completion time, and diff summary match. Because parentID is not part
of that comparison, a non-terminal owning update can be discarded and the
provisional message remains orphaned. The turn projector excludes orphan
assistant messages, so out-of-order live output can remain invisible until a
later terminal update happens to change another compared field.

## Source of truth

The owning message.updated record is authoritative for assistant-to-user turn
identity. A provisional record is only a temporary shell and must yield when
that authoritative parent identity arrives.

## Design

Include parentID in the existing lightweight message no-op comparison. A
matching owning update still preserves the current message reference when every
render-relevant field already matches, while a newly supplied or changed parent
forces the existing replacement path.

No part coalescing, materialization scheduling, terminal-status settlement, or
turn-projection policy changes.

## Alternatives rejected

- Rely on the asynchronous HTTP materializer: the snapshot can be delayed or
  still incomplete, while the owning SSE event already carries the stronger
  identity.
- Compare complete messages with JSON.stringify: message.updated is a hot sync
  boundary and full structural serialization is unnecessary for this focused
  invariant.
- Add a provisional sentinel field: parent identity is already the direct,
  deterministic distinction needed by the no-op gate.

## Verification

- Replay an orphan message.part.updated followed by a non-terminal owning
  message.updated whose only semantic addition is parentID.
- Confirm the second event is treated as a change and replaces the provisional
  message with the parented record.
- Keep genuinely unchanged message updates on the existing no-op path.
- Run focused reducer tests, affected validation, a disposable browser proof,
  and isolation/diff checks.
