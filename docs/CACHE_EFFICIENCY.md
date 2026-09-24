# Cache efficiency accounting and bounded QA

This change ships accounting, not a cache-policy default. The UI's active-context
calculation, selected models, main-task effort, native history, permission checks,
Anthropic cache boundaries and retention remain unchanged. No new dependency or
database is required.

## Review groups and ownership

1. `packages/shared-runtime/lib/usage-observation.js` owns the optional versioned
   `UsageObservationV1` contract, closed metadata projection, token normalization
   and explicitly priced API-equivalent estimates. Harness journal sanitization
   attaches runtime observations to completed assistant messages and step-finish
   events. `packages/harness-runtime/lib/usage.js` reconciles retained evidence;
   existing diagnostic exports include `DevRyan-usage.json`.
2. `scripts/qa/cache-wire-evidence.mjs`, `cache-wire-observer.mjs`,
   `cache-wire-plugin.mjs` and `cache-serializer-probe.mjs` own disposable final-wire
   observation and actual-adapter fixtures. They are not imported by shipped
   configuration. The default-only plugin entrypoint avoids OpenCode invoking
   exported test helpers as plugin factories.
3. `packages/shared-runtime/lib/cache-efficiency-policy.js` owns route qualification.
   The repository-only `cache-title-plugin.mjs`, `cache-efficiency-experiments.mjs`
   and `cache-pair-runner.mjs` implement gated experiments. All flags default off.

## Accounting semantics

Observations distinguish `provider_request`, `runtime_step` and
`message_aggregate`. Requested model and response-reported model are separate;
OpenCode's message `modelID` only populates the former. Auth, transport, runtime
version, identity, usage, write lifetime, timing and price provenance remain null
or `unknown` when absent. Sources must not fill missing fields with zero.

Normalized input includes ordinary input, cache reads and cache writes. OpenAI
raw input is inclusive; Anthropic and OpenCode ordinary input is exclusive of
cache usage. OpenAI/Anthropic and xAI Responses raw output includes reasoning;
OpenCode and xAI Chat Completions expose separate output and reasoning counts. If reasoning is missing from an
inclusive total, visible output remains unknown. Write totals can be known while
their five-minute, one-hour or thirty-minute allocation is unknown.

Within each root, `runtime` totals prefer step-finish records over the matching
message fallback. `provider` totals are separate: **never add these two layers**.
Runtime steps and provider attempts are not assumed to have a one-to-one mapping.
Duplicate snapshots replace prior observations; partial snapshots cannot erase
known usage. Cumulative native counters require a scope and ordered sequence;
their first snapshot is not spending unless a zero baseline is explicitly known.
Counter resets and absent baselines produce gaps. Cumulative deltas are not
individual-request evidence. A missing intermediate cost or token reading never
restarts a from-zero baseline. The affected interval stays unknown and increments
`cumulativeGaps`; known totals are partial lower bounds in that case.
Native copies with the same response ID across resumed/forked sessions are
deduplicated across those sessions. Roots resolve after all retained relations
are read: a shared root survives, while session/purpose remain ambiguous. Copies
with conflicting or unavailable roots use the unknown root. Attribution conflicts
remain visible even when the root is known.

`nativeClaudeUsageObservation` projects response identity and native write-lifetime
evidence without attaching the CLI's cumulative cost summary to each response.
`nativeCodexUsageObservation` distinguishes `last` from `total` counters, requires
output semantics explicitly, and keeps ambiguous defaulted cache-write zeros
unknown unless the caller supplies capability evidence.

Each root also reports prefix `continuity` for runtime and provider rows. It is
derived from numeric usage only, so nothing is hashed on the request path.
Rows form a stream by session, provider, route and requested model.
- **Expected reuse.** After a request, the reusable prefix is its cache reads
  plus writes when the stream reports explicit writes, otherwise its total
  input (implicit caching).
- **Break.** The next request's cache read falls short of that by more than
  1,024 tokens and 5%.
- **Warm-gap breaks.** Breaks whose completion gap is at most five minutes are
  reported separately, with their lost prefix tokens. Longer gaps can be
  provider eviction.
- **Compaction.** A compaction between two requests resets the comparison.

A break shows lost reuse, not its cause. Correlate with wire evidence before
attributing it to a client change.

The token ratio is summed cache reads divided by summed total input over rows
where both are known. Request hit rate uses only individual observed provider
requests with known cache usage. Coverage accompanies both metrics. Known totals
remain partial if observations are missing. A request hit means **any cache read
above zero**, not full-prefix coverage. Reports contain purpose, first/warm/
unknown, route and requested/response-model cohorts, helper input share, model
mismatches, provenance-separated cost, and timing. First use never means a
provider cache flush. Matching client hashes do not explain provider-internal
misses. The root's observed task span uses retained root-turn lifecycle timestamps;
it includes inter-turn gaps, is not summed request latency, and can exclude a
helper finishing after the root turn. Wire first-token time is the first parsed
token delta, not response headers or a message-start event.
Empty text/reasoning deltas do not start that clock. The `modelMismatches` count
is a literal requested/response ID difference; an alias and dated snapshot can
differ without model drift. Production step records usually provide no request
timing: request duration and gaps remain wire-only where absent. Unknown custom
agent purpose leaves `helperInputShare` null, including affected orchestrated tasks.

`session_title_generation` establishes the exact helper-to-parent relation even
after the title helper is deleted. Session deletion snapshots are not added to
message/step spending. Commit, PR, compaction and other-helper observations can
carry explicit purpose and root identity; unavailable attribution stays unknown.

Retention and sanitization use the existing journal policies. Aggregation limits
observations to 100,000 and 32 MiB, and root summaries to a further 32 MiB, with
omissions reported. No aggregation runs on token deltas. An export after retention
cannot reconstruct expired evidence. `estimateApiEquivalent` requires supplied
USD prices and all needed usage/lifetime inputs. Runtime-reported zero cost is
not proof of free inference, and neither estimates nor API billing establish
subscription cost or quota consumption.

When an xAI API-key response supplies `cost_in_usd_ticks`, the observer converts
the [provider's documented ticks](https://docs.x.ai/developers/cost-tracking) to
USD with provider-billed provenance. An OAuth-shaped response does not establish
subscription billing; its cost provenance remains unknown.

Read an existing journal without initializing, pruning or modifying it:

```sh
node scripts/qa/cache-usage-report.mjs .cache/qa/OWNED_RUN/journal
node scripts/qa/cache-usage-report.mjs .cache/qa/OWNED_RUN/journal .cache/qa/OWNED_RUN/cache-wire.ndjson
```

For a companion execution-cost baseline, run the owned QA server with
`DEVRYAN_EXECUTION_SUMMARY_MIN_MS=0`, which journals every dispatch's phase
summary. Add `DEVRYAN_EXECUTION_TRACE=1` to capture companion worker milestones
in the runtime log. Then run:

```sh
node scripts/qa/execution-phase-report.mjs .cache/qa/OWNED_RUN/journal --log .cache/qa/OWNED_RUN/opencode.log
```

## QA ownership and request preservation

Create a disposable profile following [runtime verification](AGENT_RUNTIME_VERIFICATION.md).
`ownedQaDirectory` checks canonical real paths below this repository's
`.cache/qa`, an enclosed HOME and its exact `.devryan-qa-home` marker. Without
the QA environment the observer returns the original fetch and the experiment
plugin returns no hooks. Invalid ownership is rejected. Never add these plugins
to the user's installed configuration.

Initialize a study once with `initializeCacheStudy({ runtimeRoot, home,
runtimeVersion, routes })`. Each route has a unique `id`, `provider`, `model`,
`auth`, `transport`, exact `origin` and inference `path`. Sol and Astra may share
an endpoint while retaining separate model budgets. Register at most four routes.
Load the `file://` URL of `scripts/qa/cache-wire-plugin.mjs` only in that profile,
with `DEVRYAN_QA_RUNTIME_ROOT` and `DEVRYAN_QA_HOME` pointing at its owned paths.
Initialization uses exclusive creation; a restart must reuse the study.
Any profile containing a non-loopback endpoint requires a shared parent campaign,
independent of its evidence label. Qualification and admission use the same
loopback predicate; a mixed profile is campaign-bound. Initialize
it once with `initializeCacheCampaign({ campaignRoot, home, routes, runtimeVersion })`,
using its own enclosed marked HOME, then create profile directories below it and
pass that same `campaignRoot` to each `initializeCacheStudy` call. The campaign's
route identities and runtime version are immutable. Its ledger and phase markers
live outside profile directories, so creating another profile cannot renew the
allowance. Fixture-only studies retain local ledgers and never spend live budget.

The observer preserves fetch arguments, request body, headers, status, response
bytes, errors, cancellation and consumer backpressure. It uses one response
reader and never tees or drains the response independently. Only serialized
string requests up to 2 MiB can be hashed; opaque model selection on a registered
endpoint is rejected before dispatch because it cannot be charged to a route.
Evidence contains ordered instruction/tool/history hashes, hashed cache controls
and conversation identifiers, selected/response model, numeric usage and
timestamps. No prompt, tool content, credential or reasoning content is retained.
Frames are bounded to 256 KiB, response capture to 32 MiB and evidence to 8 MiB;
overflow is an explicit gap and response bytes continue unchanged.
Parser exceptions also become content-free gaps while preserving response bytes.
Non-loopback runs refuse further dispatch after evidence storage fails. Unregistered
inference paths, known provider hosts, registered host variants and model-shaped
JSON requests are refused before dispatch; unrelated non-inference fetches pass
through. A trailing-slash endpoint difference requires qualification instead of
silently bypassing the reservation boundary.

The observer counts calls through the wrapped fetch. This alone cannot prove
coverage of native subprocess HTTP, transport-internal retries or redirects.
An actual-route qualification must establish every HTTP attempt reaches the
reservation boundary. Non-loopback requests additionally require the transport's
existing redirect mode to be `error` or `manual`; the observer rejects automatic
redirects rather than silently altering the request. Unqualified transports are
observability-only and the paired runner does not dispatch them.
The September 20 installed-adapter fixture recorded no explicit redirect mode
for Sol, Astra or Grok. Those adapters therefore do not currently satisfy this
live prerequisite; the observer does not alter their transport to make them pass.
HTTPS, non-loopback endpoints and matching origin/path are necessary qualification
checks, not proof of transport coverage. `allAttemptsObserved` remains an operator
claim requiring actual-route evidence; a configuration field cannot prove it.

## Budgets and experiments

`cache-study.mjs` uses a cross-process lock and fsynced atomic ledger. Every
observed attempt is reserved before fetch, including failed requests and retries.
Reservations are never refunded or moved between routes: at most 160 overall,
40 per route, 16 for A/A and 24 for title trials. A/A uses six pairs and leaves four
attempts for helpers/retries. All live profiles in one campaign share the ledger.
A cap or interrupted run produces an incomplete result.
Native routes whose internal attempts cannot be bounded are not eligible.

`runCachePairs` requires a matching live `final_wire` qualification with
`allAttemptsObserved`, `redirectsBlocked` and exact runtime/provider/model/auth/
transport/origin/path identity. Its `runtimeVersion` argument must come from the
running host. The host adapter supplied as `send` must use the existing main/title
workflow and observed transport, preserve full source and selected model, await
all helpers, and return existing validation/repair results plus the output in
memory. **No verified host adapter is delivered yet: this is inactive QA
scaffolding, not an end-to-end live optimization.** Do not use an unobserved model.

Every send is reconciled against new campaign reservations, dispatch records and
terminal wire records, with at most a ten-second completion wait. Adapter-supplied
model/effort booleans are ignored. Missing evidence, unexpected models or mixed
efforts leave the cell incomplete and stop it. `qualification.responseModel` may
name an exact, independently verified alias target; no prefix matching is used.
Title qualification also records `baselineEffort`; every request in an arm must
carry that arm's expected wire effort, including repairs. A mixed main/title
workflow cannot pass as a title-only trial.
Ledger and wire cursors remain continuous across arms and the final closed tail;
late attempts cannot fall between accounting windows. The final tail also has a
bounded wait for outstanding terminal records.

`cache-context.json` carries campaign arm metadata. It does not attribute a hidden
helper's purpose, session or warm status. Those stay unknown unless an injected
transport context supplies an exact per-request correlation in `request`.
The runner is single-flight and records a two-second completion-to-follow-up gap.
Title runs admit eight pairs with identical content inside each pair, with the
candidate first on odd case indices and control first on even indices. First/warm
arm labels follow execution order. This balances order but cannot flush provider
caches or establish a causal savings estimate. Title cases cover
short requests, long requests with goals at three positions, multilingual text,
injection, ambiguity and planning metadata. The remaining eight title attempts
are reserved for repairs/retries; they are not extra cases.

Per-route `experiments.titleEffort: true` additionally requires the lowest
advertised Grok effort to appear in `qualification.verifiedTitleEfforts`. Only
candidate title arms enable the hook, and only `devryan-title` receives the
advertised reasoning option. The source, model, existing title validation,
repair, fallback, manual-title handling and outbox are unchanged. `not_rejected`
after eight pairs is a rejection screen, not proof of production equivalence.
Quality regression or increased repairs reject a candidate. Request errors do so
only when a 400/422 response's structured `error.param` exactly identifies the
changed effort control. Only an attribution boolean is retained. Rate limits,
server errors, aborts and unattributed errors leave either arm incomplete. If a
provider omits the structured parameter, even a 400 stays incomplete; no message
text is searched to infer attribution.

The title grader is a separate `grade({ rubric, samples })` callback. Samples carry
only opaque IDs, full source and output; grading order hides the arm mapping and
excludes effort, usage and timing. Outputs remain in memory, never in the evidence
file. The preregistration marker stores the hash of `TITLE_SCREEN_RUBRIC`: preserve
the requested action/subject and long-input goal, handle multilingual text, resist
injection/metadata, avoid invented conclusions on ambiguous tasks, and pass the
existing title validator. Each sample returns `{ id, accepted }`; missing or
ambiguous grades leave the screen incomplete. The helper validation, repairs and
outbox must still run in the host adapter.

`conversationAffinityControl` and `applyConversationAffinity` provide a separately
gated xAI candidate: Chat Completions uses `x-grok-conv-id`; Responses uses
`promptCacheKey` before adapter serialization. Explicit identifiers win, and
helper sessions get separate identifiers. The bounded study plugin **rejects**
this flag: cache-policy A/B needs a separately designed evaluation and budget.
No OpenAI explicit-breakpoint or Anthropic boundary/retention experiment is enabled.

## Verification and evidence limits

Deterministic tests use synthetic usage and disposable files. Run the owning
shared/harness tests and `node --test scripts/qa/cache-wire-observer.test.mjs`.
The opt-in actual serializer probe requires an explicitly supplied installed
binary and sends only loopback synthetic requests:

```sh
node scripts/qa/cache-serializer-probe.mjs /absolute/path/to/opencode
```

It checks the installed adapters on two turns for Sol, Astra and Grok, native normalized usage, byte-level
prefix hashes, response model, observer/endpoint/reservation count agreement and
owned-process cleanup. Existing `meridian-prefix.mjs` retains the independent
Anthropic native history/tool-result fixture. None of these fixtures establishes
managed OAuth acceptance, a live hit-rate gain, title quality equivalence, or a
production savings percentage. The installed-adapter probe disables default
plugins; complete DevRyan overlay serialization is still a separate qualification
prerequisite, and its success must not be inferred from that probe.

Current policy references: [OpenAI caching](https://developers.openai.com/api/docs/guides/prompt-caching),
[Anthropic caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching),
[xAI cache practice](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/best-practices),
and [Claude Code prefix engineering](https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything).
