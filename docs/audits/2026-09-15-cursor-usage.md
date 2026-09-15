# Cursor usage investigation — 15 September 2026

## Scope and interpretation

This study compares direct Cursor SDK execution, the saved DevRyan control, and
a candidate runtime on identical completed editing work. The SDK is pinned to
`@cursor/sdk` 1.0.28. Evidence is retained privately in
`.cache/qa/cursor-usage-2026-09-15/`; sanitized aggregate results are recorded
below. Existing Composer model-picker changes and concurrent UI work are outside
this change.

The live comparison invokes the shared Cursor runtime in isolated Node workers.
It does not include browser rendering, Electron packaging, automatic web session
titles, DevRyan's managed orchestration, or explicitly enabled ambient Cursor settings. SDK 1.0.28 resolves omitted `settingSources` to no ambient layers, as confirmed in its installed `core/setting-sources.js` bundle and the [SDK MCP loading contract](https://cursor.com/docs/sdk/typescript#mcp-servers). The captured setting-source flag is unset; the five global Cursor MCP entries therefore are not part of this baseline. No additional servers or dependencies were enabled for the study.
The runtime arms retain frozen Builder instructions and all eight eligible
custom-agent definitions; direct SDK execution uses native instructions. This
instruction difference is an explicit part of the overhead comparison. No
instructions, tools, reasoning settings, or models were disabled to reduce use.

The initial revision is `cde7b07884685c412a16d6722205240a80571317`. The initial
working-tree patch and the complete control runtime were captured before these
edits. Each attempt uses a fresh fixture/native store; the third editing prompt
reloads/resumes the same native Agent. Absolute fixture paths necessarily differ
between attempts. Latency is observational on a shared development machine.

## Measurements

- **Context:** existing assistant `info.tokens` keeps its last reported SDK turn
  measurement. It is not replaced by cumulative consumption. The SDK can report
  one logical turn containing multiple model/tool steps, so this legacy measure
  is not an independently verified physical context occupancy.
- **Consumption:** additive `info.cursorUsage` carries normalized cumulative
  `run.usage` / `result.usage`, native Agent/run/request IDs, model parameters,
  status, source and availability. The web host journals this as `cursor.usage`.
  Stream and delta usage are never added to the authoritative run total.
  A snapshot retained after failure can be partial; reported counts do not imply
  complete or settled billing. Late stream snapshots cannot erase a known total
  or change terminal status back to running.
- **Titles:** `cursor.title.usage` records one-shot title consumption separately,
  including native IDs when exposed and explicit unavailability after SDK
  rejection. Direct, persistent and fallback workers forward it; diagnostic
  callback failure cannot purchase a second title or change generation success.
  Title usage never contributes to the chat context meter.
- **Reasoning:** SDK reasoning is already inside output; canonical output and
  reasoning are separated without counting reasoning twice.
- **Quota:** two independent monthly pools are recorded before and after work.
  The baseline is 59.444444% Cursor Models (`auto-composer`) and 4.688889% Other
  Models (`api`). Exploration stops at +6 points, final verification at +8, with
  two points reserved for reporting delay/in-flight work. Failed attempts remain
  in the ledger. The baseline cannot reset when an attempt fails.
  Later admissions also reserve the largest observed comparable attempt cost
  plus 25%; this forecast includes failed attempts and supplements live guards.
- **Cache:** the report follows the SDK's counters: cache reads divided by
  input plus cache reads plus cache writes. This is an SDK-reported fraction;
  local Agent reuse is a separate count. The absolute SDK input basis, quota,
  output, tool activity and latency accompany the fraction.
- **Unavailable:** both historical and live `Agent.getUsage()` calls returned
  `feature_unavailable`. Per-request billed cost, hidden provider retry counts,
  and a billing-based validation of uncached input are unavailable. Included
  usage may consume allowance even when charged dollars are zero.

**Counter overlap is unresolved.** SDK 1.0.28 computes its total by adding
input, output, cache reads and cache writes. In Luna observations, `inputTokens`
is approximately cache reads plus writes, which makes the physical meaning of
those counters ambiguous. The report preserves the raw fields and SDK
arithmetic. It does not label input as proven uncached tokens, the additive input
basis as physical context processed, or the fraction as a verified provider
prompt-cache hit rate. For example, Luna's accepted control run reported
337,129 cache-read tokens against 357,863 input tokens (94.21%); its additive
SDK fraction is 47.11%. Billing evidence is needed to resolve that denominator.
Missing counters remain unavailable.

These distinctions follow the [SDK token-usage contract](https://cursor.com/docs/sdk/typescript#token-usage)
and [Cursor's separate usage pools](https://cursor.com/docs/models-and-pricing).
Quota timestamps establish a fresh fetch, not a provider settlement watermark;
post-run repeated readings provide a bounded settlement check. Active guards normally reuse a reading for at most 60 seconds. A transient refresh failure may reuse it through 85 seconds, retaining its original timestamp; admission independently rejects readings older than 90 seconds. Post-work settlement always fetches distinct observations and makes up to six bounded read attempts after model work has stopped. The endpoint did
not expose a billing reset timestamp in this account. Decreasing usage or a
changed reset identity stops admission. Installed DevRyan Cursor session changes
are monitored; independent Cursor IDE activity cannot be exhaustively attributed
without the unavailable billed records.

## Frozen model selections

| Selection | SDK parameters | Notes |
| --- | --- | --- |
| Grok 4.6 | `effort=high`, `fast=false` | Matches the observed saved DevRyan choice. |
| Auto | `id=auto`, no parameters | Accepted by the native SDK despite omission from its account catalog; the observed result says `default`, without a concrete routed model. |
| GPT 5.6 Luna | `context=1m`, `reasoning=medium`, `fast=false` | Captured SDK default because there was no saved Cursor Luna choice. |

## Findings and acceptance

### Accepted: retry title persistence without repeating inference

Three control/candidate pairs injected one failed metadata PATCH and required
the second save to persist a valid, concise title. Arm order was rotated. Every
trial passed, with unchanged native Auto selection and identical source text.

| Three completed save-retry workloads | Control | Candidate |
| --- | ---: | ---: |
| Native one-shot submissions | 6 | 3 |
| SDK input tokens | 50,442 | 25,215 |
| SDK cache-read tokens | 15,488 | 9,600 |
| SDK output tokens, including reasoning | 2,268 | 1,019 |
| SDK total tokens | 68,198 | 35,834 |
| Cursor Models allowance points | 0.222222 | 0.088889 |
| Other Models allowance points | 0 | 0 |
| Mean title SDK execution time per completed workload | 18.182 seconds | 13.211 seconds |

The causal change removes one duplicate title SDK call per failed save. Across these
three pairs, SDK totals fell 47.46% and allowance consumption fell 60%. This is
the injected **title-save failure scenario**, not an estimate of savings during
ordinary coding. Individual quota deltas are rounded; the SDK invocation-count
reduction is exact. The cache-read fraction under the stated SDK arithmetic was
23.49% in control and 27.57% in the candidate. No cache writes were reported.

### Ordinary coding and native lifecycle

The native Luna lifecycle check passed two MCP question calls with separately
authorized run scopes, one native explorer subagent, and a foreground shell
cancellation. Stop remained cancelled, the delayed finish sentinel never
appeared, and no new native runs or tools appeared during the 50-second
post-cancellation observation. After worker disposal and resume, the Agent
recalled a random token from an earlier tool result after its source file had
been deleted. Its exact value was checked; shared evidence retains only a hash.

This check consumed 0.044444 Other Models points and 0.022222 Cursor Models
points, the latter including the existing Auto title path. The cancelled native
run did not report token usage; its quota cost remains included. Per-subagent
billing could not be separated from the parent using the available SDK data.

The small workload contains three externally graded editing turns, including a
worker reload before the third. All accepted rows passed all three grades,
matched the frozen model parameters, and observed no new inference during the
idle window. Each completed editing workload made **three SDK submissions**;
the native request and hidden retry counts remain unavailable. Cache and token
columns below are means over accepted workloads; cache fraction uses their
summed counters. Output includes reasoning. Full attempts, partial usage and
failure costs remain in the sanitized ledger.

<!-- coding-table:start -->
| Model / arm | Accepted / attempts | SDK input | Cache read | Cache write | Output¹ | SDK cache fraction² | Tools | Work seconds³ | Allowance points⁴ | Including failures⁵ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| grok-4.6 / direct | 2 / 2 | 122,346 | 88,512 | 0 | 3,638 | 41.98% | 19.0 | 70.0 | 0.300000 | 0.300000 |
| grok-4.6 / control | 2 / 2 | 267,285 | 181,888 | 0 | 4,775 | 40.49% | 27.0 | 135.7 | 0.644444 | 0.644444 |
| grok-4.6 / withdrawn experiment | 0 / 2 | — | — | — | — | — | — | — | — | — |
| auto / direct | 2 / 2 | 123,868 | 97,920 | 0 | 2,739 | 44.15% | 19.5 | 49.1 | 0.255556 | 0.255556 |
| auto / control | 1 / 2 | 235,246 | 191,360 | 0 | 3,591 | 44.86% | 27.0 | 61.3 | 0.466667 | 0.933333 |
| auto / withdrawn experiment | 1 / 2 | 211,275 | 159,744 | 0 | 3,211 | 43.06% | 26.0 | 109.3 | 0.444444 | 0.911111 |
| gpt-5.6-luna / direct | 1 / 2 | 172,564 | 159,835 | 12,678 | 2,843 | 46.32% | 20.0 | 55.7 | 0.022222 | 0.066667 |
| gpt-5.6-luna / control | 1 / 2 | 357,863 | 337,129 | 20,662 | 3,733 | 47.11% | 32.0 | 84.4 | 0.022222 | 0.066667 |
| gpt-5.6-luna / withdrawn experiment | 1 / 2 | 365,619 | 342,979 | 22,571 | 4,838 | 46.91% | 39.0 | 96.5 | 0.044444 | 0.111111 |
<!-- coding-table:end -->

1. Reasoning is included in output, never added a second time. Its separate
   per-attempt count is in the JSON report.
2. Cache fraction = reads / (input + reads + writes), with the overlap limitation
   above. Absolute input basis is the sum of the three input columns.
3. Work seconds measure the three prompt executions, excluding intentional
   quota/idle waits. This is shared-machine latency, not a controlled speed test.
4. Per successfully completed workload: Cursor Models points for Grok/Auto,
   Other Models points for Luna. The other pool did not move in these editing
   attempts. Percentages from different pools cannot be compared directly.
5. All attempts' allowance consumption divided by accepted workloads. A dash
   means no accepted denominator; it does not mean the failed attempts were free.

The observed runtime overhead includes the preserved Builder instructions,
custom-agent definitions and different tool choices: runtime sends were about
8.5–8.8 KB, versus 219–481 bytes for the direct briefs. Each runtime send had one
instruction block. The investigation found no duplicated block within a send;
removing instructions from follow-ups would require separate proof of continuity
after resume and compaction. No such removal was accepted.

Three accepted repetitions per model/arm were **not achieved**. Quota-fetch
failures invalidated several otherwise successful attempts, and the next full
Grok/Auto comparison block did not fit the remaining exploration headroom. The
Luna candidate also failed to support a savings claim. We stopped the withdrawn
experiment and used the remaining verification allowance on the kept changes.
The sustained fixture is available in the harness but was not run: the small
fixture produced measurable usage, while a longer run would not resolve the
billing-counter ambiguity. These ordinary coding results are **inconclusive for
an optimization**, and the report makes no per-model before/after savings claim
for the final runtime.

The initial journal investigation found eight synthetic missing-tool-result
receipts in a historical Grok session. The relevant journal and manifest gap
checks found no gaps. These receipts do not prove that the native Agent lost
tool history or retried requests. DevRyan resumes the native Agent by identity;
it does not rebuild Cursor's conversation from UI tool receipts. No speculative
history rewrite or retry was added.

The web title adapter retains a bounded generated-but-unsaved title after
metadata read/PATCH failure, invalidating on source/project changes or manual
rename. The cache holds at most 128 entries and is local to the backend process;
eviction or a backend restart may require generation again. Successful saves
clear the entry.

A deterministic fallback-worker fixture reproduced a separate defect: a
successful native result called an undefined status mapper and became a local
error. The mapper now produces the same success/error/cancelled statuses as the
other transports.

The warm-Agent experiment passed fresh per-send MCP settings instead of treating
rotating question-scope identity as a reason to resume an otherwise unchanged
Agent. It reduced local resumes but did not demonstrate consistent lower
consumption. In the second Luna block, control consumed 0.022222 allowance
points and the candidate consumed 0.044444, with all three edits passing in both.
The experiment **was withdrawn from production**. The existing scope-sensitive
Agent identity and credential handling remain in place. Its frozen source stays
in the private study so the results remain reproducible.

A later Grok trial was interrupted when the baseline chat was deleted. The
journal recorded deletion of a completed chat; reconstructing that one removed
entry reproduced the original account-session hash exactly. No other installed
Cursor session changed. The interrupted trial remains failed and charged to the
ledger, with the deletion reconciliation retained separately from its original
reference. Quota recovery never reset the monthly baseline.

## Final budget and evidence

All 26 admitted live attempts settled: 19 completed and seven failed. This
includes 18 coding attempts, six title-retry attempts and two native lifecycle
checks. Failures remain in the totals; none was reclassified as accepted after
quota recovery.

| Monthly pool | Baseline used | Final used | Study consumption | Approved ceiling |
| --- | ---: | ---: | ---: | ---: |
| Cursor Models | 59.444444% | 65.155556% | **5.711111 points** | 10 points |
| Other Models | 4.688889% | 5.044444% | **0.355556 points** | 10 points |

The final current-source Electron lifecycle consumed 0.066667 Other Models
points and 0.022222 Cursor Models points. Its four usage-reported runs totalled
1,491,047 SDK tokens; the cancelled fifth run reported no usage, and its cost
remains included in quota. The Auto title reported another 11,485 SDK tokens.
Native IDs and all final run usage matched the runtime observations; the title
had its separate usage observation. Two distinct final quota readings agreed,
there were no quota-fetch errors in this verification, and isolated process
cleanup passed. No additional paid usage was enabled.

The final native check used the kept runtime. The earlier Node lifecycle used
the frozen warm-Agent experiment and is retained as separate evidence. The
ordinary coding table's experimental rows therefore do not describe the final
runtime configuration.

## Reproduction and rollback

The opt-in entrypoint is `scripts/qa/cursor-usage-live.mjs`:

1. Choose a new directory under `.cache/qa/` and copy the pre-change runtime to
   its `control-runtime/`, excluding `node_modules`.
2. Run `node scripts/qa/cursor-usage-live.mjs prepare <study-root>` with existing
   SDK and quota credentials available to the credential helpers. This reads the
   account catalog and baseline; it submits no inference and never prints keys.
3. Freeze the candidate runtime in `<study-root>/candidate-runtime/`, again
   excluding `node_modules`. Keep both snapshots unchanged during comparisons.
4. Run `node scripts/qa/cursor-usage-live.mjs run <study-root> <model-id>
   <direct|control|candidate> <1|2|3> small`, one attempt at a time. `sustained`
   selects the longer existing fixture. `lifecycle` on a runtime arm separately
   tests questions, a native subagent, cancellation/resume and title inference. `title-retry` with model `auto` compares native title generation around one injected failed metadata save.
   Adding a final `electron` argument on a candidate arm selects the repository's
   Electron-as-Node binary and current runtime source for native host verification;
   its results remain separate from the frozen Node comparison groups.
5. Use the `summary` action for aggregate observations. An unsettled quota,
   active installed Cursor session, changed reference state or exhausted reserve
   stops admission; investigate without resetting the baseline or dropping costs. `recover-quota` obtains two settled reads after a reporting failure, retaining the failed outcome and all prior consumption.

The private study directory includes `report.json` (sanitized aggregates),
`sanitized-native.ndjson` (numeric observations and hashed native identities),
and `implementation.patch` with `implementation-files.json` (only this change).
The implementation patch uses the original captured runtime as its baseline,
so it excludes the pre-existing Composer model-picker edits and other concurrent
work. Raw study configuration and native stores are private evidence; do not
publish the study directory wholesale.

To roll back from the repository root, first check the saved patch:

```sh
git apply --check --reverse .cache/qa/cursor-usage-2026-09-15/implementation.patch
```

If that check passes and rollback is wanted, the matching command without
`--check` reverses only this implementation. If later edits make the check fail,
review the affected hunks rather than resetting whole files. The reverse check
passed at delivery; rollback itself was not performed. Existing sessions
tolerate the additive metadata. No installed native stores were deleted and
the user's running app was not restarted.

## Verification

| Check | Result |
| --- | --- |
| Final complete Cursor runtime suite | 159 passed; includes cumulative usage, deduplication, partial failure, context compatibility, model parameters, attachment rejection, resume and cancellation across direct/persistent/fallback paths. |
| Final web title suite | 8 passed; covers failed PATCH/read, source/project invalidation, manual/concurrent rename and successful save. |
| Final study evidence/observer suites | 9 passed; covers per-pool guards, stale readings, failed-cost forecasting, reviewed completed-chat deletion, unavailable usage and transparent SDK instrumentation. |
| Electron worker transport fixtures | 12 passed using the repository Electron binary, including title usage forwarding. |
| Final lint, workspace type checks, build, bundle budgets | Passed. |
| Isolated web chat UI | All six checks passed: send, typing, stream, Stop, reconnect and reopen; no browser console errors. Screenshot inspected. |
| Native Node SDK lifecycle | Passed questions, native subagent, cancellation, deleted-file tool-history recall, resume, title and idle checks as detailed above. |
| Native Electron SDK lifecycle | Passed on Electron 41.2.1 / Node 24.14.1 with the final kept runtime: two questions, one native subagent, Stop, deleted-file history recall after restart, title usage and idle checks. All five native runs reconciled with runtime usage observations; source hashes matched final files. |
| Full Electron UI | Unavailable: two isolated launches timed out at the CDP `Runtime.evaluate` startup connection, before scenario checks; cleanup succeeded. |
| Signed/packaged app release checks | Not run; no release was requested. |

`bun run validate:full` was run and **did not pass as one full command**. Its
final attempt passed lint/type checks, then encountered four script-suite timing
failures. The complete serialized script rerun passed 611 tests. Broader package
runs exposed the change-related attachment early-return error, which was fixed;
the final full Cursor suite above passes. Git/proxy timing failures and a UI
source-scan timeout passed focused reruns (70 web and six UI tests).

Two unrelated web `packaged-agent-defaults.test.js` assertions remain failing in
the concurrently edited agent prompts: the expected Designer routing sentence
and the recorded Orchestrator byte count (expected 40,697; actual 40,312). Those
prompts and assertions were left with their owner's work. A final focused run reproduced those same two failures (26 other tests
passed). Other completed package suites passed. This is a recorded validation
limitation, not a full-suite pass. Documentation validation and patch whitespace
checks passed; the documentation validator retains existing unrelated missing
source warnings.
