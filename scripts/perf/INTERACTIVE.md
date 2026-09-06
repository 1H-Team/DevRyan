# Packaged interactive performance protocol

`electron-resource-benchmark.mjs --scenarios interactive` measures the actual
packaged renderer against the existing credential-free loopback fixture. It
requires `--package-evidence`; it does not call a provider or simulate managed
scheduler behavior. `electron-interactive-benchmark.mjs` owns the workload,
browser observation, correctness checks, aggregation, and matched comparison.

## Declared measurements

Primary metrics are declared in `INTERACTIVE_PRIMARY_METRICS` before launch and
written to `summary.json` and `interactive.json` before the measured workload.
For trusted input, click, wheel and key events, a browser observer records the
event timestamp and waits for the prescribed DOM condition plus two animation
frames. This is **render-ready latency**, not compositor presentation or exact
input-to-paint. Control discovery, scrolling a control into view and CDP command
transport precede the event timestamp and are excluded from these measurements.

Chromium Event Timing entries are retained separately, including support status,
interaction IDs, processing timestamps and the 16 ms duration threshold. An
absent entry is not a zero-latency event. A Long Tasks observer and continuous
frame intervals retain phase timestamps; Chromium tracing runs across the full
workload. All observation buffers are capped and overflow fails the run. Chromium
returns its trace as a stream after measurement; bounded 1 MiB reads feed gzip
with backpressure rather than retaining all events in Node. A trace exceeding
512 MiB uncompressed, an incomplete trace stream or Chromium-reported data loss
fails the run. The explicit 512 MiB Chromium buffer is monitored; reaching 99%
also fails. These controls use the documented
[CDP Tracing contract](https://chromedevtools.github.io/devtools-protocol/tot/Tracing/).

| Workload | Fixed protocol and correctness |
| --- | --- |
| Typing with a background stream | One other session streams at the fixture's 16 ms interval. The full fixed draft is entered at a 75 ms cadence without waiting for each preceding render. Every trusted input event receives its own timing; actual dispatch offsets/lateness are retained. The final draft must match exactly and no prompt may have been submitted. |
| History open and pagination | Two independent 180-turn histories, 256 bytes per assistant response. Actual sidebar and Load Older Messages controls must load all 360 messages through contiguous HTTP page requests. Setup reads are excluded from that proof. Each pagination step must preserve the same visible canonical anchor within 2 px and cross the actual virtualization threshold. |
| Session switching | Four cycles through both histories and the control session. The selected session must contain a visible canonical assistant message with its exact response text; the particular viewport position is not prescribed. Each accepted message ID is recorded. The exact unsent draft must be restored, giving 16 measured switches. |
| Scrolling | Twelve alternating 320 px wheel events in a fully loaded history. Each event must change the actual transcript scroll position. |
| Expansion | A real fixture turn supplies 768 bytes of numbered reasoning and two chunks 8.1 seconds apart. Its canonical reasoning must actually last at least 16 seconds and belong to the exact submitted user. Wait for the completed, inactive disclosure before timing four open/close cycles. Each of eight clicks must produce the requested expanded or collapsed layout with full visible content height. |
| Reconnect and cancel | A real UI submission produces numbered fixture chunks. Close the SSE connection, then require a prescribed later chunk. Reconnect latency uses the host clock from disconnection to render-ready acknowledgement and includes the final CDP return. Stop latency starts at the trusted click and ends after the canonical status endpoint reports idle, the stop control disappears, and two animation frames pass. Text must retain its prefix and contain exactly one ordered copy of each numbered chunk; the canonical and rendered turn must be unique. |
| Repeated navigation | Eight identical cycles of New Chat, effort-menu open, Escape close, history selection, and control-session selection: 40 measured actions. The final draft and cancelled turn must remain intact. Natural renderer heap, working set and DOM windows before and after the sequence use the same selected session, settle time and sample count. No explicit GC runs in this scenario. |

The structured `interactiveScope: 'typing'` study uses only the fixed sixty
trusted inputs at the same 75 ms cadence. After the runner completes startup,
one ordinary same-origin navigation opens `/?session=<control.id>`. Exact URL
and selected-session identity, a complete document, an enabled visible connected
composer, and an empty control transcript must be ready before probe installation
and warmup. The selected session and composer are checked again immediately
before and after typing. This setup excludes sidebar selection from the new
typing study; it does not establish the cause of the earlier sidebar failure.
The full interactive protocol keeps its original sidebar behavior.

Typing scope retains the advancing background stream, exact unsent draft, zero
submitted/active prompts, dispatch lateness, and all trace/probe cleanup checks.
It reports no navigation or retention measurements and opens no histories.
Its protocol version, source hash, scope and startup mode must match across
three fresh runs per package; earlier failed or full-protocol runs cannot be
pooled into this study. The separate session-memory scenario retains all four
180-turn histories and its existing natural/forced-GC windows. Its pagination
prerequisite now requires fresh contiguous progress from each actual Load Older
click plus the returned first message ID and canonical text visibly committed
in the selected session, using ordinary reveal scrolling before sampling.
Virtualized scroll height and HTTP completion alone are insufficient.

`interactive.json` retains every action, canonical history page/anchor proof,
input cadence, correctness result, browser observation and natural memory sample.
The completed-disclosure setup retains canonical user/assistant/part IDs, actual
duration and byte count. Numbered segments preserve the workload through the
production fetched-text normalizer. No timestamps are fabricated; the fixture
emits its two scheduled chunks before completing the turn. Setup latency is
excluded from the eight disclosure-click timings.
`trace.json.gz` retains Chromium events. Four screenshots cover typing, complete
history, reconnect/cancel and final navigation. A failure saves partial evidence
and the runner's failure screenshot before the owned app and fixture stop.
Every run also saves `run-evidence.json`: bounded sanitized browser exceptions,
console and Chromium error entries collected from CDP attachment, final runtime
diagnostics, fixture unknown routes, preserved journal gap/error verification,
and owned app/fixture cleanup results. Review these alongside the screenshots.
Expected fixture HTTP errors remain visible for interpretation. Missing data,
truncation, journal scan limits and incomplete cleanup are reported explicitly;
an incomplete owned-process cleanup fails the invocation. Journal scanning and
status capture occur after the workload and are excluded from timing.
The shared QA process owner observes ancestry and OS start identities every
500 ms for every scenario and both packages. It retains detached descendants,
drains the host, closes the fixture, and performs a second OS audit. Observation
gaps and surviving descendants fail cleanup. The existing bounded Electron log
and startup/timing boundaries remain unchanged.

## Smoke and matched runs

One short smoke checks only the protocol:

```sh
node scripts/perf/electron-resource-benchmark.mjs \
  --scenarios interactive --runs 1 --warmup-ms 500 --measure-ms 1000 \
  --label interactive-smoke \
  --package-evidence .cache/qa/packaged-electron-EXAMPLE/package-evidence.json
```

For a comparison, use at least three fresh processes for each verified package
with the default 5-second settle and 30-second memory windows. Stop other builds,
tests, live provider journeys and active app workloads before measurement. Run
both packages on the same host and physical display/window conditions; inspect
the four screenshots from every run. Use the first package's saved summary with
`--baseline` when running the second package.

Comparison requires identical fixture/protocol hashes, workload parameters, run
counts, sampling parameters, Chromium runtime, visible display/window conditions,
and recorded backend, shell/bootstrap and native-file fingerprints. The primary
served UI identities remain separate. Every run must pass startup and all
interactive correctness checks; a one-run smoke is rejected as a comparison.
Even matching three-run sets are rejected when the warmup is below 5 seconds
or the measurement window is below 30 seconds.
The protocol and package hashes, including the initially pinned package-evidence
file bytes, are verified again after success or failure. A replacement package
with newly consistent metadata cannot satisfy the original pin.

Reports retain per-run p50/p95 values, sample counts, median/minimum/maximum run
values, absolute differences and percentages. Overlapping run ranges are labelled
as having no clear change. These descriptive measurements do not reuse the six
CPU/working-set gates of the original resource scenarios. Natural heap growth by
itself is not a leak diagnosis.

The QA acceptance runner currently freezes **all** files under `scripts/`.
Complete interactive and shared fixture changes before starting paid diagnostic
cells, then freeze the entire script tree. Performance measurements have their
own final protocol freeze after all live diagnostic workloads stop. No drift is
silently waived; rebuilding package provenance after a later production change
is a separate required step.
