# Child Poll Non-Regression Design

## Problem

`ToolPart` polls a linked child session so the parent task row can show child
activity even when live events were missed. Both the regular poll and the final
settlement fetch currently replace the child's entire cached message list and
every returned part directly.

A poll can start before a live terminal event and resolve after that event has
already updated the directory store. Applying the older response then replaces
a completed assistant message with an incomplete snapshot and a finalized tool
part with an in-flight snapshot. Because the smaller idle poll also returns only
a bounded tail, direct replacement can remove older cached child messages.

## Source of truth

Same-ID assistant and tool lifecycles are monotonic. Once an assistant message
is terminal, an older incomplete snapshot cannot reopen it. Once a tool part is
finalized, an older in-flight snapshot cannot restart it. A bounded polling
response supplements the existing child cache; it is not a declaration that
omitted historical messages no longer exist.

## Design

Route both task-child fetch paths through `materializeSessionSnapshots`, the
shared message/part materializer already used by normal session loading and
recovery. This preserves omitted cached messages, streaming text, part order,
revert filtering, and unchanged references.

Strengthen the shared materializer at the same-ID merge boundary:

- preserve an existing terminal assistant message when the incoming snapshot
  for that message is still incomplete;
- preserve an existing finalized tool part when the incoming snapshot for that
  part is in flight;
- continue accepting forward progress, including incomplete-to-terminal and
  in-flight-to-finalized snapshots;
- continue accepting terminal snapshots over live state and richer terminal
  snapshots over older terminal state.

The guard lives on cold HTTP materialization paths. It adds no work to the SSE
event reducer or streaming delta path.

## Alternatives rejected

- Replacing the poll response only when the child is currently active: the
  response can become stale during the request, after that decision was made.
- Adding a global per-session SSE revision counter: correct but unnecessary hot
  path state and cleanup for same-ID monotonic lifecycles.
- Fixing only `ToolPart`: other delayed materialization callers can encounter
  the same terminal-to-in-flight regression, so the invariant belongs in the
  shared materializer.

## Verification

- Materializing an incomplete assistant/running tool snapshot over completed
  live state must preserve the completed records and their references.
- A terminal snapshot must still advance incomplete/running live state.
- A bounded child poll must preserve older cached messages omitted by the
  response.
- The focused tests, affected validation, diff checks, and a real child-task UI
  exercise must remain green.
