# Managed harness optimization

DevRyan keeps OpenCode as the execution engine. The shared orchestration and harness runtimes own durable task state, continuation reservations, verification evidence and recovery. Web and Electron supply the same private bridge; no second scheduler, feature backend, database or child launch cap is introduced.

## Configuration and ownership

Standard roles in this repository come from `packages/web/server/default-config/agents`. Project `AGENTS.md`, custom roles, explicit model/effort choices, Council model companions, providers, MCP and LSP remain authoritative in their existing scopes. `.opencode/README.md` describes the migration of obsolete standard-role copies.

Preflight and run-start diagnostics record resolved runtime version, provider/model/variant, role source and content hashes, configured plugin identities, observed plugin factory loads, catalog hash and policy flags. Configured names alone do not prove a duplicate load. Unknown or unavailable catalog/factory evidence stays explicit. No plugin entry is deleted based on a similar name.

The existing primary recovery controller owns managed continuation reservations across providers. Collection, Orchestrator TODO and Builder TODO wakes must match its real-user anchor, model selection, cancellation generation and canonical settled state. Reservations persist before submitting a synthetic prompt. Unknown ownership fails closed; project auto-resume and Slim cannot submit a competing managed turn. Standalone use retains its own hooks. Collection and compaction do not refill repair or TODO budgets. Provider-specific transport recovery, role deadlines and Designer/Fixer's existing 150-plus-20 turn safeguards remain separate.

Managed ownership applies independently of the optional switches. A root without a retained owner record, including a pre-upgrade root, needs a new real user instruction before automatic continuation; history cannot recreate spent budgets. This condition reports `managed_objective_unavailable`. An obsolete private-bridge token reports `managed_bridge_authentication_failed` with managed-runtime reconnect guidance. These diagnostics do not silently repair credentials or permit workspace mutations when the bridge is unavailable.

## Independent rollout switches

Duplicate outputs default on only for a non-stale qualified profile: a verified executable, managed transport, route and ordered managed plugin content inventory. The current release profiles match the DevRyan companion 2.1.0 build of OpenCode 1.18.32 by build identity (upstream version, base commit, patch and build inputs) and the policy vector: xAI OAuth Responses `grok-4.7` / Medium and `grok-4.6` / High, and OpenAI ChatGPT Responses `gpt-6-astra` / Medium and `gpt-5.6-sol` / Medium ([route audit](audits/2026-09-24-duplicate-routes/README.md), −26% primary-request input on xAI, −29% on OpenAI). `devryan-companion-2.0.0-openai-sol-medium` ([requalification audit](audits/2026-09-24-companion-requalification/README.md)) and `opencode-1.18.31-openai-sol-medium` ([qualification audit](audits/2026-09-20-context-deduplication/README.md)) stay on record as `stale`: their plugin bytes changed, and they pinned executable hashes. A stale profile keeps its evidence on record but never qualifies. Other optimization defaults remain off. Set a switch to exactly `1` in the owned managed host environment and restart that host to request its behavior; duplicate outputs still require a qualified profile. Set it to `0` and restart to roll back; durable tasks, envelopes, history, receipts and decision provenance remain valid. Installed apps acquire these release defaults through their normal update and managed-runtime restart, not an in-place experiment.

| Environment switch | Negotiated capability | Behavior |
| --- | --- | --- |
| `DEVRYAN_MANAGED_READ_OVERLAP` | `readOverlap` | Host-approved native reads and known retrieval tools while grouped children run or await disposition. |
| `DEVRYAN_MANAGED_WAIT_ANY` | `waitAny` | `devryan_task` `wait_any` with explicit `task_ids` and optional `after_cursor`. |
| `DEVRYAN_COMPACT_MANAGED_RESULTS` | `compactResults` | Version-1 canonical result header before selectively retrieved detail; declared required-check observation. |
| `DEVRYAN_TASK_CONTEXT_PROJECTION` | `contextProjection` | Bounded task checkpoints, project decisions and native compaction context. |
| `DEVRYAN_DUPLICATE_OUTPUTS` | `duplicateOutputs` | Qualified skill/managed-result duplicates in ordinary requests; independent of checkpoints. |

Legacy eager/reference result clients and single-task `wait` remain supported. `DEVRYAN_MANAGED_RESULT_MODE=eager` retains its existing rollback behavior. No optional optimization is promoted solely because deterministic tests pass.

## Reads, waits and result delivery

The host allowlist in `harness-policies.js` is independent of session-change capture. Arbitrary shell/code execution, tool annotations and unfamiliar MCP tools cannot authorize overlap. Workspace writes, dependent execution and final completion remain gated. Native read identities captured while child writes are possible are provisional. Before a later existing-target edit/write/patch, the host requires a fresh unchanged identity; unknown, oversized, raced or evicted identities require another read. Legitimate new-file creation remains possible. Native freshness enforcement still applies; file sampling is not an atomic filesystem transaction.

`wait_any` returns only committed terminal envelopes. Scheduled recovery and manual attention are separate states, not ordinary collectable successes. Version-2 persisted cursors include the exact selected task set: foreign-root cursors fail; expired, version-1 and changed-selection cursors reset to an authoritative snapshot, including when a large selection shrinks. Request-size limits remain at the private transport boundary. Registration and snapshot capture share the scheduler's mutation queue, closing the completion-before-wait gap. Timeout/abort cleanup removes subscriptions without cancelling children.

Meaningful collection changes advance the existing persisted envelope sequence. Repeated recovery scheduling within the same state does not. Snapshots retain full attention, pending and unacknowledged state while identifying changed tasks, dispositions, retry follow-ups and other ready same-root tasks. Unchanged attention stays inside the attached wait while selected work runs; all-parked or fully dispositioned selections return explicit next-step guidance. An own `continue` disposition does not produce an empty wake while another selected child runs. The host projects manual-recovery authority; legacy clients retain compatible fallback classification.

One directory-scoped envelope commit watch triggers the existing collection scan. An idle root receives one claimed owner reservation; a busy root waits for a safe native boundary. Unchanged private wait slices do not produce model turns. Terminal state and envelope persistence precede notifications and dispositions.

## Required checks and compact results

A dispatch can declare up to eight named checks, each with an exact native command and project-relative relevant files. Before execution, the observer atomically reserves every check matched by that command, clearing earlier passes even if canonical message lookup is unavailable. It then binds the actual native call's assistant-message identity and captures bounded file manifests. An explicit command working directory must resolve to the task directory. Only a numeric canonical exit and matching final content can prove `passed`; nonzero exits prove `failed`. Missing calls, missing/wrong checks, absent exit metadata, stale leases and unavailable or changed content are `not-observed`. A pass followed by a relevant edit is unverified until rerun. Coverage is explicitly limited to declared files and checks.

Start, identity binding and completion each commit all matched check names together. Completion must match the current call and non-null message identity. Conflicting canonical identities invalidate the group with `canonical_check_identity_conflict`; late older completions cannot replace newer evidence. Duplicate calls cannot reconstruct lost pre-execution hashes from post-execution files. Reservation failures stop the observed native command; after a durable unknown reservation, unavailable identity or a lost completion remains unverified.

Failed capability negotiation is retried after the connection recovers, rather than cached as disabled. Until policy is known, or when an enabled reservation cannot be confirmed, the plugin fences native bash with `managed_check_observer_unavailable`. This deliberately also affects commands without declared checks during a bridge outage: the plugin cannot independently prove they are outside the check contract. Explicitly negotiated disabled policies remain inert.

The version-1 compact result header carries canonical outcome/partial status, critical failures, recovery restrictions, check evidence, coverage and detail references. A separate non-authoritative `reported` field parses the retained child's terminal Status and Routing markers outside code fences. A blocked, missing or ambiguous marker, truncated preview, partial outcome, recovery restriction, failure or missing/pending/failed required check requires all retained detail pages before any disposition. Only a complete, fully verified header permits selective retrieval. Legacy clients still read every retained page. Reading detail allows reconciliation of partial work without claiming successful verification.

## Task and project context

Task checkpoints are derived from the real-user anchor, selected-plan references, canonical native TODOs, active or undispositioned children, checks and recovery state. They are bounded, regenerable records in the existing harness storage. Missing or truncated context names the canonical reference and valid retrieval action. It cannot authorize a write or recovery.

Project decisions require an exact quote from a canonical real-user message in the same project, with source identity and optional content/expiry validity. Retrieval separates active, stale, expired and superseded decisions and considers relevance before recency. Non-Git global projects remain directory-scoped. There is no personal or cross-project memory.

The managed harness plugin is the sole owner of duplicate output projection. It updates the message array consumed by OpenCode, cloning only changed records. The standalone skill plugin keeps discovery, aliases, descriptions and catalog formatting, with no transcript rewriting. Only completed native skills and supported structured managed observations qualify. Candidates must match scope, input, output, title and supported metadata, and fit within 256 KiB of UTF-8 output. Attachments, unknown skill metadata, signed/opaque provider fields, pending/error calls and native-pruned outputs are retained. A replacement must be smaller after JSON serialization and reference full evidence in the same outgoing request. Every content transition survives, including A → B → A. After a shortened result, the next same-key observation remains full, even when other tools intervene. Unchanged native history retains a stable projected prefix; native pruning can change it. Repeated byte-identical synthetic user instructions of at least 1 KiB (for example the Plan-mode preface sent with every plan revision) follow the same rule: the first copy since the last compaction stays full and later copies become a `<devryan_instruction_reuse>` reference. Earlier messages never change, so the cached prefix stays stable. This shares the `duplicateOutputs` qualification.

Recovery turns deliberately keep their restricted tool block (only verified native `read`, `glob` and `grep`), even though changing the tool block misses the provider cache for that one turn. With the full tool list visible, the model attempts guarded writes, and the independent guard then ends recovery. For a rare turn, recovery success outweighs one cache miss.

Every native compaction is re-anchored, independent of `contextProjection` (host kill switch `DEVRYAN_COMPACTION_ANCHOR=0`). The `experimental.session.compacting` hook asks the host for a `compaction_anchor` (5 s bound, never throws) and appends it only to the summary request, so ordinary requests and their cached prefix are unchanged. A root anchor is deterministic, capped at 12 KiB and built without writing records: the verbatim objective (≤6 KiB), the approved plan file and its heading/list outline (≤3 KiB; a plan referenced from another session is read only when both sessions share an owner and a project), open todos, outstanding sub-agent tasks, read-only restrictions and the next action, with an instruction to start the summary with `## Objective anchor` and carry it across repeated compactions. A managed child gets its delegated assignment (`## Delegated assignment`). The executor never collects a child on a compaction summary; an idle child whose latest assistant is a summary receives the existing assignment-bearing empty-output continuation. The objective is the anchored user message, or the objective an explicit continuation (`objectiveID`) continued. A completed manual `/compact` (`auto: false`) with open todos continues once through the open-todo continuation, which is a maintenance prompt and keeps the anchor; automatic compaction continues natively, and DevRyan adds nothing even when that continuation did not happen. DevRyan never sends its own continue prompt, which would replace the objective anchor.

Native summary requests skip projection. A bounded per-session marker is set before asynchronous compaction work and consumed by the next unambiguous same-session transform. It has no timer; a failed/cancelled compaction may conservatively skip one ordinary request. Unknown or mixed-session inputs remain full, and marker overflow disables projection for that plugin instance. Summary transforms/system hooks cannot replace ordinary headroom metadata. Checkpoint failures emit only a fixed diagnostic reason. Checkpoints and summaries retain their existing authority and continuation rules.

`harness-duplicate-qualification.js` checks the release profiles in `harness-duplicate-profiles.js`. An exact runtime version and executable hash, provider/model/variant, selected-provider configuration hash, host-attested authentication transport, and ordered local plugin content identities must match a profile with complete acceptance evidence. The native resolved plugin list includes discovered files; the independent host read must match the plugin's full snapshot, including absolute source identities. Release matching permits relocation of identical managed files. Unresolved package specs, plugin options, custom/changed configurations and missing evidence retain full output. Factory reports remain separate from this inventory. Only validated, non-stale release profiles marked `defaultEnabled` activate automatically (a stale profile is denied as `profile-stale`); setting `DEVRYAN_DUPLICATE_OUTPUTS=1` cannot bypass qualification. Setting it to `0` disables projection after the normal managed-host restart. Optional capability/qualification discovery runs in the background with a 30-second failure backoff; required-check observation still retries immediately and fails closed.

No extra model call, pruning of generic native tools, history store, retrieval endpoint or inference-time summary engine is introduced.

Declared input/context limits and the last matching request's input/cache usage inform a labelled headroom estimate on checkpoint and compaction results; current active-context tokens remain unknown. Bytes and cumulative usage are never presented as exact active context.

## Progress and failures

Durable progress counts new authoritative tool evidence, child completion, changed artifacts and observed required-check outcomes. A newly started check durably replaces an older pass with `not-observed` before execution; that pending receipt does not count as useful progress. Completion must match the current check's call and message identity. Late older completions cannot replace newer pending, failed or passed evidence, and a duplicate start cannot reset that same invocation. Lost completion hooks and restarts therefore cannot resurrect the older pass. Token output and elapsed time remain liveness signals only. Broad semantic stagnation is report-only.

Managed Builder TODO continuation additionally requires current canonical open TODOs to match a completed native `todowrite` after the real-user anchor. The existing objective record stores task/progress hashes, progress-count watermarks and a stagnation count. After two unchanged nudges, another is denied; changed TODOs, verified artifact changes, observed required checks or completed children clear stagnation without refilling the existing twelve-continuation objective budget. Generic tool output, including changed durations in repeated failed tests, cannot reset this guard. TODO echo alone is not useful tool progress. Missing or mismatched current TODO evidence cannot authorize a nudge.

For identical deterministic pre-execution input/binary-read rejection within one objective, the first response asks for corrected input, the second permits one corrective replan and the third pauses automatic continuation. Reordered duplicate call observations cannot consume extra attempts. Failed commands and ambiguous possibly executed writes do not enter this counter. Transport, quota, authentication, unavailable model and prompt rejection use shared classification without converting unknown delivery into success or replaying a possibly executed write.

## Diagnostics and evaluation

PRs run `bun run perf:harness --baseline <checkout> --output <report.json>` against the PR base revision. Three fresh worker pairs alternate B/C, C/B, B/C. Ledger retention and vector ranking must match their independent oracles; serialization, vector decoding and offset traversal counts must not regress. Time, process CPU and forced-GC worker heap are retained as descriptive measurements, not machine-independent speed thresholds. The workflow publishes `DevRyan-harness-comparison` and uses no providers or credentials.

For a release decision, `bun run perf:compare --config <config.json>` combines matching deterministic report files with optional live paired agent report files. Config schema version 1 requires `baseline`, `candidate`, and `output` paths (relative to the config), and accepts `agentPairs: [{ baseline, candidate }]`, `factor`, and `targetMetric`. Supply three pairs, or ten after outcome disagreement. Fixture/protocol/runtime identities and case membership must match; native reports additionally use the existing fingerprint/outcome comparator. The numeric projection covers success, input/output tokens, retries, latency, CPU and retained bytes. Unobserved provider retries or CPU remain null; managed retry dispositions are not relabelled as total provider retries. Passing local checks cannot enable a policy or replace the required manual/natural native journeys.

Generate the optional Orchestrator candidate with `node scripts/agent-evals/compact-orchestrator.mjs --output .cache/qa/role-candidate`. It moves templates and duplicated workflow text to `skills/devryan-orchestration-guidance/SKILL.md`, retaining persistent routing, permissions, recovery and implementation-start admission. Provision the guidance identically in both isolated arms, copy only the candidate role into the candidate arm, and compare with `pairing.factor: "role"` and target `input`. The packaged default stays unchanged until those trials pass; fewer prompt bytes alone are not an outcome or token-efficiency result. Result (2026-09-23, OpenAI gpt-6-astra medium, 3 alternating pairs over the five routing and managed cases): every case passed in both arms, and candidate input totalled 656.6k tokens against 651.7k for the baseline (+0.7%, with large per-case variance). The verdict was `inconclusive` (`target_waste_not_reduced`): loading the guidance skill on demand offsets the smaller role, so the packaged role stays.

The optional [cache accounting contract and QA workflow](CACHE_EFFICIENCY.md)
adds `DevRyan-usage.json` to the existing ZIP. It reconciles runtime steps and
message fallbacks, retains deleted title-helper attribution, and separates actual
provider evidence from runtime accounting. It changes no inference defaults.

The existing diagnostics ZIP includes `DevRyan-trace.json`. The authenticated `POST /api/diagnostics/export` also accepts `format: "chrome-trace"` with its existing runtime/task scope. Open the JSON in [Perfetto](https://perfetto.dev/docs/getting-started/other-formats). Root/task lanes correlate retained ledger, message, call and recovery identifiers. Export is bounded to 100,000 events and 32 MiB per projection stage; overflow is explicit.

Observed queue, tool, workspace-gating, disposition, native turn, objective and recovery durations retain missing timestamps as null. Workspace gating is not parent idle time, observed first activity is not wire time to first response, overlapping duration sums are not a critical path, and cost is labelled native-runtime-reported or unavailable. A runtime-reported cost does not establish a provider bill or a provider-reported charge. Input/output/cache usage is deduplicated by canonical message. Context observations label `hook-applied`, `summary-suppressed`, `checkpoint`, `checkpoint-unavailable`, or historical `legacy-estimate` phases. Planned/applied counts and transform duration are separate from final-request sizes, which production hook diagnostics cannot establish and leave null. Structural metadata excludes private reasoning, opaque provider blobs and raw tool arguments/output. Repeated identical known diagnostics aggregate by identity/cause/generation; retention writes age/size eviction reasons before deletion. These additions do not establish why older historical evidence was already missing.

Task exports attribute exact DevRyan-owned managed-task events to their root and preserve the recorded child relation even when the corresponding native session-created event has expired. The sanitizer preserves only the fixed `owner: devryan` marker needed for this attribution. Historical records whose owner marker was already dropped cannot establish that ownership. Unknown ownership, conflicting explicit roots and unrelated same-directory tasks cannot widen the export scope.

The existing `agent:eval` CLI accepts a deterministic 30-case golden catalog and live paired mode; see `scripts/agent-evals/codemap.md`. Golden selections fail when no tests actually run. Paired mode alternates three trials per arm, freezes fixture/environment/model/effort and nonexperimental fingerprint dimensions, and retains interrupted/failed outcomes. Disagreements require investigation and ten pairs. Unknown metrics, unavailable models, configuration mismatch, failed outcomes or no reduction in the declared target cannot qualify promotion. Models are never silently replaced.

Run `bun run validate:full`, `bun run build`, `bun run bundle:check`, and applicable isolated checks from `QA.md`. Fixture compaction and UI replay do not prove live native compaction. A complete memory/performance comparison requires the repaired canonical-to-visible long-history witness, matched baseline measurements and inspection of every captured PNG.

The [2026-09-10 implementation audit](audits/2026-09-10-harness-optimization.md) records the completed local checks, matched whole-package observations and unresolved native acceptance gates. Optional policies remain off by default.

The [2026-09-20 resource implementation audit](audits/2026-09-20-devryan-resource-improvements.md) records the bounded queues/history budget, batched streaming, compaction/search/compression changes, deterministic baseline comparisons, native fixture checks and remaining provider-dependent qualification.


## Designer routing regression

The agent evaluation harness includes `routing-visual`, `routing-approved-visual`,
and `routing-behavior`. Run them with the existing `bun run agent:eval -- --config
<path>` interface against a separately prepared, isolated loopback verification
host and disposable fixture repository. Pin `agent` to `orchestrator` and choose
an advertised provider, model, and variant. Do not point these implementation
cases at a user's active project or runtime.

The approved case first asks for a plan without edits, then sends exactly
"implement plan" in the same session. Prior root messages cannot satisfy the
second turn's terminal evidence. Visual cases expect Designer; the zero-price
behavior control expects Fixer and preserves the existing presentation. Expected
roles remain outside model prompts. Grading checks the recorded managed agent,
exactly one implementation child, completed/dispositioned work, unchanged tests
and unrelated files, and failing-before/passing-after source acceptance tests.
These checks establish routing and source behavior, not rendered visual quality.
Deterministic tests exercise the fixtures, wrong-role rejection, and stale-turn
handling without calling a provider; live model results must be reported separately.

## Duplicate-output acceptance

Run the isolated real-runtime loopback probe against each supported build:

```sh
node scripts/qa/cache-serializer-probe.mjs /absolute/path/to/opencode --duplicates
```

The probe uses the existing repository SDK, private homes and synthetic requests; it never reads installed-app history or provider credentials. It verifies off/on request sizes, no-duplicate controls, native-pruned anchors, later bundled hooks, canonical history, two manual summaries, automatic compaction and hook ordering. Raw bodies are inspected only in memory; the retained report contains sizes, fixture identities and checks. Synthetic token usage exercises native compaction and is not provider usage or cost evidence. Unit tests additionally exercise cancellation/failure, concurrent sessions, model switches, capability backoff and ordinary headroom preservation.

Live behavior is a separate gate in `scripts/qa/duplicate-behavior.mjs`. Supply ten distinct matched live trials per proposed profile, five skill-reuse and five managed-result-continuity pairs, with independent grading and report hashes. Require no critical continuity failures, repeated mutations, or increase in same-key repeat-call rate. Missing/incomplete trials fail qualification. Retain failed trials; do not replace them with successful retries. This gate does not alter the existing performance comparator or claim statistical reliability. Store the reviewed acceptance report hash with the exact release profile only after correctness, final-request and live behavior checks all pass.

### Live routes

`scripts/qa/duplicate-live.mjs` picks its wire route from the proposal's `profile.providerID`. The proposal's `profile.transport` must be that route's host-attested transport. Otherwise the runner stops before it creates output, a certificate or a host.

| Provider | Forwarded request | Host-attested `transport` |
| --- | --- | --- |
| `openai` | `POST chatgpt.com/backend-api/codex/responses`, ChatGPT OAuth | `openai-chatgpt-managed-responses-v1` |
| `xai` | `POST api.x.ai/v1/responses`, xAI OAuth | `xai-oauth-responses-v1` |
| `anthropic` | Loopback Meridian | None; fails with `unsupported-route:anthropic-meridian` |

The host names the transport in `packages/web/server/lib/opencode/duplicate-provider-route.js`. OpenAI uses the OpenAI OAuth coordinator. xAI reads only the `type` of the `xai` record in OpenCode's `auth.json`, the record OpenCode's xAI plugin uses. API-key xAI names no transport, so its candidate arm cannot qualify. The selected-route `providerHash` covers endpoint overrides.

The wire proxy forwards only the registered route and the proposal's model. The runner waits (bounded) until no forwarded request is in flight before it deletes a trial session or stops an arm: deleting a session aborts its background title request, which on xAI can still be streaming after the reply and would otherwise be recorded as a transport failure. It also forwards the reviewed metadata GETs. It refuses every other CONNECT, including the xAI token endpoint. The copied access-only token must therefore outlive the run. OpenCode's xAI plugin refreshes two minutes before expiry, so admit the credential with a duration check covering the whole run. Run the pilot, then the acceptance, then default verification after promotion:

```sh
node scripts/qa/duplicate-live.mjs PREPARED_ROOT BOOTSTRAP --pilot
node scripts/qa/duplicate-live.mjs PREPARED_ROOT BOOTSTRAP
node scripts/qa/duplicate-live.mjs PREPARED_ROOT BOOTSTRAP --verify-default
```

`PREPARED_ROOT/proposal.json` holds `{ "profile": { ... } }`: the candidate release profile, including `providerID`, `modelID`, `variant`, `providerHash`, `providerScope: "selected-route"`, `transport`, the runtime identity and the ordered `plugins`. Stage it in the prepared host's private source copy before either arm runs. The result's `wireRoute` records the route used.

Claude through Meridian is not captured. OpenCode sends Anthropic Messages to Meridian on loopback, which `HTTPS_PROXY` never sees, and Meridian's Claude Code child rewrites the upstream request. Qualification would need:

- A loopback capture of the OpenCode-to-Meridian `POST /v1/messages` that forwards bytes unchanged. It must not change the selected provider's configuration, which is part of `providerHash`.
- A Messages projection that pairs `tool_use` and `tool_result` blocks by `tool_use_id`, not Responses `input` items.
- Anthropic usage parsing, which `createWireUsageParser` already supports for `anthropic`.
- A host-attested `anthropic` transport that also binds the Meridian and Claude Code versions.

Report serialized sizes/peak size, transform overhead, compaction count, actual provider input/cache tokens and peak input separately. Unobserved provider metrics remain unknown. Do not infer monetary savings. Historical replacement-array estimates do not establish provider savings; see the correction in the [original audit](audits/2026-09-10-harness-optimization.md).

The [context pipeline repair audit](audits/2026-09-20-context-deduplication/README.md) records local request evidence and the incomplete live qualification gate.
