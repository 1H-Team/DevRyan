# Plugin upgrade qualification — 2026-10-25

Release follow-up: the user subsequently requested committing and pushing the pending changes and releasing DevRyan 2.1.14. The acceptance record below describes the earlier qualification work; live provider qualification and cache/quota parity remain unverified. Release preparation uses the required validation, main CI and packaged upgrade dry-run gates.

Status: **implemented locally; both candidates held from promotion**. Live qualification is deferred at the user’s request; no live inference has run.

Baseline commit: `45906bbe1ad76600495391faf6819e3379971948`.
Existing unrelated edits at task start: UI `devryanConfig.test.ts` and web filesystem `DOCUMENTATION.md`, `routes.js`, `routes.test.js`. These edits are preserved.

## Candidate matrix

| Component | Baseline | Candidate |
| --- | --- | --- |
| opencode-with-claude | 1.8.0 | 1.11.2 |
| @rynfar/meridian | 1.62.6 | 1.79.0 |
| @anthropic-ai/claude-agent-sdk | 0.2.141 | 0.2.141 |
| Managed Claude Code | 2.1.281 | 2.1.302 |
| Native Claude Code | 2.1.302 | 2.1.302 |
| @rama_nigg/open-cursor | 2.5.8 | 2.5.17 |
| Owned @cursor/sdk | 1.0.28 | 1.0.28 |

Claude candidate sources: [release](https://github.com/ianjwhite99/opencode-with-claude/releases/tag/v1.11.2), [tagged dependency lock](https://raw.githubusercontent.com/ianjwhite99/opencode-with-claude/v1.11.2/bun.lock).
Cursor candidate source: [exact upstream commit](https://github.com/Nomadcxx/opencode-cursor/commit/675435282cd89965989da9f04eea767a73872d42).

## Baseline source integrity

| File | SHA-256 at baseline commit |
| --- | --- |
| `packages/web/server/lib/opencode/managed-plugins.js` | `1606476d8ec5163bd9f0bbf4f0903781e827128d43363562f59acdd55b2ebef5` |
| `packages/web/server/default-config/user-profile/package.json` | `af40df85b6c6a66c64b5043113cae3d7e3a1a952ad86f5600ad910c99aadb285` |
| `packages/web/server/lib/opencode/claude-runtime-compatibility.js` | `d3f1152bd8279ed3f53add0ef5166c2ec43d23df4026f2b9e48b3ef89878f5f6` |
| `packages/web/server/lib/opencode/runtime-host/reviewed-claude-transform.js` | `0294c1287468ec72dedd4063ec447d18401b1aaf21ddc2db173d13df6cc568e0` |

## Cursor review and verification

The 2.5.17 archive verified against npm SHA-512 `rxnHitlQAbB8rnzwcQtrFbPrceqQackRtiYhg6wNhnvA/dOLuGd4tDJzUJRP93CtEmPT5zg4BCq3cAEhM8nrfA==`, gitHead `675435282cd89965989da9f04eea767a73872d42`. An isolated script-disabled installation verified exports `id`, `server`, `setup` and duplicate text/tool stream handling without provider requests; scratch was removed.

- Adopt: the managed package version and compatibility entrypoint, with existing server-only adapter and tool/MCP restrictions.
- Already covered by a separate owner: native Cursor execution, persistence, cancellation, tool publication and credentials remain owned by the Cursor SDK runtime.
- Outside this update: upstream installer/setup and replacing DevRyan's native transport with the plugin transport.
- Optional upstream SDK `^1.0.37` resolves independently inside the plugin installation (observed 1.0.40); the application-owned SDK remains pinned to 1.0.28.

## Acceptance record

- Managed registry/default/provisioning tests: 79 passed, including pre-marker migration from both historical and currently shipped tuples. An initial unintended unpdf version edit was caught and corrected before the passing run; unpdf remains 1.8.0.
- Cursor wrapper/migration tests: 18 passed; UI plugin fixtures: 4 passed; native Cursor SDK: 408 passed.
- Packaged orchestration smoke: 15 passed. Claude request normalization, worker authorization and controller preparation: 22 passed. Web type-check passed.
- Claude exact-source review: 40 Node tests and 57 enrollment/security-home tests passed. Process gate: 30 channel/worker/SDK tests and 22 host/OS-incarnation tests passed.
- Full validation passed in 5m58s, including lint, type-check, documentation, import boundaries, browser graph, build, bundle budgets and all 103 test units. Initial failures were corrected with real executable fixtures, finite OS errors and bounded readiness. A later scheduled-task timing failure passed unchanged in its 40-test focused rerun, then the full gate passed. No assertions were weakened. Subsequent QA-only setup refinements passed 42 focused tests and a real disposable-host preflight; the final failure-admission correction passed 23 focused tests.

The authorized Claude budget is 10 percentage points of one five-hour quota window, including failures/retests, with 4 points reserved. Routine runs stop before consuming the reserve. Stale usage, changed reset identity, interference or exhausted headroom stop admission. Delayed provider accounting cannot establish a hard per-request spend cap.

No installed app restart, production profile change, release, push or publication is part of this task. Live qualification must use attended isolated provider owners. Missing credentials or incomplete evidence leaves promotion held.

## Corrected baseline prefix probe

Both streaming and non-streaming baseline probes used `--arm candidate`, six tool steps and parallelism two, raw Meridian 1.62.6 and native Claude 2.1.302. Each produced eight HTTP 200 responses, eight provider/client requests and zero hidden requests. System/tool prefixes were stable and actual tool results were retained, but strict historical-message stability failed at steps 1–7.

A bounded synthetic trace comparison found identical text represented first as a singleton text-block array, then as a string: the Environment row and subsequent token-budget rows. This is structural prefix instability, not lost tool-result text. The grader remains unchanged. Corrected Meridian source SHA-256: `ba36ee4bc294afba3f4885f6d88229d4ded5a3fdfd773fa7406a143ad00cb213`. Probe and diagnostic scratch were removed. Initial setup attempts failed before inference because the reviewed capture is a partial compiled closure; missing raw fixture dependencies were supplied privately before these completed probes.

This baseline result blocks the cache/quota comparison gate; semantic equivalence and synthetic token counts do not prove provider cache parity.

## Native Claude V2 behavior

- Adopt: chronological system updates remain in sequence as escaped user blocks; pending local tool calls or nontext system updates prevent any rewrite. Preserve last cache marker and message metadata.
- Adopt: title/generate and title/summary helper requests detach upstream resume affinity. Compaction retains its session with the upstream compaction source marker.
- Preserve: the private admitted session remains bound through `X-DevRyan-Session`, independent of provider resume affinity; the worker rejects foreign and alternate affinity headers.
- Already covered: physical beta-header stripping and scoped release/cancellation.
- Defer: legacy V1 chat-message human/synthetic markers, absent from upstream V2 and not safely inferred from request kind.
- Adopt: Meridian 1.79 SDK process gate uses the confined supervisor and host-attested actual executor incarnation, recaptured before stdin. Lease attachment precedes stdin; confirmed physical termination precedes release. Crash recovery remains conservative because PID death alone does not prove descendant termination.
- Native lifecycle probes use the host-attested worker incarnation. Foreign process observations remain indeterminate; unsupervised GC refuses before spawning and retains pending deletion. Transcript ownership uses the admitted private directory.

## Candidate prefix probe

Raw Meridian 1.79.0 with Claude 2.1.302 failed strict historical-message stability only at step 1 in both streaming and non-streaming probes; steps 2–7 passed. Each run returned eight HTTP 200 responses, eight client/provider requests and zero hidden requests. Actual tool results and system/tool prefixes were retained. The bounded diff found only the Environment system row changing from a singleton text-block array to an identical string. Source SHA-256: `27e6a3776645b99113aa7003c46165dab0707679c84cd7ded74df2e8664ea49a`. The grader was not changed. Claude remains held; the cache/quota comparison was not run.

## Native artifact and live preflight

Final candidate artifact build ID: `cc47af131a9195043253249064e5299378c5860ae47441b8912835521e7a9fed`; manifest SHA-256: `1ea0f3148190bf4c34a9544d9dedf7c191f5e906deb8038595a1c1a1f8ff3d37`. The independent credential-free host factory diagnostic passed. Its Claude default is unavailable because the canonical API advertises defaults only for connected providers; no model was substituted. Live web/Electron qualification requires attended independent provider enrollment.


### Compiled execution and isolated enrollment preflight

The final artifact passed `compiled-claude-execution.mjs`: actual transformed Meridian, Agent SDK and native Claude returned the synthetic final assistant response, then an actual active loopback request was cancelled with a nonrecoverable executor lease. Bounded settlement required zero active transcript leases, native transport retirement after verified physical receipts, and confined worker shutdown. Only the model response and the observed `HEAD /api/hello` metadata handshake were fixtures; no account or real provider was used. Private fixture scratch was removed.

The first attended Cursor source failed before readiness or sign-in with `native_configuration_binding_mismatch`. Its private diagnostic journal contained exactly two runtime lifecycle records: startup entered settlement, then failed at configuration after 594 ms. There were no sessions; `journal.mjs gaps --verify` reported no gaps. The failure was traced to an eager QA import chain (`live-credential-owner` → `focused-provider` → `native-backend-ui-diagnostic` → `packaged-agents` → `shared.js`) evaluating the configuration path before the selected bundle was bound. Graceful teardown passed; no model request or enrollment occurred. The correction is applied: the tool-ledger reader is imported lazily after host startup. The isolated import-order regression and focused batch passed 42 tests. A subsequent source reached ready but refused a changed saved graph before enrollment. The focused fixture now uses the canonical `devryan-agents.json` preset and primary model-selection settings, and the QA launch environment selects its descriptor-owned artifact directory. The real disposable attended launcher then reached `awaiting-owner` with the exact saved-graph comparator intact; normal close confirmed child and launcher teardown. No sign-in or model request occurred. The focused regression batch passed 42 tests, and all failed/disposable source roots were removed.

## Native package acceptance blocker

Fresh package qualification failed reproducibly with `migration_pending_input_unsupported` after 25 passing cases, including current build inputs, tamper refusal, compiled Claude credential IPC, native tools, write publication, revert/redo and retained-input recovery. The source cohort was unchanged and cleanup reported no failures.

The archived-removal fixture archives its first queued input, then restarts for a second row. Startup reads all inbox rows and rejects the archived row (`package-recovered-input-lane.mjs:115`, `native-recovered-input.js:69`, `bundle-recovered-inputs.js:59`). These owners and the fixture are unchanged from the baseline commit; the scenario uses `devryan-smoke`, and its baseline/candidate artifact is the same OpenCode 2.1.4 build. This existing contract conflict is outside the plugin update. No migration assertion or safety check was changed.

The retained candidate journal contained 16 session buckets, 255 session records and 47 runtime records. Verified gap checking returned zero gaps. Retained diagnostic scratch was removed after review. The remaining package upgrade/rollback gates were not reached and are not counted as passed.

## Final QA admission checks

The shared Claude budget now stops after a failed turn even when final quota sampling succeeds, and a failed focused cell stops the sequence before the next host. Final sampling and cleanup remain mandatory. Tests cover rejected actions, failed quota reads, failed cells and cleanup failures; 23 focused tests passed. No live provider request has been sent, so no authorized quota has been consumed.

The corrected Cursor source reached `awaiting-owner` with the exact `cursor-acp/grok-4.6` / medium graph intact and the final artifact selected. The user chose to leave live checks held before Cursor authentication. Claude live qualification additionally needs its connected canonical default frozen; no model has been substituted. Cache/quota comparison remains blocked by the strict prefix gate. Neither plugin is accepted, committed, pushed or released. The isolated sign-in host was closed with both teardown audits passing and zero remaining owned process IDs; its final journal had six runtime records, no sessions and zero verified gaps. All owned temporary profiles, evidence roots and native build artifacts were removed; this audit retains the sanitized results.
