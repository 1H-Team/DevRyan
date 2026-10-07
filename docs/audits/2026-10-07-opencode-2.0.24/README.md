# OpenCode 2.0.24 qualification

Workstation qualification on 2026-10-07. The registry was checked once at the
start and the candidate frozen at 2.0.24. The running installation was not
changed. Live-account acceptance and the actual cloud import remain pending.

## Implemented behavior

- Web/native and independently built Bot runtimes use 2.0.24. Native transforms,
  PTY integrity checks, generated route policy and version fixtures were updated.
  The unsupported native token-sharing enrollment method is filtered.
- Every dedicated ChatGPT enrollment route requires direct-local access before
  parsing enrollment bodies or doing credential work. Attempts expire from
  creation and release listeners on terminal outcomes. Authentication survives
  catalog discovery failure, with global/project retry and partial-publication
  recovery available in the UI.
- Configuration import checkpoints its scope, fetches only current avatar
  metadata/blobs, preserves local data and immutable resource references, and
  keeps imported Bots, routines and integrations inactive pending local setup.
  Activation checks required local resources and credentials.
- About shows local Bot hosting mode and Docker status. Admitted managed-account
  tunnels can reach normal account authentication in background-service mode;
  transport admission does not grant account or Bot permissions.
- Cross-release credential projection is limited to the reviewed 2.0.20/2.0.24
  artifact/schema identities. Each retained artifact uses its own controller.

## Artifact identity

| Artifact | Evidence |
| --- | --- |
| Native candidate | `.cache/opencode-upgrade/2.0.24/recovery-darwin-arm64` |
| Retained baseline | `.cache/opencode-upgrade/2.0.20/darwin-arm64` |
| Native build ID | `d1a8580f0324c48419e97af1359bd031295e86ae14a86ce400042623e990ae4a` |
| Native manifest SHA-256 | `aae202cd2d0178aa1f8cfecf4cf50689198e3d542aa96452245220ccf112e890` |
| Packaged Electron | `.cache/qa/packaged-electron-NblmaT/package-evidence.json` |
| Bot image | `devryan/bot-opencode:task-upgrade-2.0.24-structured` |
| Bot image digest | `sha256:06043c3ca59c26644dcedc6a54677086cf150c3c52278aef5ae01bc86ace5d72` |

The native artifact inside the packaged application was independently verified
against the identity above. This is an unsigned, isolated QA application, not a
signed release. Evidence paths are relative to the repository; local cache files
are retained evidence and are not committed release assets.

## Completed checks

- `DEVRYAN_SCRIPT_TEST_CONCURRENCY=1 bun run validate:full` passed with exit 0,
  including workspace lint/types and deterministic tests: 6,483 web tests in
  529 files, 4,056 UI tests in 588 files, and the remaining workspace suites.
  Evidence: `.cache/opencode-upgrade/validate-full-current.log`.
- Compiled native acceptance passed all 84 cases using the actual retained
  2.0.20 baseline and rebuilt 2.0.24 candidate. No mandatory gates remained;
  source identity was unchanged and cleanup had no failures. Coverage includes
  credential reconciliation on rollback, retained candidate work, restored
  native lifecycle, compaction, local tools, API-key image account switching,
  SIWC image refusal and image cancellation without publication. Provider
  transport was captured by isolated fixtures. Evidence:
  `.cache/v2-validation/package-tjdvUn/result.json`.
  All three durable journals passed gap verification (1,084 candidate, 13
  baseline and 112 parent-death records; zero gaps/open chunks). All 18 recorded
  owned PIDs were absent after cleanup. Rollback projected the latest candidate
  credential snapshot into the restored 2.0.20 target, refused a stale baseline,
  preserved candidate history/configuration and replayed no prompts.
- Web build and startup bundle check passed. Entry bundle: 4,881,555 raw bytes
  against 4,962,877 allowed; 1,439,072 gzip bytes against 1,456,388 allowed.
- Electron packaging passed, including packaged SQLite and PTY checks.
- Packaged direct runtime service passed two startup/shutdown cycles with a
  fresh native owner each time and HTTP 401 for unauthenticated loopback
  handshake/bootstrap. No owned processes remained. Evidence:
  `.cache/opencode-upgrade/packaged-service.log` and
  `.cache/qa/packaged-service-NT0sGH`.
- Native production-host factory diagnostic passed all three synthetic cases:
  source credential mutation, nine-agent migration, and actual isolated host
  readiness. Its journal contained two records and zero gaps. Evidence:
  `.cache/v2-validation/native-factory-1GiCDC/result.json`.
- The baked Bot image passed offline OAuth transport acceptance: 11 text or
  structured requests, three refreshes, attachments, cancellation, restart and
  events. SIWC image requests were refused before network/publication.
  Evidence: `.cache/opencode-upgrade/2.0.24/bot-offline-oauth.log`.
- Disposable Docker catalog tests passed six local cases and five cloud-import
  cases, including source drift, checkpoint/resume, full-import compatibility,
  conflicts and configuration-only preservation. No test containers remained.

## Import counts and transfer scope

The source fixture held two Bots, two current avatars and two private objects.
The local fixture held one Bot with history, one avatar and one private object.
After configuration import there were three Bots and four encrypted objects:
the two preserved local objects plus the two imported avatars. Exactly two
remote blob requests occurred, both for current avatars. No history-table
requests or unfiltered object-table scans occurred. Local messages were unchanged;
the imported Bots had no channels, runs or audit events.

The final isolated configuration case passed with **12,750 downloaded response
bytes** across schema, table metadata and avatar bodies, two imported Bots and
exactly two avatar downloads. This total is not just the avatar payload size.
Evidence: `.cache/opencode-upgrade/config-transfer-final.log` (one case,
29 assertions, 64.10 seconds). The UI and checkpoint expose `downloadedBytes`.
No actual source operation has run, so no production Bot or avatar has been
transferred. Earlier Docker suite details:
`.cache/opencode-upgrade/config-import-verification.md`.

## Native performance comparison

All 42 launches completed: seven scenarios, three fresh launches per version,
3,600 measured operations plus six idle windows. The order was baseline/candidate,
candidate/baseline, baseline/candidate. Configuration fingerprints match after
excluding the deliberately changed runtime version; the host source digest stayed
`cb94b46a54be5bbf9cce711de93608f8532ec1c2d58732dac6f093d82b921f5c`.
All launches passed source-integrity and process-cleanup checks.

Values below are medians across launches, **2.0.20 → 2.0.24**. CPU covers the
isolated Node host/collector; RSS covers its owned process tree. Provider traffic
uses the same loopback fixture. These are descriptive measurements, not a
calibrated statistical nonregression certification.

| Scenario | Preparation, seconds | Runtime ready, seconds | Operation p50, ms | Host CPU, seconds | Peak RSS, MiB |
| --- | --- | --- | --- | --- | --- |
| Idle | 6.46 → 6.77 | 3.32 → 3.45 | — | 1.03 → 0.95 | 900 → 595 |
| One stream | 6.41 → 6.06 | 3.46 → 3.10 | 467 → 461 | 9.84 → 9.71 | 1,114 → 1,213 |
| Four streams | 5.96 → 5.89 | 3.14 → 3.24 | 696 → 680 | 8.66 → 8.81 | 1,517 → 1,479 |
| Long history | 5.96 → 6.04 | 3.13 → 3.14 | 511 → 480 | 11.18 → 10.40 | 877 → 964 |
| Tools, 1,000 files | 5.90 → 6.03 | 3.12 → 3.14 | 1,262 → 1,264 | 34.14 → 38.05 | 1,111 → 1,236 |
| Tools, 12,000 files | 10.66 → 10.49 | 3.14 → 3.13 | 1,273 → 1,288 | 36.32 → 35.56 | 1,340 → 1,303 |
| Eight-call bursts | 5.99 → 6.09 | 3.09 → 3.09 | 14,815 → 14,394 | 939.59 → 923.63 | 2,361 → 2,292 |

No preparation, startup, operation-latency or CPU increase above 10% occurred in
two paired launches. The 1,000-file host-CPU median increased 11.4%, but paired
changes were −10.2%, +2.8% and +11.4%. Its peak-RSS median increased 11.3%; paired
changes were +31.1%, +11.3% and −2.3%. Investigation isolated the increase to the
Node host: native-process peak RSS was lower in every pair, and event counts
were identical in the second and third pairs. A supplemental GC-traced pair
completed another 100 operations per version with clean shutdown. Peak tree RSS
was 796.9 → 803.4 MiB (+0.8%), while native-process peak RSS was 485.9 → 477.7 MiB.
Median host heap after major collection was 188.55 → 189.30 MB (+0.4%); maximum
post-collection heap was 198.5 → 196.3 MB. This additional pair did not reproduce
the >10% tree-RSS increase or show increased retained JavaScript heap. It supports
allocation/collection timing as an explanation for the variable host RSS, but
does not establish a general memory guarantee. GC tracing adds overhead, so its
timings are not mixed into the primary comparison. Evidence:
`.cache/opencode-upgrade/performance-memory/summary.json` and per-arm `gc.log`.

The harness's `settledTreeRssMiB` is actually the immediate final sample, with
no idle settling window. Four-stream and long-history final-RSS medians rose
45.4% and 15.7%, respectively, but only one paired launch in each scenario
exceeded 10%. Those values do not establish a retained-memory regression.
Terminal-event timing is unavailable in 24 runs because exact SSE attribution
did not cover every completion; missing values were not treated as zero.

This was a shared workstation. Another chat reported concurrent local validation
during the first set, and both releases became substantially faster in later
sets. The evidence therefore cannot establish tightly controlled performance
equivalence or live-provider latency. No transport or caching change was made
on these measurements. Evidence: `.cache/opencode-upgrade/performance/result.json`,
`arm-baseline.json`, `arm-candidate.json`, and `comparison-descriptive.json` in
that directory.

## Packaged Electron responsiveness

The existing resource-benchmark command failed before application launch because
its fixture setup did not supply the now-required native artifact root. That
attempt remains failed evidence at
`.cache/opencode-upgrade/electron-performance.log`.

A disposable runner reused the existing native-profile, packaged-host,
wire-facade and interactive-workload helpers with the shipped 2.0.24 artifact.
The full workload reached 98 measured actions: typing during background
streaming, complete 360-message pagination, history anchors, session switching,
draft restoration and scrolling. It then failed its disclosure idle wait:
the legacy helper requires an explicit idle entry, while the v2 status contract
omits idle sessions. The fixture had no active prompts or executing sessions;
the journal had 13 records, zero gaps and zero errors. Renderer console errors
were zero, and owned cleanup completed. This is a failed full-workload check,
not a full responsiveness pass. Earlier setup/observer failures are preserved.
Evidence: `.cache/opencode-upgrade/electron-native-wire/FULL-WORKLOAD-LIMITATION.md`
and `attempt-5/run-1/run-evidence.json` in that directory.

Three fresh trials of the existing focused typing-during-streaming protocol
passed separately: 60 trusted input events per trial, 180 total. Every trial
preserved the exact unsent draft and selected session while another session's
stream advanced. Median per-run render-ready p50 was **24.2 ms** and p95 was
**29.0 ms** (per-run p95: 29.0, 29.0, 29.3 ms). No long tasks were observed during
the measured probe. This measures the exact draft value plus two animation
frames, not compositor presentation or exact input-to-paint latency.

All nine before/during/after screenshots were visually reviewed; the draft and
layout remained intact. Each journal had 18 records, zero gaps and zero error
records. Package/web/native identities remained unchanged and each owned
profile/process tree closed completely. Evidence:
`.cache/opencode-upgrade/electron-native-wire/summary.json` and
`typing-trials/run-{1,2,3}` in that directory.

Startup 503 and bootstrap errors were retained in browser diagnostics. The
focused facade workload passing does not qualify the native first document.
The three trials retained 74/75/74 browser observations: cold-start console and
local-host resource 503s, two facade WebSocket 502s per trial, and four optional
profile/project 400/404s per trial. Their recorded timestamps ended during the
five-second warm-up, before measured typing. Details and origin/time attribution
are preserved in `error-attribution.json` and `TYPING-RESULTS.md` beside the
summary; these errors were not discarded or treated as successful startup.
These renderer checks also exclude local Electron IPC, navigation/retention
performance and live-provider behavior; there is no old/new renderer comparison.

## Attended sign-in follow-up — October 8, 2026

The first Edge error used a stopped verification server on port 54798. Opening
the healthy isolated server on port 60298 restored the UI. An in-app-browser
attempt separately failed on OpenAI's login page and expired without enrollment.

An attended Edge consent attempt reached DevRyan's completion endpoint, which
returned HTTP 409 with `native_chatgpt_siwc_refused`. The connection remained
absent, with zero registrations and no journal gaps. The response is recorded
in `.cache/opencode-upgrade/live-provider/edge-completion-failure.json`.

A synthetic reproduction exposed `DataCloneError` before credential mutation:
the native authorization boundary tried to structured-clone the SIWC
`assertCurrent` callback. It now validates and retains that original private
callback while deep-cloning the request data. All 62 focused authorization,
integration-owner, facade and enrollment checks passed, including stale-callback
refusal for credential creation, activation and removal.

The rebuilt verification server progressed past that boundary. Its next attended
consent attempt saved and selected the credential, but completion returned HTTP
503 with `native_chatgpt_siwc_cleanup_failed`. One staged registration remained;
the provider catalog returned 72 models. No inference was attempted. The journal
had 22 records and zero gaps. Evidence is retained in
`.cache/opencode-upgrade/live-provider/edge-post-fix-completion.json`.

An isolated test of the installed SDK reproduced the second cause:
`Credential.create` selects the first credential even when `activate:false`.
Enrollment now recognizes only its exact newly saved first credential, verifies
its identity and fingerprint, and retains native selection and caller checks.
An active staged credential survives later failures and can be finalized by the
existing account-selection path. Switching to another account still prevents
that recovery. Healthy UI shows the account list; an unhealthy connection shows
one error and Reconnect, without duplicate success or recovery paragraphs.

Independent review also caught an initial-registration publication failure:
the SDK could select a credential before its recovery reference reached disk.
Enrollment now publishes the registration with an explicit SDK-supported
credential ID before creation. An initial write failure creates no tokens;
an uncertain create receipt retains that exact recovery target.
The final focused checks passed 79 web tests and five installed-SDK tests;
independent review found no remaining concrete issue. Fresh web type checks
and focused lint also passed.

The full validation invocation stopped at a timing-sensitive Bot UI test
(`unmount cancels scheduled catalog retries`: two calls instead of one during
concurrent packaging). The subsequent complete UI rerun passed all 4,056 tests;
the original failed result remains in `siwc-fix-validation.log` and the rerun in
`siwc-ui-full-retry.log`, both under `.cache/opencode-upgrade`.
The remaining full web suite then passed: 529 Vitest files / 6,502 tests and
14 Bun native-host tests. The final build, bundle check and documentation check
passed. The rebuilt local QA package is
`.cache/qa/packaged-electron-6d3U4A/package-evidence.json`; its source identity is
`d4d3cfcd1d1b3c9a99e2598c3f2525a5afc4dbf743eb1849b75a969b96ecc332`.
Packaged enrollment, host and facade hashes match the final source. This is
unsigned local QA evidence, not signed release evidence.

The failed attended attempt's grant was disconnected through the normal local
SIWC endpoint: HTTP 200, remote revocation confirmed, local cleanup complete,
no selected credential and no staged cleanup entries. Evidence is retained in
`.cache/opencode-upgrade/live-provider/second-attempt-disconnect.json`.

The second fix and UI cleanup require another rebuilt verification process and
attended sign-in. Earlier package and renderer results do not qualify them.

## Pending acceptance

- Native first-document packaged startup and the full interactive benchmark
  remain unqualified; only the focused facade typing workload passed.
- Attended local-web and packaged-Electron ChatGPT enrollment; real selected
  model/effort text, tools, title, compaction, account-switch and restart checks.
- Explicit API-key image generation and reference editing against the live
  provider. Synthetic transport tests do not establish provider acceptance.
- Cold/warm live prompt preparation, provider-first-byte, visible-output and
  completion timings; provider latency is not inferred from loopback fixtures.
- Actual configuration/avatar import requires the verified source owner and
  matching deployment encryption identity. The source has not been modified.
- Live remote-member Bot streaming, account revocation/expiry, tunnel reconnect,
  Docker outage, launchd registration and physical host reboot remain unverified.

Earlier failed attempts remain failed evidence. Generated-chunk fixture failures
and narrow version-composition/recovery gates were corrected before reruns.
The native factory diagnostic must run with Node; its Bun attempt failed during
profile preparation and is not a qualified invocation. None of these checks
used the installed application's credentials or data.
