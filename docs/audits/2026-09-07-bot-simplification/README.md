# Bot conversation and controls audit — 2026-09-07

## Scope

Request-specific Soul acknowledgments remain visible before tool work and after
reload; ordinary replies remain direct. Shared files is the first/default sidebar
tab, with Confirmations second. Authorized computer activity appears above the
composer; Show and file actions open the single viewer. Telegram and voice
settings retain their controls with shorter copy. Human catalogs hide Bots
created by reserved `agent_test` accounts.

The changes preserve configured models, the two warm-lease limit, ten-minute
expiry, startup concurrency, and persistent computer reuse. No dependency or
schema change was introduced. Concurrent avatar and session-changes work in this
checkout belongs to other tasks and is outside this audit's change scope.

## Measured preparation overhead

`benchmark.mjs` uses the real provider and warm-lease coordinator with controlled,
local dependencies: 20 ms environment preparation, 20 ms materialization (35 ms
for attachments), and 40 ms unfinished warmup. Each distribution has 25 samples.
`before.json` was captured before implementation; `after.json` after the change.
These are synthetic application measurements, not live model or Docker latency.

| Metric | Before p50 / p95 (ms) | After p50 / p95 (ms) |
| --- | ---: | ---: |
| Text preparation | 45.78 / 61.54 | 24.47 / 26.29 |
| Image preparation | 44.39 / 51.79 | 25.02 / 43.72 |
| Attachment preparation | 57.36 / 61.76 | 39.14 / 48.15 |
| Reserving unfinished warmup | 41.11 / 42.01 | 0.06 / 1.00 |

The independent preparations now overlap. Durable admission for eligible warm sends no longer
waits for warm preparation; the dispatcher waits after admission. Cleanup tests
cover both late successful preparation and failed/invalidated claims. Timing
variation includes local scheduler contention; the improvement mechanism is
also established through dependency-order assertions.

## Live evidence limits

The authorized repository-local verification configuration confirmed that
`Verify Bot 2026-09-02` and `Bot E2E 2026-08-24 0220` both have `agent_test`
creators. Only names and classification are retained in
`live-fixture-classification.json`; no profiles, credentials or Bot data changed.

The isolated verification journal was inspected with `journal list` and
`journal gaps --verify`. It contains 89 unattributed records last dated August
29 and no session records or gaps. This is insufficient evidence for the
reported Bot work. It does not establish acceptance-to-paint, provider response,
Docker readiness, first/repeated computer-command, or end-to-end completion
latency. Those live cold/warm distributions remain unavailable and are not
claimed as passes. The implementation records acknowledgment publication and
paint milestones for subsequent authorized live measurement.

## Verification

| Check | Observed result |
| --- | --- |
| Packaged Electron visual matrix | **Pass: 83/83**, all screenshots reviewed |
| Workspace lint and type checks | **Pass**, including the final helper change |
| Production web and Electron main build | **Pass** |
| Startup bundle budget | **Pass:** 4,691,107 raw / 1,379,639 gzip bytes; limits 4,962,877 / 1,456,388 |
| Native CoreGraphics pointer check | **Pass**, current source Electron, isolated profile and password-free Test Administrator |
| Aggregate deterministic gate | **Not green:** final egress suite has 31 passes / 1 failure; failing case passes alone |
| Live cold/warm provider and Docker latency | **Unavailable**, insufficient attributable journal evidence |
| Current signed-release native acceptance | **Not performed**; the native pass uses the development Electron binary |

The [reviewed inventory](visual/README.md) links every final screenshot;
[structured evidence](visual/evidence.json) retains assertions, focus/stream
metrics and image hashes. The two expanded-computer cases were recaptured with
an explicit modal assertion and inspected again. All pilot failure images were
also inspected before correction. This is deterministic fixture evidence, not a
signed release or live-provider check.

Visual review corrected narrow-rail overflow, excessive expanded-viewer height,
and low-contrast screen/control overlay buttons. Checks exercise Show/Hide,
one-stream lifetime (including simulated document visibility), shared-file
opening, Expand/Escape, Take/Return Control, tab navigation, keyboard focus,
unchanged composer drafts and Voice Save/Check. Empty read-only catalogs have no
interactive controls, so their focus check is explicitly not applicable.
Existing confirmation scenes preserve intentional deep links. Scrollable panels
and shortened secondary labels in narrow layouts remain intentional.

The [native screenshot](native/catalog-native-pointer.png) and
[native evidence](native/evidence.json) show a real CoreGraphics click opening
the Create Bot dialog; no Bot was created. The helper now activates the owned
app through AppKit before waiting for visible-document readiness. Its three
helper tests passed, Swift compiled successfully, and the native check passed
after the first compiler-cache preparation exceeded the 30-second command
limit. Fixture Bots remain visible to the reserved test administrator as
intended. The user's running app and data were not stopped or changed.

### Deterministic gate detail

`validate:full` was run; there was no single uninterrupted green run. The
complete UI suite passed after stale acknowledgment/label assertions were
corrected. Package suites passed for Bots runtime, supervisor, engine proxy,
computer, indexer, shared runtime, harness, orchestration, Cursor SDK, Electron
and retained Tauri compatibility. Targeted tests cover acknowledgment ordering
and delayed events, warm admission and cleanup, authorization, fixture
classification, stale selection and snapshot/live event ordering.

The full backend retry completed with 3,753 passes and eight failures in three
Git-related files: five 5-second rebase timeouts and three existing `/tmp` versus
`/private/tmp` path-recognition assertions. All three files passed on retry with
the normal macOS temporary directory: **74/74**. The two scripts-suite deadline
and retry-count failures also passed in isolation: **36/36**. An earlier backend
run that put temporary Git fixtures inside this checkout inherited its parent
Git context and is not used as passing evidence.

The final `validate:quick` run passed lint, types and the scripts suite, then
failed the unchanged egress relay test **`bounds a relayed response`** with
`ECONNRESET`. A full egress retry repeated it (**31 pass / 1 fail**); this
supersedes an earlier passing egress run. The case passes alone (**1 pass / 8
filtered**), suggesting test-order or connection-lifetime sensitivity. The full
suite failure remains unresolved. No egress source/test or assertion was
changed to make it pass.

Vite emitted its ordinary large-lazy-chunk warning; the enforced startup budget
passed. Raw command-log locations and hashes are retained in
[verification.json](verification.json). `bun run docs:validate` and `git diff --check` passed. Documentation validation
reported existing historical/generated-target warnings outside this audit.
