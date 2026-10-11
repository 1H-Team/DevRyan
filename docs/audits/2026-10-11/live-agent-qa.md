# Attended agent orchestration QA — 11 October 2026

Observation only. No harness code/configuration changes authorized during the run. Scope: agents, planning, delegation, implementation, context and resource use. User controls prompt submission, stopping, repairs and retries. UI sampled with computer use; journal read with repository tooling. Times below are Asia/Dubai (UTC+4).

## Attempt 1

- Root session: `ses_ed4e212fcffeUeK4C6V6RP5UvB`.
- Title: Fix mobile chat positioning and dark mode profile styling issues.
- Selected runtime: `native-c131c30c309834ceaafe8126-r9`, selector revision 10; runtime reports `2.0.26`.
- Artifact manifest SHA-256: `c131c30c309834ceaafe8126d04514a5538495f13e55143d01ed4e98ad7fae82`.
- UI: 1Health/main, Orchestrator, GPT-6 Astra, Medium; plan requested. Prepared prompt covered signed-out mobile chat positioning and several dark-mode profile styling issues, including editor parity.
- First observed output: journal `turn.first_output` at 8,135 ms after its turn timing origin; tool kind. This is an application observation, not provider TTFT.
- Initial `devryan_task checkpoint` returned `available:false`, `harness_policy_disabled`.
- Explorer start failed twice with `managed_agent_model_availability_unknown`: `call_nufFDCTrLu1Rdp7Q9sC9Xjzr`, then `call_14f9ae18f96b4774b2f900b44ce0f077`. Both errors appeared in the UI.
- Parent then read the project directory, stated it would inspect directly because Explorer was unavailable, and loaded Diagnosing Bugs. No delegated child observed before interruption.
- Admission sample: 918 ms total, three ledger commits totaling 645 ms; one commit was 268 ms and flagged slow. These nested times must not be added as independent durations.
- Completed assistant input snapshots: 16,833; 16,882; 17,046; 17,257; 17,527 tokens. Cache reads appeared from the third step (16,640; 16,896; 16,768). Do not sum message aggregates together with duplicate step observations. UI active context reached 6.4% / 17.5K.
- At 17:19:55, journal recorded provider recovery control `stop`, then `turn_aborted` with `reason:assistant_error`; UI showed “The model provider could not complete this turn: Step interrupted.” The `control` record at 1791724795568 confirms `action:abort`, `source:stop_button`. This was a user stop; the provider-failure wording and assistant-error classification need investigation.
- First gap check: no gap records reported; attempt manifest gapCount 0. Manifest at interruption: 1 prompt, 5 completed/error tool lifecycles, 1 session error, 1 aborted turn.
- Resource snapshot during initial activity (single sample, not baseline/peak): app PID16075 RSS 267,872 KiB / CPU3.6%; renderer PID18772 RSS220,400 KiB / CPU17.4%; native controller PID19298 RSS278,336 KiB / CPU6.4%; GPU/helper PID16085 RSS69,680 KiB / CPU15.8%. RSS is not private/unique memory, and CPU samples do not establish sustained load.

## Pending analysis

- Distinguish model catalog availability from provider/model configuration failure for Explorer admission.
- Verify Stop provenance and user-facing classification of interruption.
- Assess whether disabled checkpoint calls and deterministic retries waste a model round trip.
- Keep later reruns separate; do not infer implementation behavior from this interrupted planning attempt.
- Initial generic-catalog hypothesis was superseded by the verified Cursor selection. The applicable path is the separate Cursor validator, not the composite OpenCode provider catalog.

## Stopped-run investigation

The user stopped QA and requested investigation and a fix plan, with GPT-6.1 Sol Medium sub-agents. Application code and settings remain unchanged.

### Live evidence

- Explorer settings and `GET /api/config/agents/explorer/config` agree: `cursor-acp/claude-haiku-5-5`, variant `medium`.
- The objective user message has `metadata.openchamberPlanMode:true`; the parent model is `openai/gpt-6-astra`, variant `medium`.
- `GET /api/provider/cursor-acp/runtime-status`: authentication configured, native credential source, known observation, SDK catalog source, 61 models, no catalog timeout/error, no active Cursor runs. Last discovery completed at 1791724611326, before both failed starts; discovery bookkeeping did not advance during either refusal.
- `GET /api/config/providers` exposes Haiku 5.5 with only a `thinking` variant. Its retained SDK parameters include `thinking:true`, `context:1m`, `reasoning_effort:high`. This is DevRyan's normalized catalog, not an archived raw SDK catalog; it cannot establish whether the account currently offers Medium.
- Runtime diagnostic status: queuedRecords 0, gapRecords 0, lastError null. The Error Logs endpoint is unavailable in this local-admin runtime (404); no Error Log UUID was supplied. Local journal evidence remains available.

### Findings and confidence

1. **Native Cursor catalog validation uses the wrong authorization source.** `packages/web/server/lib/orchestration/runtime.js:304` invokes the Cursor validator. `packages/cursor-sdk-runtime/index.js:2054` requests an owned catalog read; `packages/web/server/lib/opencode/runtime-host/native-runtime-owner.js:867` asks for web-request authorization. The native task has a verified native permit but no HTTP principal. `native-authorization.js:40` refuses that request, and the Cursor validator flattens the refusal to null. This matches the observed 503 and unchanged discovery timestamps. A credential-free reproduction confirms the mechanism; the production journal did not retain the inner refusal code.
2. **Native Plan starts omit the execution needed by the existing fallback.** `packages/web/server/lib/opencode/runtime-host/managed-task-owner.js:107` submits empty provider/model fields. `packages/web/server/lib/orchestration/runtime.js:658` consequently cannot choose the compatible parent execution. Saved Cursor selection reaches validation. Even after fixing authorization, the current blanket Cursor read-only guard would prevent this Plan task.
3. **Effort normalization loses exact model choices.** `packages/cursor-sdk-runtime/index.js:939` and `:967` inspect `reasoning`/`effort`, but not the observed `reasoning_effort`. A fixture containing low/medium/high with thinking enabled collapses into one `thinking` choice. Worse, the compatibility resolver accepts `thinking-medium` while returning the retained high parameters. This defect is deterministically reproduced, not merely inferred from the UI warning.
4. **The blanket Cursor Plan limitation needs updating.** The repository pins `@cursor/sdk` 1.0.28. Current [official TypeScript SDK documentation](https://cursor.com/docs/sdk/typescript#restricting-the-toolset) provides local-agent tool allowlists and exclusions, including task/MCP exclusions. Restrictions must be reapplied on resume. This supports a repair that preserves the configured Cursor model, subject to end-to-end enforcement tests across DevRyan's worker/native boundary.

### Credential-free reproduction results

Existing exported factories were exercised in inline scripts, without creating agents, contacting providers, reading credentials or changing source files.

Authorization fixture:

```json
{"authorizationError":"native_web_principal_required","selectionResult":null,"authCalls":1,"credentialCalls":0,"sdkCalls":0,"refreshBookkeepingUnchanged":true}
```

Variant fixture (three SDK variants differing only in `reasoning_effort`):

```json
{"keys":["thinking"],"selectedEffort":"high","validation":{"medium":false,"thinking-medium":true,"thinking-high":true,"thinking":true}}
```

## Fix plan: exact Cursor Explorer selection during planning

### Outcome and boundaries

Explorer should start under the saved Cursor Haiku 5.5 Medium selection when that exact effort is offered by the authorized account. Plan-mode Explorer must have an enforced inspection-only toolset. If the exact model/effort is absent, report that specific problem before creating a child. Preserve native ownership, credential isolation, revocation, managed task lifecycle and the user's saved model. No dependency upgrade is required by this plan.

### 1. Repair authorization for model discovery

- Add a narrow native-owned catalog authorization path using the current verified task permit and canonical root/session/directory. Keep browser catalog requests on their current web authorization path.
- Recheck the native owner generation, session ownership, hold/revert/stop state and account identity before credential access and after discovery. Never manufacture a web principal or use an unverified global catalog to pass admission.
- Cover all model-validation callers: initial admission, planned backup discovery and recovery admission. Detached recovery must use its own verified task/lease/session authority, not an expired initial tool permit.
- Preserve a bounded diagnostic reason and correlation IDs before converting discovery failure into the public availability result. Distinguish authorization refusal, unavailable catalog and unsupported exact selection; exclude credential contents and raw provider response bodies.
- Primary owners: `packages/web/server/lib/orchestration/runtime.js`, `packages/web/server/lib/opencode/runtime-host/native-runtime-owner.js`, native admission/authorization owners as required, `packages/cursor-sdk-runtime/index.js` and its typed boundary.

### 2. Preserve exact reasoning effort

- Recognize `reasoning_effort` alongside existing SDK parameter IDs in variant naming and scoring. Preserve the original SDK parameters, thinking setting and context size.
- Keep distinct low/medium/high choices. Resolve saved `medium` to direct `medium` first, otherwise an existing unambiguous `thinking-medium`; refuse when neither exists.
- Reject unknown compound aliases instead of collapsing `thinking-unknown` into generic `thinking`. Do not substitute high/default for Medium.
- Update the existing ultra-parameter replacement path to avoid retaining one effort parameter while appending another conflicting parameter. Do not expand the set of models permitted to synthesize ultra.
- Primary owner: `packages/cursor-sdk-runtime/index.js`; regressions in `model-discovery.test.js`.

### 3. Enforce Cursor Plan permissions through execution

- Carry the existing host-derived read-only policy through managed native dispatch and the Cursor worker payload. The model cannot supply or override this policy.
- Use the installed SDK's explicit built-in tool allowlist for Explorer (`read`, `grep`, `glob`, `ls`), with task and MCP/custom-tool delegation excluded. No shell, edit, delete or apply-diff tool may reach this child. Keep any broader specialist needs explicit rather than silently adding tools.
- Apply the policy at every creation, resume, retry and continuation path. Include it in runtime/agent cache identity so a writable cached agent cannot serve a read-only task. Preserve existing native execution confinement and receipt ownership in addition to the SDK tool restriction.
- Remove the blanket Cursor refusal only after these paths pass enforcement tests. Preserve Explorer's saved Cursor selection rather than silently substituting the parent's OpenAI model.
- Restore an actionable unsupported-policy refusal if a path cannot enforce the restriction. The catalog read-only credential grant and task execution permissions remain separate contracts.
- Concrete ownership path: wrap the Cursor branch of `packages/web/server/lib/orchestration/open-code-executor.js:102` in the same fresh managed prompt authority used for other providers. Derive policy from `verifyManagedDispatch()`'s authoritative task in `native-admission-owner.js:1416`, and expose it through `native-cursor-owner.js`'s captured `ownedPrompt` grant. Preserve the `nativeRuntime.cursorPrompt` route.
- Propagate the grant policy through `packages/cursor-sdk-runtime/index.js` inline execution, one-shot payload, persistent prompt and persistent prepare. Update `worker-payload.js` validation, `node-worker.mjs` create/resume options, and `persistent-worker.mjs` create/resume options and cache key. Update the relevant declaration files; both inline and persistent caches must include policy identity.
- Replace the shared and bundled-plugin blanket provider checks only for the verified restricted execution capability; external/legacy paths without that capability continue to refuse or use their existing documented fallback. Do not enable unrestricted Cursor Plan execution globally.

### 4. Verification and acceptance

1. Add a composed native-task regression: the real native adapter, saved Cursor Explorer, Plan-mode objective, no HTTP principal and exact Medium catalog. Assert one child, exact SDK model parameters and the read-only policy; no orphan child on any refusal.
2. Negative authorization cases: missing, foreign, revoked or expired native authority; wrong directory/account; archived, held or reverting session. Assert refusal before credentials/provider dispatch.
3. Variant cases: all three efforts remain distinct, exact Medium round-trips, absent Medium refuses, invalid compound alias refuses, context survives, input order does not change selection, no conflicting ultra effort fields.
4. Permission cases: create/resume/retry/restart/cache reuse retain read-only restrictions; writable-to-read-only reuse cannot reuse writable policy; shell/write/delete/MCP/custom/native-task surfaces remain denied.
5. Retain stop/cancel, child lease/revocation, owner changes, backup/recovery and non-Cursor regressions. Update owning `DOCUMENTATION.md` files for changed contracts.
6. Run `bun run validate:full`; run `bun run build` and `bun run bundle:check` for worker/native packaging changes. Before native packaging check disk space and use repository QA artifact/cleanup procedures.
7. Run the packaged acceptance in an isolated authorized QA profile, then repeat this attended prompt. Confirm one Explorer dispatch, actual Cursor Haiku Medium execution, zero project writes during planning, a rendered plan, clean wait/collection/disposition, no duplicate dispatch and no journal gaps. If the refreshed account catalog lacks Medium, acceptance is a clear exact-selection refusal, not a successful Haiku Medium run.

Primary regression seams: `harness-task-context.test.js`, `runtime-host/managed-task-owner.test.js`, `orchestration/application-managed-agent-model.test.js`, `orchestration/open-code-executor.test.js`, native admission/authorization/Cursor owner tests, `packages/cursor-sdk-runtime/model-discovery.test.js`, worker/cache/payload tests, `packages/orchestration-runtime/provider-capabilities.test.js`, and the bundled `devryan-managed-orchestration.test.mjs` contract. Keep the tests credential-free; use fake SDK boundaries and disposable repository fixtures.

### Deferred observations

User-stop provider-failure wording, the disabled checkpoint round trip, and ledger/resource optimization remain recorded for later QA. They are outside this blocker repair. Broad implementation/performance claims cannot be made from an interrupted 50-second planning attempt.

### Investigation completion checks

- Both credential-free reproductions passed against current repository code.
- Final journal gap check reported no gaps.
- `bun run docs:validate` passed after adding the required audit reference; existing repository warnings remain.
- No implementation, dependency change, live model prompt, full validation, build or packaged acceptance was performed for this planning task.

## Authorized implementation — 2026-10-11

The user deferred live QA to another session and authorized implementation of the delegation repair. GPT-6.1 Sol Medium subagents handled native authority, Cursor SDK policy/variants, and shared orchestration capability, followed by an independent integration review.

Implemented private native catalog authority for managed-tool invocation and detached recovery, retaining owner/revision/hold/cancellation checks. Native Cursor prompts now share the managed dispatch boundary and carry the verified immutable task read-only policy into SDK create/resume and worker cache identity. Read-only execution permits only read/grep/glob/ls and excludes task/MCP delegation; compatibility hosts remain fail-closed. SDK discovery preserves reasoning_effort and refuses absent exact Medium selections. Sanitized catalog failure reasons reach the diagnostic journal even when SDK validation converts the failure to null.

Credential-free tests cover the native Plan Explorer admission, missing/revoked authority, recovery generation and configured backup, policy changes, SDK create/resume/cache restrictions, exact variants, and diagnostics redaction. Targeted integrated web/native checks passed 115 tests. Full validation and build results are recorded below.

Live provider execution, installed-app replacement, and packaged attended acceptance are deferred at the user's request. Actual availability of Haiku Medium in the account remains unverified; absence must result in an exact-selection refusal. No dependency changes or application-data mutations were made.

### Implementation verification results

- `bun run validate:full`: passed on the final rerun, including workspace lint, type checks, documentation validation, and deterministic suites. Final web Vitest summary: 538 files / 6,597 tests passed; the subsequent native Bun fixtures passed 14 tests. Shared UI passed 4,103 tests.
- The first full run stopped in the unchanged offline importer timeout test because its owned-pid fixture did not exist before timeout. That test passed all three cases in isolation, then passed during the full rerun. No assertion or timeout was weakened.
- `bun run build`: passed for the final source, including Electron main bundling. `bun run bundle:check`: passed; web-main gzip 1,442,821 bytes against a 1,456,388-byte budget. Existing dependency annotation/eval build warnings remain.
- Final native authorization regression suite: 38 tests passed; native-host TypeScript and `git diff --check` passed. Manual retry/resume agent overrides retain original authenticated browser authority; supplied automatic-recovery generations never fall back to browser authority.
- Cache report and prune preview completed: 34.81 GiB against a 50 GiB budget at measurement. No bulk cleanup or installed-app change was performed. Superseded logs from this task were removed; no worktree was created.
- Live account catalog, provider prompts, packaged acceptance, and the attended QA replay remain deferred. These deterministic results do not confirm the account offers Haiku Medium.

## Attempt 2 — V2 admission and initial assessment

The next attended run used root `ses_ed473ce26ffevHUja70llWf9Kd`, selected
bundle `native-e6eec1c26f54b657891ccce6-r10`, revision 11, OpenCode 2.0.26.
The user subsequently postponed QA and authorized the repair plan's implementation.
GPT-6.1 Sol subagents investigated and implemented the independent repair areas.

- No root assistant text or reasoning parts preceded the first managed dispatch.
  This proves the absence of a visible assessment, not the absence of private
  model analysis. Astra Medium and detailed reasoning summaries reached transport.
- Explorer task `dvr_task_2c93fb987f4f4efd8560124b4e4be72d`, child
  `ses_ed4728329ffeiJ4PPujG43o9ym`, failed at 19:20:59.290 Dubai before prompt
  delivery: `admission.prompt: the native permission action for tool oc_read is unavailable`.
  The shared read-only policy included additional unsupported enabled aliases.
- The second start timed out at 19:21:39.125; model validation reported
  `native_permit_invalid` with no task ID nine milliseconds later. Source tracing
  found an outer 30-second deadline, unbounded inner catalog discovery, and
  missing cancellation checks before submission. The exact permit-release
  timestamp was not recorded, so the proposed release/recheck race is not a
  fully traced incident sequence.
- Session removal caused the recorded abort at 19:21:53.311. The turn lasted
  138.318 seconds. A final journal `gaps --verify` found no gaps.
- Managed title generation returned 503, then a native title request produced
  the misleading title. The actual user request was present in the journal.
  Current source marks Plan instructions synthetic. The journal sanitizer does
  not retain that field, so its absence cannot prove flag loss or a stale
  deployed artifact. The multipart regression checks the current source path.
- Send-to-acceptance was 14.331 seconds; first provider byte 31.821 seconds;
  first output 38.391 seconds. Initial session-registration lock hold was
  8.029 seconds. Nested/overlapping bridge and ledger durations are not additive.
- Eight stable DevRyan core processes used approximately 740–780 MiB summed
  RSS during the short samples. Observation tools themselves consumed substantial
  CPU and memory. No leak, process proliferation, or sustained resource regression
  was established.

Implementation and deterministic verification results for this second repair
are recorded below. Live provider evaluation, installed-app replacement, and
the attended replay remain deferred.

### Second repair implementation

- Shared managed read-only prompt policy now grants only native-supported
  inspection actions after wildcard denial. Unsupported legacy/custom enables
  and redundant Copilot namespace patterns are omitted. Native admission still
  refuses unknown grants; Cursor's separate SDK restrictions remain intact.
- Orchestrator now requests an ordinary-text assessment before its first tool
  call, with task-specific scope and discovery rationale. Native authority and
  missing-capability failures must be explained without redispatching unchanged
  work or switching execution to evade the boundary. An evaluation grader checks
  visible prose ordering; live semantic/model compliance is not established by
  deterministic prompt or grader tests.
- A shared host-helper definition is applied to native configuration after Slim
  resolution. The controller previously returned `native_helper_agent_unavailable`
  because `devryan-title` was absent from this configuration. The final native
  snapshot now includes the no-tools helpers and disables the competing native
  title agent. The compiled controller regression uses this actual resolver
  output rather than a manually injected helper.
- Repeated native session registration uses the existing committed-snapshot
  read path. New registrations still require durable locked writes; lineage,
  directory, inherited admission state and materialization recovery remain
  authoritative. This removes unnecessary repeated lock acquisition, not the
  unexplained initial registration cost.
- Managed starts now have a 25-second pre-admission budget beneath the unchanged
  30-second bridge limit; native catalog reads have a 20-second default deadline.
  Caller cancellation reaches model selection and is checked again before a
  queued scheduler operation commits. The installed SDK cannot cancel its
  catalog request directly, so owned catalog reads use the existing confined
  worker and wait for termination receipts. Late results cannot establish model
  evidence. Public discovery that reaches its deadline returns declared fallback
  metadata only after cleanup, never a previous account's catalog; model
  admission still requires verified evidence.
  Native authority failures and unconfirmed process termination remain explicit
  through error normalization. No cancelled pre-admission operation may create a
  task; a durable commit already begun retains its normal idempotent outcome.

Focused checks passed: 192 shared policy/executor tests, 154 native admission/web
executor tests, 199 title/configuration/packaged-prompt tests, 30 evaluation tests,
the compiled native helper fixture, and two ledger contention/recovery tests.
No dependency manifests or lockfiles changed.

### Second repair validation and remaining limits

- Full validation passed lint, type checks, documentation checks, script/native
  fixtures and the packages preceding the harness suite. Earlier runs exposed an
  incomplete typed native fixture and outdated routing/read-only fixtures; those
  were corrected without weakening production validation or assertions.
- The harness run passed 702 of 703 tests. Its lock-timing fixture delayed a HEAD
  read which now occurs before acquiring the lock. The fixture now delays
  directory setup inside the transaction; all three timing tests pass with the
  original wait/hold and journal assertions. Only this test changed after that
  run. Validation continued with the remaining package commands rather than
  repeating the already-passing filesystem suites; this is not a claim that the
  interrupted `validate:full` command exited successfully.
- All remaining package suites passed: orchestration, Cursor, Electron, legacy
  desktop, shared UI (4,103 tests), and web (538 files / 6,606 Vitest tests plus
  14 native Bun fixtures). The completed gate and corrected timing fixture
  together cover every full-validation component, with no unresolved failures.
- The account-isolation regression passed with the other model-discovery tests
  (32 tests, 244 assertions). Timed-out catalog discovery cannot return another
  account's cached catalog.
- `bun run build` and the final `bun run build:electron` passed. The Electron
  rebuild includes the last production correction. `bun run bundle:check`
  passed: web-main 4,891,608 raw bytes against 4,962,877 and 1,442,816 gzip bytes
  against 1,456,388. Existing build warnings remain.
- Cache report and prune preview completed: 34.83 GiB of the 50 GiB budget,
  approximately 177.89 GiB free disk, and 3.49 GiB eligible for cleanup. No bulk
  deletion, worktree creation, or installed-app replacement was performed.
  Superseded retry logs from this repair were removed.
- Live provider execution and the attended replay remain deferred. Deterministic
  tests establish configuration and cancellation contracts; actual model
  compliance with the visible-assessment instruction remains unverified.
