# Cursor SDK runtime

`index.js` is the shared Cursor SDK 1.0.28 conversation adapter. Web and Electron
use the same transcript mapping. `node-worker.mjs` runs one isolated request;
`persistent-worker.mjs` routes requests by request ID and caches SDK agents.
The public runtime declarations live in `index.d.ts`. New plan prompts publish
`metadata.devryanPlanMode`; transcript readers also accept the legacy
`openchamberPlanMode` flag.

Explicit native connection verification uses the existing twenty-second owned
catalog deadline, including metadata-worker cancellation and physical
settlement. It does not inherit the public quick-discovery cap (1.5 seconds by
default); legacy verification and quick public reads retain that cap. Successful
account-scoped SDK catalogs still reuse the existing five-minute cache only
after resolving the current selected credential. This correction adds no
warming, credential mutation or inference request. The QA1 incident
recorded a successful 3.781-second discovery and a 1.516-second Verify timeout;
no physical termination receipt was retained.

## Conversation ownership and completion

`run.stream()` exclusively owns main assistant text, reasoning, tools and task
summaries. `onDelta` supplies only callback-only nested task activity, private
session-change observations and usage metrics. Main callback text and tools
never enter the transcript or advance the last SDK assistant text-part pointer.

Text and reasoning concatenate SDK fragments exactly, including repeated
punctuation, Unicode and whitespace. Running/partial tool updates leave the
current text step open; terminal tools close it. An empty thinking delta creates
a reasoning boundary even without visible text. Thinking-completed alone does
not create a boundary after text. An empty SDK thinking event with
`thinking_duration_ms` closes the current reasoning part. Tool-derived plan
text and nested previews do not change ownership of main assistant text.

Natural completion drains the SDK iterator and the worker FIFO before applying
`wait().result`. A terminal status or an early final result cannot close either
stream. The one-shot adapter consumes stdout through EOF, process settlement and
owned publication; persistent request completion follows the worker's fully
drained request `done` event. Worker writes await stdout completion so a slow
pipe cannot truncate a natural answer.

The optional constructor callbacks `onPresentationProgress` and
`onPresentationOwnerRetired` report presentation only. Finalizing begins after
successful stream drain and final-result reconciliation while the same run owns
mandatory publication/persistence. Updates use a runtime owner, monotonic
sequence, run generation and exact user/assistant IDs; native step/attempt IDs
remain null. Progress advances only after terminal canonical persistence returns.
Stop, replacement, deletion, failure, settlement and retirement clear that
run's projection. Callback failures cannot veto persistence or change execution,
retry, cancellation or completion authority.

The pinned SDK accumulator constructs the final result from its last
`assistantMessage`, skipping trailing tools and reasoning. `final-result.js`
reads the completed local run's conversation without another inference request
and retains only a bounded ordinal witness. This private read supplies identity,
while the ordered stream remains the sole main-content producer. A present
string replaces its exact streamed text part, preserving the part ID and all
earlier parts. An empty new assistant step after a tool appends an empty part
instead of erasing the earlier answer; a trailing tool alone retains the earlier
assistant identity. An absent result preserves streamed text. Missing,
inconsistent or oversized witnesses preserve partial content and fail with
`CURSOR_STREAM_FINAL_ASSOCIATION_INVALID`. Repair requires current run ownership
and is fenced by accepted cancellation. Diagnostics contain only IDs, ordinals,
lengths, equality and bounded state/code fields, never conversation text or hashes.

Consumption fixtures use that same SDK-shaped private conversation witness when
`wait()` returns final text. Direct, persistent and fallback usage checks retain
all six cumulative token fields, final-only text, successful finish, failure and
cancellation behavior; stream totals never fabricate current context occupancy.

Incomplete drains and FIFO overflow preserve partial content and finish with
`error`, using the existing native-compatible assistant `info.error` boundary:
`CursorStreamPartialError` with a bounded `CURSOR_STREAM_*` code in its message.
The FIFO permits at most 4,096 queued events and 8 MiB; `worker-writer.js` also
bounds pending stdout writes by count and bytes. Both workers route SDK console
logging to stderr and keep stdout strictly framed. Unawaited SDK callback writes
remain observed and are drained before terminal output. Queue failure reserves
only an 8 KiB negative report, never a successful terminal. Provider error text
is clipped to 1,024 characters plus an ellipsis in that reserved report, so a
long request failure cannot terminate unrelated persistent requests. `sdk-error.js`
preserves SDK authentication/quota error names and codes across worker transport;
those failures, including direct-send rejections and resolved SDK error statuses,
remain provider errors rather than stream-drain errors. Final-association failures
retain their finite inner reason through worker transport and the journal's
dedicated payload allowlist; raw conversation text is excluded from that event.
After terminal observation or idle-eligible content, a stream idle deadline is
a failure, never proof of success. Active tools retain their normal waiting
behavior until a terminal observation. Cancellation retains `cancelled` finish and the existing owned receipt,
final persistence and cleanup barriers.

Timing records forward create/send stages with model/provider identifiers and
cache-hit metadata only; they contain no prompt, response or credential content.

## Verification

`bun test packages/cursor-sdk-runtime` exercises deterministic SDK fixtures and
worker processes without live providers or installed-app state.
`stream-contract.test.js` runs the real direct, persistent and one-shot adapters
through repetition, whitespace, Unicode pipe chunks, delayed mirrored callbacks,
reasoning closure, final-result replacement, cancellation and partial failures.
`direct-adapter.test.js` is the direct (non-worker) adapter suite: SDK event sequences through `createCursorSdkRuntime` covering plan cards, apply_patch synthesis, Council refusal, subagent tasks, thinking order, partial drains, aborts and stale agents.
`fixtures/pinned-accumulator.js` executes the shipped SDK 1.0.28 accumulator source
offline for both final-result and adapter fixtures. Conversation witnesses come
from independent interaction traces, including running-tool and empty-reasoning
boundaries, rather than from the expected final result. The adapter suite checks
these boundaries after persisted reload and actual journal write/read/export.
`worker-writer.test.js` qualifies delayed and
failed callbacks plus both bounds. These deterministic checks do not qualify a
fresh packaged/native build or live provider request.
