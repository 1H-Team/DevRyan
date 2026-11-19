# Cache efficiency accounting and bounded QA

Cache efficiency is an accounting and bounded-QA surface, not a cache-policy
default. The UI's active-context calculation, selected models, main-task effort,
native history, permission checks, Anthropic cache boundaries and retention are
unaffected by it. It needs no dependency or database beyond the existing
runtime.

## Review groups and ownership

1. `packages/shared-runtime/lib/usage-observation.js` owns the optional versioned
   `UsageObservationV1` contract, closed metadata projection, token normalization
   and explicitly priced API-equivalent estimates. Harness journal sanitization
   attaches runtime observations to completed assistant messages and step-finish
   events. `packages/harness-runtime/lib/usage.js` reconciles retained evidence;
   existing diagnostic exports include `DevRyan-usage.json`.
2. The disposable final-wire observation tools (`cache-wire-*`, `cache-serializer-probe`)
   were removed from `scripts/qa`; recover them from git history before the
   app-cleanup commit if a new study needs them.
3. `packages/shared-runtime/lib/cache-efficiency-policy.js` owns route qualification.
   The repository-only gated experiment scripts were removed with the study tooling.

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

For a companion execution-cost baseline, run the owned QA server with
`DEVRYAN_EXECUTION_SUMMARY_MIN_MS=0`, which journals every dispatch's phase
summary. Add `DEVRYAN_EXECUTION_TRACE=1` to capture companion worker milestones
in the runtime log. Then run:

```sh
node scripts/qa/execution-phase-report.mjs .cache/qa/OWNED_RUN/journal --log .cache/qa/OWNED_RUN/opencode.log
```

## QA ownership and request preservation

The bounded study tooling is gone: the request observer, the study and campaign
initializers with their shared reservation ledger, the paired runner, the title
grader and its rubric, and the experiment plugin were removed with
`cache-study.mjs` and the wire tools (recover them from git history before the
app-cleanup commit if a new study needs them). No host adapter was ever
delivered, so no live optimization ran end to end. A new study needs its own
design, budget and owner review; the rules it inherited still apply. It runs only
in a disposable QA profile ([runtime verification](AGENT_RUNTIME_VERIFICATION.md):
an enclosed HOME with its `.devryan-qa-home` marker, `DEVRYAN_QA_HOME` and
`DEVRYAN_QA_RUNTIME_ROOT`, as `scripts/qa/isolated-host.mjs` reads them), never in the
user's installed configuration, retains hashes and numeric usage but no prompt,
tool, credential or reasoning content, and reserves every attempt, including
failures and retries, before dispatch.

## Budgets and experiments

What remains is `packages/shared-runtime/lib/cache-efficiency-policy.js`, which no
product code calls today. Every experiment there is off unless a route carries
both an explicit flag and a matching qualification:

- `qualifiedEfficiencyRoute(route, selection)` accepts only a `final_wire`, `live`
  qualification with `allAttemptsObserved` whose `id`, `provider`, `model`, `auth`,
  `transport`, `origin` and `path` equal the route's, an HTTPS non-loopback origin
  without credentials (`isLoopbackCacheOrigin`), the selected provider and model,
  and the running `runtimeVersion`. Fixture evidence never qualifies.
  `allAttemptsObserved` is a claim made by the operator, which this function
  trusts as given: only actual-route evidence that every HTTP attempt, including
  retries and redirects, reached the reservation boundary can justify it; a
  configuration field cannot prove it.
- `selectTitleEfficiencyVariant` (`experiments.titleEffort`, xAI only) returns the
  lowest advertised effort only when `qualification.verifiedTitleEfforts` lists
  it and its options are exactly `{ reasoningEffort }`; it never invents a
  model-specific control.
- `conversationAffinityControl` (`experiments.conversationAffinity`, xAI only,
  with a session) names `x-grok-conv-id` for Chat Completions and
  `prompt_cache_key` for Responses. A cache-policy A/B with it needs a separately
  designed evaluation and budget.

No OpenAI explicit-breakpoint or Anthropic boundary/retention experiment is enabled.

## Verification and evidence limits

Static prefix guards run with the owning package tests.
`packages/agents-core/src/cache-safety-tripwire.test.ts` rejects unreviewed
`Date.now()`, `new Date()`, `Math.random()`, `randomUUID`, `randomBytes()` and
`performance.now()` in agents-core prompt assembly, the native runtime host and
`packages/orchestration-runtime`; each allowlisted file states why its value cannot
reach prefix bytes. `prompt-budget.test.js` and `tool-definition-budget.test.mjs`
ratchet the byte size of packaged prompts, the shared Plan-mode suffix, the hidden
Implement template and bundled or runtime-registered tool definitions.

Deterministic tests use synthetic usage and disposable files. Run the owning
shared/harness tests. The removed opt-in serializer probe used an explicitly
supplied installed binary and only loopback synthetic requests; it checked the installed adapters on two turns for Sol, Astra and Grok, native normalized usage, byte-level
prefix hashes, response model, observer/endpoint/reservation count agreement and
owned-process cleanup. None of these fixtures establishes
managed OAuth acceptance, a live hit-rate gain, title quality equivalence, or a
production savings percentage. The installed-adapter probe disables default
plugins; complete DevRyan overlay serialization is still a separate qualification
prerequisite, and its success must not be inferred from that probe.

Current policy references: [OpenAI caching](https://developers.openai.com/api/docs/guides/prompt-caching),
[Anthropic caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching),
[xAI cache practice](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/best-practices),
and [Claude Code prefix engineering](https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything).
