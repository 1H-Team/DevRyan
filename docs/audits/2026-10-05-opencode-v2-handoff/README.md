# DevRyan OpenCode 2.0.20 review and completion handoff

Prepared on 5 October 2026 for the next agent. The task is to **independently
review the implementation and its evidence, correct defects, and then finish
the remaining implementation and qualification**. Do not assume that earlier
passing tests establish that the whole transition is complete.

The credential, late-reply, rollback recovery and update-control changes have
been implemented and exercised locally. Overall qualification is unfinished.
The current working tree also contains subsequent UI changes, so the last
qualified source snapshot does not describe all current files.

## Start here

Work in `/Users/zoubair/Repositories/DevRyan`, canonical repository
`1H-Team/DevRyan`. At handoff, the branch is `main` and HEAD is
`797146b3319c0b55231707bd6d9106424869aaf2`. There is substantial uncommitted and
untracked work. HEAD alone is not the candidate identity. Preserve this work;
do not reset, clean, or attribute the entire diff to this task.

Read these in order:

1. Repository `AGENTS.md` and [CODEMAP](../../../CODEMAP.md).
2. The opening scope, approved role graph and current evidence register in
   [the upgrade plan](../../OPENCODE_V2_AGENT_UPGRADE_PLAN.md). Its long later
   sections are historical; they must not overwrite the current requirements.
3. [The Claude review plan](../../OPENCODE_V2_PLAN_CLAUDE.md), then the concrete
   owner files listed below. Review the accepted policy against the code.
4. [Testing](../../TESTING.md), [QA](../../QA.md),
   [runtime verification](../../AGENT_RUNTIME_VERIFICATION.md), and
   [performance guidance](../../AGENT_PERFORMANCE.md) for affected work.
5. The immutable local closeout and evidence index under
   `.cache/v2-validation/`, listed below. Follow their references to original
   command exits, raw results, journals and retained screenshots.

When subagents are used under the applicable instructions, use **GPT-6.1 Sol
with high reasoning**. Give each worker explicit file ownership and remind
them not to revert others' changes. This preference does not change DevRyan's
live role graph.

## Binding scope and policy

- Target native OpenCode **2.0.20**. Preserve settings, projects, agents,
  commands, skill resources, provider choices, workspace bytes and all new v2
  state. Do not import v1 conversations or journals; do not delete old data to
  simulate migration success.
- Independently enrolled DevRyan Claude profiles may renew automatically.
  Shared CLI profiles, including the default live Anthropic acceptance lane,
  are access-only and reconnect at expiry. Status and quota reads must not
  renew or write credentials. Renewal fault tests use isolated backends.
- Bots are now scoped to the **OpenCode 2.0.20 source pin only**. The later user
  correction excludes Bots feature/history/Docker/live qualification. Agent
  managed-user ownership, revocation and event filtering remain required.
- Keep the production interval at **750 ms**. Local measurements may run while
  live access prerequisites are pending; they cannot establish overall
  qualification or independently authorize a switch to 1500 ms.
- Stay inside this repository. Do not access upstream OpenChamber or adjacent
  OpenCode checkouts without applicable explicit permission. Compatibility
  identities are not permission to use those repositories.
- Use existing dependencies and owners. No extension workspace, legacy Tauri
  feature work, new sidecar feature backend, or secret-bearing test fixtures.
  Do not type, store or transmit passwords. Keep verification isolated from
  the user's running app and data; do not stop their runtime or Docker.
- Publication, installed-app cutover, signing/notarization and other-platform
  release qualification remain separate actions.

## Review the current tree before reusing evidence

The prior source snapshot is
`.cache/v2-validation/r20-source-final-8.json`, file SHA-256
`380b23d533d88e97c41834adf9b84f8b47b2129541948dac2d03553982cd35f6`.
Its package-source identity is
`275f5e957a152c11cf4d3d7e61f1d84a0d38d0c56c0eb3ac7bac1977c567eb0d`.

The handoff hash comparison is recorded in
`.cache/v2-validation/r20-source8-handoff-drift-2026-10-05.json`, SHA-256
`172c866f0c64a3f22b74124fbf3de588da068fc5fa39669307172dcbf92b0dd6`.
It is a read-only comparison, not a new validation pass. It found nine modified,
two missing and two new files:

- Modified under `packages/ui/src/components/chat/`:
  `MobileSessionStatusBar.tsx` and `mobileLayoutRefinement.test.ts`.
- Modified under `packages/ui/src/components/session/sidebar/`:
  `DOCUMENTATION.md`, `SessionNodeItem.tsx`, `SessionNodeItem.test.ts`,
  `codemap.md`, `sessionIndicator.ts` and `sessionIndicator.test.ts`.
- Modified: `packages/ui/src/index.css`.
- Removed from the sidebar directory: `SidebarSpinner.tsx` and
  `SidebarSpinner.test.tsx`. Added there: `SessionStatusDot.tsx` and
  `SessionStatusDot.test.tsx`.

**The user explicitly confirmed that the spinner replacement is their change.**
Preserve it. Review its integration and the affected validation; do not revert
it merely to restore the old source hash. Other differences are listed without
attributing authorship.

The current package-source identity at the comparison was
`fb6b8fabe48095d6f045ef79748877aa28e0274fc384e28ae6a4be1b72bd734b`.
The scripts identity remained unchanged, all 11 previously absent paths remained
absent, and all 45 checked historical evidence pins still matched.

Recompute the comparison when starting work because other edits may continue.
Review source changes, added/deleted files and build inputs before deciding
which scopes can retain their prior evidence. The old packaged app still
describes the old renderer. Do not relabel its nine-cell UI pass as a pass for
the changed working tree. Rebuild and requalify affected scopes after fixes.

## Implementation owners and review questions

The native owner directory below is
`packages/web/server/lib/opencode/runtime-host/`. Use its codemap and nearby
tests to follow contracts across the web host, worker, native controller and
Electron shell. This list identifies review targets, not a claim that the code
has no remaining defects.

| Area | Primary owners | What the review must establish |
| --- | --- | --- |
| Claude lifecycle and renewal | `native-claude-lifecycle.js`, `native-claude-lifecycle-kv.ts`, `native-claude-lifecycle-client.js`, `native-provider-runtime-owner.js`, `native-credential-mutation-owner.js` | Durable intent precedes issuer contact; the exact canonical replacement fingerprint precedes credential persistence; settlement follows verified persistence. Uncertain issuer outcomes remain fenced and never trigger another issuer request. Binding includes profile, service and credential generation. |
| Enrollment and inspection | `native-claude-enrollment.js`, `native-claude-enrollment-directory.js`, `native-claude-profile-publication.js`, `native-claude-inspection.js`; provider routes and `ClaudeDedicatedEnrollment.tsx` | Dedicated enrollment uses a verified unused stable directory outside relocatable bundles. Explicit selection preserves existing identities, ordering and settings. Read-only inspection cannot renew. Collision, revocation, changed profiles and interrupted publication fail safely. |
| Worker replies and shutdown | `native-meridian-worker.ts`, `controller-provider-credentials.ts`, `credential-mutation-bridge.ts`, `native-credential-mutation-owner.js`, application shutdown composition | Active plus retired requests share the 64-request bound. Timeouts retain physical ownership until matching reply or confirmed exit. Late replies are validated and consumed once without retaining secrets. Drains and admitted KV finalizers finish before controller shutdown; authorization does not re-enter the mutation queue. |
| Credential migration and rollback | `native-bundle-credential-contract.js`, `native-bundle-credentials.ts`, `bundle-rollback-intent.js`, `runtime-bundle.js`, `runtime-bundle-recovery.js`, `runtime-bundle-resume.js`, `runtime-bundle-lifecycle.js` | Incompatible targets refuse before admission closes. Projection requires the original digest-bound checkpoint/drain/exit proof. Pending intents hold startup even while B remains selected. Resume validates retained state, increments revision and starts a fresh composition. Partial A remains inspectable. |
| CLI and Electron recovery | `packages/web/bin/runtime-bundle-command.js`, `packages/electron/runtime-bundle-recovery.mjs`, `packages/electron/main.mjs`, `packages/electron/preload.mjs` | TTY, noninteractive, quiet, JSON and complete flags use the same core checks. Recovery HTTP stays read-only; main-process IPC owns native actions. Original control-root identity survives real relaunch. Missing proof refuses rather than being replaced with PID absence. |
| Capabilities and explicit update controls | Native artifact/capability validation, `controller-providers.ts`, `packages/ui/src/lib/opencode/runtime-capabilities.ts`, `BundledRuntimeSetup.tsx`, `BundledRuntimeUpdate.tsx` | Missing Claude support yields Anthropic update-required before worker launch/credential authorization. Other providers, setup and the real upgrade route remain usable. Administrator update is authenticated, CSRF protected and revision checked. No automatic startup activation; no `count_tokens` allowance. |
| Original eight fix groups | Relevant orchestration, setup, runtime-host and UI codemaps/tests | Retain model availability, explicit effort, warm-projector activity, restart recovery, interrupted setup, unsettled-helper permits, credential isolation and bundle ownership. Check interactions with the later changes rather than assuming old tests cover them. |

Also review the collector corrections. Relative paths require their actual
working directories; sanitized summaries require original raw hashes; only
scenario-declared cancellations with correlated events and successful later
turns are expected. Do not dismiss raw errors merely because a wrapper passed.
Resolve any available Error Log UUID through the administrator detail API before
correlating the journal. Historical missing UUID/detail evidence stays missing.

## Retained candidates and local evidence

Candidate A is
`.cache/v2-validation/native-artifact-claude-floor-A`, built through the recorded
`r20-build-floor-A.json` command. Its native manifest SHA-256 is
`ed0102407cf907c14889f2e8f6acffde0005c656f14b8ca09ce501848aadc1d4`.
Candidate B is `.cache/v2-validation/native-artifact-claude-final-B`, manifest
SHA-256 `436f16668243af5ae58ea393202499d25e8c06efeeffda093670784a8c43b5c2`,
build ID `e587eaa60f83f2911ee89223504357a7f72879f6ba0557fd652fa2b0978ebef7`.
The retained B records bind 4,695 native inputs.

A is a real predecessor and B came from genuinely different source. Both use
the final credential contract. Preserve both. A later credential contract change
requires a new A as well as B; do not create two differently named copies of the
same build or manufacture state continuity. Use the older incompatible artifact
for refusal tests. Inspect original upgrade evidence for A-derived state.

The following names are relative to `.cache/v2-validation/`:

| Entry point | SHA-256 | Purpose |
| --- | --- | --- |
| `r20-source8-local-closeout.json` | `948ba5c2c1a8fe653c64f60c96047ef1f4f587e1e7cd7449f9f66644d11b20f6` | Last local closeout and unfinished gates. |
| `r20-local-functional-gates-source8.json` | `eb8c74a03f371a90f6217da13644fd5fd66824f362e74e2a1b7ce6736723f1ac` | Thirteen bounded local behavior scopes and nested primary evidence. |
| `r20-local-functional-gates-source8-peer-review.json` | `507e87ddfbb563b2308175e83f139d67b2eec46e4c96715175144ac036c5040e` | Independent index review, 32 named pins and preserved failed attempts. |
| `r20-final-source8-closure-evidence.json` | `74eba6947ee8ad288d6e43e57c8cdd225185f2b20b070ba28ab916f856814b38` | Exact source/app/native check at the prior closeout; not a current-tree pass. |
| `r20-ui-source8-terminal-evidence-v2.json` | `3e134f5c3a3aa2796a4b24dd3d12f8634ec2b968a13c6253da94d1ecabe3513d` | Original nine UI cells, screenshot inventory and journal/cleanup evidence. |
| `r20-positive-electron-source8-retry6-passed-evidence.json` | `c7a95ef1c39dfa01a9e2d97ad1567d514b40d6299c9e41221df2f6707159c9a5` | Actual native Resume, relaunch, readiness and preservation supplement. |

The index records passing full validation, application build and bundle checks,
120 compiled cases, seven application lifecycle modes, seven wire plus two
actual-runtime UI cells, 410 inspected UI screenshots, CLI persistence and the
positive Electron recovery supplement. Documentation validation passed with
existing historical-reference/generated-target warnings. These results have
specific source and execution scopes; they do not certify today's full tree,
live accounts, performance, signing or release.

Keep these limitations explicit:

- The compiled fixtures had **zero of three durable journal roots**. Their
  direct diagnostic arrays are not durable journals. The prospective journal
  completeness requirement is unmet. Investigate and implement the appropriate
  real-owner journal verification; do not turn an empty gap check into a pass.
- Application evidence contains 312 sealed journal records plus seven complete
  open rows from deliberate parent death. The strict all-sealed check remains
  false. UI and positive recovery have separate meaningful journal/gap evidence.
- Positive Electron recovery passed within a disposable first-desktop scope.
  Exact initialization and ephemeral login sessions limit whole-settings/vault
  byte claims. Its initial lifecycle capture intentionally stops at a hook;
  it is not the separate whole-application lifecycle pass. Its conditional CDP
  same-target recovery branch was not exercised by the passing run.
- CLI, incompatible-target, saved-graph and Bots evidence partly retain earlier
  source identities under explicit unchanged-owner comparisons. They are not
  newly executed source 8 tests.
- Failed runs, collector attempts, raw errors and screenshots remain retained.
  Do not change their original grades or replace original command results.

## Finish the live credential handoff

This is **unfinished engineering as well as an external access prerequisite**.
Do not reduce it to asking the user to sign in and then discovering that the
journey runner has no valid credential ownership path.

The existing retained Claude CLI caller can perform read-only login admission
for an independently issued access-only record. Its executable supplies no
matrix callbacks; the default callback is a no-op and stdin accepts only
`status`, `verify-login` and `close`. It cannot run the twelve journeys.

Inspect these prepared, cache-only components; their old source guards require
review and rebinding rather than blind execution:

- `r20-retained-default-live-cli-caller-source5-v3.mjs`
- `r20-retained-default-live-matrix-constructor-source5-v2.mjs`
- `r20-access-only-anthropic-cell-preparation-source5-v4.mjs`
- `r20-prepare-retained-default-live-cli-finalB-source5.mjs`

They live under `.cache/v2-validation/`. The matrix constructor requires real
`bootstrapOtherProviders`, `assertFinalInputs`,
`withOtherProviderSourceHeldCheckpoint` and `beforeMatrixStart` callbacks.
The current auth UI's public lifecycle handle does not expose its private
checkpoint closure. The factory's never-started-source proof applies only to
its newly constructed unstarted source, not an already running auth host.

Implement a fresh composition through the original QA and provider owners that
retains the genuine source and candidate checkpoint authority through sign-in
and cell preparation. Review the smallest typed owner boundary needed to do
this; a genuine implementation change may require requalification. Do not
fabricate authority from serialized profile metadata, PID absence, copied
tokens or a wrapper around the old public handle. Do not introduce a general
secret export or bypass original admission, drains or credential queues.

First complete and test the credential-free composition/ownership mechanics.
Then provide the user a concrete sign-in flow that actually feeds the intended
journey runner. Independently issued grants and dedicated Claude enrollment
remain user prerequisites. Keep dedicated enrollment separate from the default
access-only Anthropic journey; synthetic renewal evidence proves neither live
enrollment nor live provider access.

The old auth UI and CLI handoff were left available at the previous closeout.
Their recorded URLs, PIDs and process-session identifiers are historical. Check
actual ownership and state before reuse; do not kill or restart them based only
on a stale PID or assume an in-memory checkpoint survived process exit.

## Exact live acceptance

Resolve effective settings and project overrides on **web and Electron**, and
verify these selections at physical execution, not just in saved JSON:

| Role | Provider and model | Effort |
| --- | --- | --- |
| Orchestrator | `openai/gpt-6-astra` | medium |
| Fixer | `openai/gpt-6.1-sol` | medium |
| Builder | `xai/grok-4.6` | high |
| Designer | `anthropic/claude-opus-5-5` | medium |
| Oracle | `anthropic/claude-opus-5-5` | high |
| Explorer and Librarian | `opencode-go/deepseek-v4.1-flash` | high |
| Council coordinator | `openai/gpt-5.6-sol` | medium |

Exercise the saved backups: Fixer to Grok/high, Builder to GPT-6.1 Sol/medium,
and Explorer/Librarian to `opencode/deepseek-v4.1-flash` at default effort.
Preserve the ordered Council:

1. `openai/gpt-5.5` at xhigh.
2. `cursor-acp/composer-2.5` at high.
3. `opencode/claude-opus-4-5` at default.
4. `opencode/deepseek-v4-flash` at max.

Run one inexpensive provider preflight before long journeys. Complete three
normal and three Plan journeys per host: **12 journeys total**. Complete two
manual and two natural compactions per mode per host: **16 boundaries total**.
Do not substitute models or efforts to make unavailable selections pass.

Verify setup/plugins, Slim/Ponytail, complete skill resources, MCP, browser,
document and image capabilities. Verify managed-user ownership, revocation and
event filtering using non-production Supabase and the reserved agent-test users
with correct assignments. Use the password-free agent-test login documented in
the runtime runbook. Bots exclusions do not remove these agent checks.

## Performance sequence after correctness freezes

At the previous closeout no short diagnostic or full cohort had run. Three
observation windows found sustained unrelated background CPU contention.
That is historical information, not evidence that today's machine is busy or
quiet. Read fresh load and disk headroom after competing qualification work
and all its owned process trees close. Do not stop user processes to create
the desired measurement conditions.

The prepared recipe is
`.cache/perf/r20-source8-stage-e-held-handoff.json`; the unchanged phase runner
is `.cache/perf/r20-stage-e-finalB.mjs`. Review and bind them to the final source,
artifacts, configuration, role fingerprints and actual local functional index.
Use fresh output roots and retain original command and cleanup receipts.

1. Run the existing short `eight-call-bursts` diagnostic with verified writer
   attribution. It includes 24 warmup and 16 measured writer calls. It is not
   one of the full cohort's launches.
2. Run six managed-child attribution launches.
3. Run 21 calibration launches, then freeze the grading policy.
4. Only if the frozen phase permits it, run 42 paired launches and grade them.

Preserve all seven workloads: idle, one stream, four streams, long history,
1,000-file tools, 12,000-file tools and eight-call bursts. Preserve matching
inputs, original sample/receipt census and frozen latency/resource budgets.
An inconclusive freeze stops the paired phase. Do not splice passing subsets,
change budgets from candidate results or hide missing short-lived processes.
Keep **750 ms** unless every required functional/live gate and measured benefit
supports the change. Local performance can proceed while live access is pending.

## Order of work and completion standard

1. Review the current diff, later UI changes, core invariants and original raw
   evidence. Produce concrete prioritized findings with file/line references;
   distinguish defects from unverified assumptions and evidence gaps.
2. Correct actionable defects and finish the live owner composition and journal
   verification work. Preserve state and existing owners. Add focused tests
   that demonstrate real failure modes, then freeze a fresh candidate.
3. Rebuild/repackage affected artifacts and requalify changed scopes. Use
   `bun run validate:full` for risky runtime/shared-contract work; it already
   includes workspace lint, types and deterministic suites. Run `bun run build`
   and `bun run bundle:check` when build/package inputs change. Documentation
   edits use `bun run docs:validate`; bundled prompts require owning tests.
4. Complete local runtime and UI verification for the final candidate, retaining
   source/build bindings, original commands, meaningful journals, screenshots
   and physical process closure. Preserve actual A to B to A continuity.
5. Complete the exact live acceptance when the independent account and managed
   test-user prerequisites are available. Finish performance in a freshly
   verified quiet window after local correctness freezes.
6. Update one authoritative final evidence table with **passed, failed,
   unavailable and not run**, tied to the final hashes. Keep earlier artifacts
   and failures intact. Update relevant codemaps if ownership/contracts change.

Continue independent engineering while access prerequisites are pending. Ask
only for genuinely missing user information or an action outside the authorized
scope. Do not declare completion while required engineering or qualification is
still missing, and do not treat a status-passed wrapper as proof of unexamined
nested outcomes. Report exactly what passed, failed or remained unavailable.
