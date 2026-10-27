# Selected transcript retention probe

Run in its own process, without a browser, app data or provider requests:

```sh
bun run --cwd packages/ui src/sync/session-history.memory-probe.ts
```

The fixture feeds bounded mock HTTP pages through the production
`SessionHistory.ensureFirstPage` and `SessionMessageLoader.refreshTail`, then
measures `ChildStoreManager.historyBudget` and the production ten-turn window.
All owners are disposed, the SDK accessor and feature flag are restored, and
the process exits because imported UI singletons also own background timers.
The fixture creates no files and uses only synthetic data.

## Measured on 2026-10-21

Each turn contains one user, twenty assistant steps with five completed read
tools each, and one final assistant. The tail refresh reads thirty records.

| Tool output per call | Turns | Retained records | Tool parts | Records in ten-turn window | Retained JSON bytes | Estimated retained JS bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Empty | 10 | 220 | 1,000 | 220 | 395,284 | 1,321,964 |
| Empty | 100 | 2,200 | 10,000 | 220 | 4,020,304 | 13,308,044 |
| 8 KiB | 10 | 220 | 1,000 | 220 | 8,587,284 | 17,705,964 |
| 8 KiB | 100 | 2,200 | 10,000 | 220 | 85,940,304 | 177,148,044 |

The selected 100-turn fixture remains 42,930,316 estimated bytes above the
128 MiB soft budget after accounting. This follows the existing selected-session
protection; the budget can evict inactive histories but cannot bound the active
one. A separate single-step turn with 100 parallel calls retains only three
message records while retaining 100 tool parts (850,136 JSON bytes with 8 KiB
outputs). Message-count limits alone do not bound tool content within a turn.

The byte estimator counts UTF-16 strings and structural overhead. These are
synthetic retained-data measurements, **not** browser heap, RSS, rendering,
scroll stability or provider context measurements. Hydration timings are
reported by the command, but process warmup, garbage collection and machine
load make a single run unsuitable for a latency or speedup claim.

## Existing safeguards and the safe trimming boundary

The ten-turn window and MessageList's virtualization above eighty history rows
bound much of the mounted history. They do not remove message/part records
from the directory store. The streaming tail is outside history virtualization.
`SessionHistory` deliberately trims only background sessions. Its background
trim invalidates coverage; reusing that operation on a selected session would
also change loading and scroll behavior.

No active trimming change is enabled by this probe. The loader retains the
opaque cursor below its oldest loaded page. It cannot derive a new cursor
below an arbitrary retained prompt, and a tail refresh currently preserves the
old coverage while merging records. Reusing the old cursor after deleting a
prefix could skip the deleted interval. No cursor should be synthesized.

A safe implementation needs a server-issued page boundary and shared retention
leases for every mounted view of the session, including readers away from the
end. It must refuse trimming while loading, restoring Plan selection, retaining
optimistic messages, reconciling a stream gap, or handling a pending revert.
Keep prompt context carriers together; verify older-page reload, multi-view
scroll anchors, current Plan selection, revert and optimistic acknowledgement
before enabling it. These view/coverage contracts cross the history-owner
scope, so applying an automatic cut here would be premature.

## Lazy completed-tool output

In the output-heavy 100-turn fixture, the final thirty-record HTTP page is
1,160,624 JSON bytes; replacing completed tool output with empty strings for a
measurement-only comparison reduces it to 54,704 bytes. That is a synthetic
potential of about 95%; it is not a claim about real sessions, compressed
traffic, or a proposed empty-output implementation. The empty-output fixture
still grows, so body deferral alone cannot bound active history.

The current native adapter projects whole results. Single-message reads must
establish canonical ownership through bounded native sequence traversal
(`v2/DOCUMENTATION.md` documents fifty pages of two hundred rows). A new lazy
contract would need capability negotiation, an explicit shell marker distinct
from a truly empty result, single-flight materialization, retry/failure UI,
whole-result precedence over stale shells, live-event retention policy, and
unchanged ownership/revert/context accounting. It must not expose an unowned
native result endpoint to avoid that traversal.

Profile representative recorded sessions and expansion frequency before
introducing that contract. The measured output contribution warrants that
evaluation, while the current evidence does not justify implementing a broad
server/client protocol during this fix.
