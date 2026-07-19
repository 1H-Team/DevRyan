# DevRyan Reliability Pass Audit Ledger

## Scope And Evidence Rules

This ledger records the incremental audit and stabilization work defined in
`docs/superpowers/specs/2026-07-10-devryan-full-audit-reliability-design.md`.
Measurements are recorded before implementation and repeated with the same
method where a material optimization is claimed.

Product work is limited to `/Users/zoubair/Repositories/DevRyan`. The external
fixture is the separately initialized Git repository at
`/Users/zoubair/Repositories/Test`. No forbidden OpenChamber checkout or local
OpenCode source repository is consulted. Provider credentials, usage payloads,
prompt transcripts, and response content are excluded from this document and
from fixtures.

Results use only `pass`, `fail`, `blocked`, or `not exposed`:

- `pass`: observed behavior met the stated acceptance criteria;
- `fail`: observed behavior violated the criteria;
- `blocked`: the scenario could not be run safely or authoritatively;
- `not exposed`: the provider/runtime did not expose the requested native
  capability.

## Initial Repository State

- Baseline commit before audit design: `fc716bea` (`release v1.0.7`).
- Approved design commit: `42d0ae7f`.
- Stabilization-plan commit: `2731bb83`.
- Implementation branch: `codex/devryan-reliability` in the ignored linked
  worktree `/Users/zoubair/Repositories/DevRyan/.worktrees/devryan-reliability`.
- Four pre-existing sync abort-guard edits were present in the primary checkout
  before implementation. They remain user-owned and are isolated for their own
  verification task.
- No third-party dependency was added. The linked worktree required a forced locked Bun
  install to materialize workspace dependency links because it is nested below
  the primary monorepo. The existing `better-sqlite3` dependency was upgraded
  from the 11.x to the 12.x release line after Electron packaging proved that
  11.10.0 cannot compile against Electron 41's V8 API. A frozen Bun install and
  Electron 41 rebuild now pass.

## Baseline Validation And Build

| Check | Result | Wall time | Peak RSS | Notes |
| --- | --- | ---: | ---: | --- |
| `bun run validate:full` | pass | 77.41 s | 1,378,156,544 bytes | Primary checkout, before product edits |
| `bun run build` | pass | 42.84 s | 2,152,890,368 bytes | Primary checkout, before product edits |
| Isolated worktree lint | pass | not separately timed | not measured | All workspaces |
| Isolated worktree type-check | pass | not separately timed | not measured | All workspaces |
| Isolated worktree UI tests | pass | 3.77 s aggregate runner phase | not measured | 1,361 tests, 194 files |
| Isolated worktree web tests | pass | 27.01 s | not measured | 686 tests, 84 files |
| Isolated worktree VS Code tests | pass | 0.574 s Vitest phase | not measured | 43 tests, 10 files |
| Isolated worktree VS Code quota tests | pass | 0.151 s | not measured | 9 tests |

The initial primary-checkout full validation also passed eight script tests,
1,363 UI tests, 686 web tests, 43 VS Code Vitest tests, and nine VS Code quota
tests. The two-test difference in the isolated UI aggregate reflects the clean
worktree not containing the two extra pre-existing abort-guard assertions.

## Baseline Build Leads

The full build passed but reported large generated chunks. The largest observed
web vendor chunk was approximately 17.2 MB minified and 4.0 MB gzip. Other
large outputs included approximately 2.84 MB for model preference autosave,
1.65 MB for the main web bundle, and 4.55 MB for the VS Code renderer. These are
investigation leads, not confirmed user-visible defects; no bundle split will
be changed without load/runtime evidence.

## Packaged Desktop Process And Resource Baseline

The observed packaged v1.0.7 topology remained at ten processes:

- one Electron main process;
- one renderer;
- Chromium GPU, network, audio, and video helpers;
- one managed OpenCode process; and
- stable Railway and Resend MCP children owned by OpenCode.

There was no evidence that each retry created another process.

During a deterministic `Model not found` retry loop, aggregate RSS grew from
approximately 804–805 MiB to approximately 1,209 MiB while the UI reached retry
attempt 10. Later process footprints were:

| Process | Physical footprint | Observed peak |
| --- | ---: | ---: |
| Electron main | 148.7 MiB | 227.6 MiB |
| Electron renderer | 311.3 MiB | 436.0 MiB |
| OpenCode | 472.8 MiB | 675.6 MiB |

At the later sample the renderer used roughly 37% CPU and the GPU helper roughly
17% CPU. The app was actively rendering a retry countdown and animations, so
this proves a costly deterministic failure path but does not prove an idle
memory leak. Leak status remains unconfirmed until controlled repeated runs
show monotonic retained growth after settlement.

## Streaming Baseline

Production ordering, coalescing, resume, and responsiveness tests passed. The
existing benchmark is not a valid performance baseline because it waits a
fixed time rather than awaiting async replay completion. Observed false-loss
examples included only 52 of 500 input delta bytes in a small run and 5,936 of
50,000 bytes in a stress run. Production streaming is not classified as lossy
from this benchmark. Task 2 repairs measurement before production optimization.

| Metric | Before repair | After repair |
| --- | ---: | ---: |
| Input events | not authoritatively recorded | 503 small / 50,150 stress |
| Delivered events | not authoritatively recorded | 6 small / 524 stress after coalescing |
| Input delta bytes | 500 / 50,000 example runs | 500 small / 50,000 stress |
| Delivered delta bytes | 52 / 5,936 false-loss reports | 500 small / 50,000 stress |
| Flush count / duration | not authoritative | 3 / <0.05 ms small; 334 / 0.2 ms stress |
| Wall time | not authoritative | 43.0 ms small / 883.5 ms stress |
| RSS after final flush | not recorded | 112.0 MiB small / 129.8 MiB stress |

The repaired benchmark awaits an explicit async-generator exhaustion signal,
performs a synchronous final pipeline flush through cleanup, and exits non-zero
on a byte mismatch. Its token generator uses distinct incremental code points;
the old repeated `"x"` workload also triggered the production long-frame
duplicate guard and therefore was not a valid byte-integrity payload. Existing
responsiveness counters supply flush count, maximum batch, and total handler
time without modifying production batching behavior.

## Configured Provider Baseline

The running instance reported these quota adapters as configured, without
fetching or logging usage data:

- Claude;
- ChatGPT/Codex;
- Cursor;
- GitHub Copilot and its add-on; and
- OpenCode Go.

The harness preflight returned eight warnings: five packaged-agent
skill-announcement-policy warnings and three duplicate skill-name warnings. A
failed-model turn had no runtime tool manifest because it never reached normal
tool initialization. That missing manifest is not classified as a normal-turn
defect.

## Prioritized Confirmed Findings

| Priority | Finding | Initial result | Evidence |
| --- | --- | --- | --- |
| P0 | Deterministic missing-model errors retry indefinitely | fail | Packaged v1.0.7 reached attempt 10 |
| P0 | Displayed session can receive a green completion dot | fail | Production-path test explicitly expected it |
| P0 | Multi-question option has multiple interaction owners and partial retry can resend acknowledged requests | fail | Nested row/control handlers and no acknowledged-request set |
| P0 | Usage refresh lacks the required single 30-minute coordinator | fail | Disabled by default, component timers, no dedupe/filter, valid data overwritten on transient failure |
| P1 | GitHub Copilot rejects the configured DevRyan tool manifest | fail | Live Builder and Orchestrator sends exposed 138 and 139 tools; provider limit is 128 |
| P1 | The original Copilot tool cap misses OpenCode-qualified MCP names after bundled plugins are enabled | fail | With `resend_*` alone, a live managed parent still sent 196 tools; the runtime exposes Resend as `mcp__resend__*` |
| P1 | Managed OpenCode `--pure` launch mode suppresses bundled DevRyan tools | fail | Live tool discovery exposed neither `devryan_task` nor `council_session`; OpenCode skips configured plugin origins in pure mode |
| P1 | Managed OpenCode inherits an ambient default-plugin disable flag | fail | With `OPENCODE_DISABLE_DEFAULT_PLUGINS=true`, the web lifecycle passed the value unchanged to its managed child, suppressing the same bundled tool origins |
| P1 | Copilot all-false picker fallback exposes unsupported account models | fail | GPT-5.3 Codex, GPT-5.4 mini, and Kimi were listed but each live request returned `The requested model is not supported` |
| P1 | Directory eviction leaves directory-owned metadata/caches | fail | Disposal clears only a bootstrap flag at the integration seam |
| P1 | Cursor persistent Agent cache is unbounded | fail | Worker `Map` survives until process shutdown |
| P1 | Cursor write-like tools can expand to an empty body | fail | Output-only fallback returns no renderable detail |
| P1 | Streaming benchmark can report false byte loss | fail | Fixed wait completes before async replay |
| P1 | Retry-path memory grows materially | fail | Resource growth confirmed; leak classification pending |
| P1 | HMR shutdown can orphan its managed OpenCode child | fail | After Ctrl-C stopped the HMR/API wrapper tree, OpenCode PID 37771 remained alive with PPID 1 until explicitly terminated |
| P1 | A long-lived HMR shutdown can retain the listener-less Bun API parent | fail | A 28-minute source run cleared its UI/API/OpenCode listeners and children but left the Bun server alive under PPID 1 at 67.6 MiB RSS |
| P1 | Affected and full validation ignore Cursor runtime production changes | fail | `bun run validate:affected` selected `Commands: none` for eight changed Cursor runtime files, and root `test:full` omitted the package's 89 tests |
| P1 | Electron packaging can succeed without a loadable `better-sqlite3` binding | fail | The release artifact contained only `test_extension.node`; the workspace-only dependency was silently skipped by the root rebuild |
| P1 | Electron package tests are absent from affected and full validation | fail | Nine existing Electron test files were not invoked by any package/root test script |
| P1 | Normal Electron quit can retain a destroyed BrowserWindow in a queued settings mutation | fail | Packaged runtime emitted two unhandled `Object has been destroyed` rejections after menu quit |
| P1 | Loaded packaged Electron can exit before managed OpenCode cleanup settles | fail | Final packaged Cmd-Q removed main plus five helpers but left its exact OpenCode child under PPID 1 at 878.0 MiB RSS with three listeners; SIGTERM did not reap it |
| P1 | New managed-runtime workspace dependencies are absent from the resolved lock | fail | Final host-ABI restoration added the missing UI, VS Code, and web `@openchamber/orchestration-runtime` workspace edges to `bun.lock` |
| P1 | Supertest can connect to an unrelated IPv4 service instead of its IPv6 test server | fail | Node selected an IPv6 ephemeral port already used by an unrelated IPv4 listener while Supertest hard-coded `127.0.0.1`; a dependency-only 10,000-request reproduction returned the unrelated response |
| P2 | Some event/recovery caches lack explicit directory release or byte bounds | fail | Ownership gaps confirmed; material impact still to be measured |
| P2 | DevRyan-managed scheduler is absent | fail | New required capability, not an existing regression |

## Stabilization Change Log

| Workstream | Change | Focused tests | Affected validation | Runtime evidence | Result |
| --- | --- | --- | --- | --- | --- |
| Measurement fixture | External Test Git fixture initialized at commit `6baa1e6`; two dependency-free tests pass | `node --test src/math.test.ts` | not applicable | Clean initial fixture | pass |
| Streaming benchmark | Explicit replay barrier, valid incremental tokens, hard byte assertion, flush/RSS metrics | 28 event-pipeline tests pass, including new CLI regression | `bun run validate:affected` passes; 1,362 UI tests | 50,000/50,000 stress bytes, 334 flushes, 883.5 ms, 129.8 MiB RSS | pass |
| Fatal retry guard | Deterministic model-resolution retry classifier registers the existing bounded abort guard at the sync event boundary; transient retries remain authoritative | 88 focused guard/sync/reducer/classifier tests pass | `bun run validate:affected` passes; 1,366 UI tests | Usage retry remained active through attempt 5; nonexistent direct model surfaced terminal error and idle; fatal retry status not exposed in this run | pass |
| Question cards | One native interaction owner per option; stable session/request/question keys; acknowledged groups filtered from retries; session-scoped in-flight lock; visible failure retention; cross-session request grouping fixed | 13 new focused tests pass; existing navigation/options suites remain green | `bun run validate:affected` passes; 1,377 UI tests | One- and two-question cards, pointer and keyboard selection, reload, background session persistence, double-click, offline failure, and successful retry pass; simultaneous request groups not exposed by provider | pass |
| Session indicators | Active-session completion scheduling removed; green now requires settled plus unread background state; read cleanup covers descendants; compact completion read state excludes provider content; green/yellow restore from narrowed authoritative snapshots; root error lookup is row-scoped | 141 focused lifecycle/store/sidebar tests pass | `bun run validate:affected` passes; 1,382 UI tests | Active completion stayed clear; background completion stayed green across full reload and cleared durably on open; blue question persisted across reload/switch; yellow plan persisted in active/background sessions and restored after full reload | pass |
| Quota coordinator | One app-level owner; 30-minute baseline plus optional faster cadence; configured-provider discovery; serialized cycles; per-provider deduplication; last-valid-data retention and stale/error metadata; auth-triggered rediscovery | 14 new coordinator/store/ownership/presentation tests pass | `bun run validate:affected` passes; 1,396 UI tests | Reload produced one discovery plus one request for each of five configured visible adapters; rapid double-click produced one five-provider forced cycle; offline ChatGPT refresh retained visible data and showed failure state; online retry cleared it | pass |
| Directory/cache lifecycle | One child-store release boundary for eviction and shutdown; explicit release for prefetch, materialization, pending deltas, child fetches, event queues, routing, action/ref state, timers, abort/toast/activity records; late-completion guards; Strict Mode-safe provider teardown | 134 focused tests across 11 lifecycle/action files pass; 19 net new UI assertions | `bun run validate:affected` passes; 1,414 UI tests plus UI/web/VS Code type-check and UI lint | Clean full reload passed after two live Strict Mode startup races were reproduced and fixed; 50 repeated Test-project session switches held DOM count at 6,773 and post-GC heap at 162.9 MiB | pass |
| HMR/OpenCode shutdown | Detached-tree waits follow the process group after a wrapper leader exits; HMR uses the shared shutdown primitive; direct dev CLI startup keeps server signal cleanup attached | 9 script tests and the new CLI-entry regression pass; full web suite is 687/687 | full validation selected by `validate:affected`: workspace lint/type-check, 1,414 UI, 687 web, and 52 VS Code tests pass | Before: Ctrl+C left managed OpenCode under PPID 1 on two reproduced runs. After: all seven owned PIDs and UI/API/OpenCode ports cleared | pass |
| Cursor Agent cache | Dependency-free 16-entry access-order LRU with 30-minute idle TTL; active-run overflow protection; session-release protocol; provider `close()` on eviction/shutdown; affected/full validation now include Cursor plus host dependents | 7 cache-policy tests, 30 focused worker/streaming tests, all 89 Cursor package tests, and 3 validation-policy tests pass | full gate passes: workspace lint/type-check, 12 script, 89 Cursor, 1,414 UI, 687 web, and 52 VS Code tests; 58 focused web Cursor-runtime tests pass | 20/20 real Test-project session prewarms used one worker; RSS 101.3 MiB at 10, 108.2 MiB at 20, then 59.5 MiB after 20/20 deletes; no fixture changes | pass |
| Provider-native details/recovery | Explicit terminal status preservation; output-only expansion fallback; terminal no-details state; provider failure/status shown alongside retained output; failed/cancelled native task output labelled partial; abort stops cancel-tail consumption | 10 expansion-selector, 22 task-presentation, 3 SDK normalization, and 2 native task failure/abort lifecycle tests pass; all Cursor package tests pass | `bun run validate:affected` passes with UI/web/VS Code type-check, UI lint, Cursor/UI/web suites | Cursor Builder wrote one Test-project file through a native patch call; its expanded row showed the concrete file and `+1`; probe file/session were removed, Test remained clean, and HMR/API/OpenCode ports returned to zero listeners | pass |
| Copilot prompt tool compatibility | One shared provider policy is used by normal UI prompts and DevRyan-managed child prompts; it disables both `resend_*` and `mcp__resend__*` only for GitHub Copilot aliases | 5 resolver tests, 6 managed-executor tests, 3 web transport tests, and all 21 OpenCode client-send tests pass, including isolation for other providers | package-focused type-check/tests pass; affected validation repeated below | Before the second name was covered, a live request still failed at 196 tools. Afterward, a Copilot Orchestrator invoked `devryan_task`, its Copilot child completed, and core/Railway tools remained available | pass |
| Copilot model discovery | Modern all-false picker payloads retain only API-returned GitHub utility models; picker-enabled paid-account rows still win; legacy payload compatibility remains; emergency fallback changes from unverified GPT-5.1 Codex to GPT-4.1 | 5 bundled-plugin and 7 server discovery tests pass | `bun run validate:affected` passes with web lint/type-check and 688 web tests | Before: three newer listed models failed live. After restart: provider API and visible menu contain only GPT-4.1, GPT-4o, and GPT-4o mini; all three completed live probes | pass |
| Bounded watched-server shutdown | Watched server entrypoints exit after cleanup; a four-second outer bound prevents a hung provider close from blocking HTTP cleanup and process exit | 1 CLI-entry and 3 shutdown-runtime tests pass, including a never-resolving provider close | `bun run validate:affected` passes with web lint/type-check and 688 web tests | Before: listener-less Bun PID 14228 remained under PPID 1. After: the same Ctrl-C path cleared all ten exact owned PIDs and UI/API/OpenCode ports within six seconds | pass |
| Electron package/lifecycle gate | Pin Electron version; resolve and rebuild workspace/transitive native modules explicitly; upgrade `better-sqlite3`; reject packages missing required bindings/ripgrep; include Electron tests in affected/full gates; snapshot window state before asynchronous persistence | 6 native-path/artifact tests and 2 window-state lifecycle tests pass; complete Electron suite is 37/37 | Full gate passes: workspace lint/type-check, 14 script, 94 Cursor, 37 Electron, 1,429 UI, 687 web, and 52 VS Code tests | ARM64 package contains all four required native assets and passes deep code-sign verification; x64 and ARM64 rebuilds emit matching architectures; isolated packaged app serves HTTP 200 and normal menu quit leaves no app, helper, OpenCode process, listener, or unhandled rejection | pass |
| Stabilization release gate | Freeze the verified correctness/lifecycle phase before introducing a new scheduler; no production change was made for a non-reproducible transport anomaly | Provider route file passed 50/50 repetitions after one full-gate HTTP parse error; complete web suite then passed twice at 688/688 | Final rerun passes workspace lint/type-check plus 14 script, 94 Cursor, 37 Electron, 1,432 UI, 688 web, and 52 VS Code tests (2,317 total) | Cross-runtime production build passes; exact owned source processes and UI/API/OpenCode listeners were already verified clear after Ctrl-C | pass |
| Web route-test isolation | Address-family-aware Supertest wrapper targets IPv6 loopback when Node binds IPv6 and IPv4 loopback when it binds IPv4 | Deterministic same-port IPv4/IPv6 collision regression passes; complete web suite passes at 689/689 | `bun run validate:affected` passes with 52 orchestration, 1,432 UI, 52 VS Code, and 689 web tests | 10,000 sequential helper requests completed with zero wrong responses after the dependency-only reproduction returned an unrelated local response | pass |
| Managed orchestration core + web/Electron owner | Dependency-free three-slot scheduler; separate provider-native ownership; atomic private ledger; loopback bearer RPC; canonical OpenCode/Cursor executor; scoped safe routes/events; one multiplexed orchestrator tool; Council fanout shares capacity; managed launch retains bundled plugin origins; durable compaction now emits identity-only removal events | 64 core tests and 72 focused web owner/lifecycle/plugin tests pass | expanded affected gates pass with 64 orchestration, 1,465 UI, 59 VS Code plus 9 quota, and 715 web tests plus UI/web/VS Code lint and type-check; 37 Electron tests and the prior cross-runtime production build pass | Live Copilot parent/child completed; five live starts produced exactly three running/two queued; cancelling sequence 5 admitted sequence 8 before 9; targeted abort preserved a partial resumable envelope; restart restored nine terminal records without replay; all listeners cleared | pass |
| Managed plugin launch environment | The web owner now removes inherited `OPENCODE_DISABLE_DEFAULT_PLUGINS` from the managed child environment, matching the no-`--pure` bundled-plugin contract and VS Code owner behavior | The focused lifecycle suite reproduces the leak before the change and passes 29/29 afterward | affected validation passes web lint/type-check and all 715 web tests | A real source launch with the hostile ambient flag exposed 290 tools, including `devryan_task`, `council_session`, and provider-native `task`; Ctrl+C cleared UI, API, and allocated OpenCode listeners | pass |
| VS Code managed orchestration owner | One extension-host scheduler and private ledger/loopback bridge; normal and Cursor executor parity; validated launch-only bridge environment; scoped webview routes/events, including compaction removal; managed owner shuts down before OpenCode; external runtimes remain unavailable | 18 focused launch/runtime/bridge/webview tests pass, including three-of-five admission, ledger quarantine warning, prompt fidelity, route error propagation, private-host release, and event forwarding | complete VS Code gate passes with 59 Vitest and 9 quota tests, type-check, lint, extension bundle, and production webview build | The real loopback host accepted only its bearer token and released its listener; five scheduler submissions admitted exactly three and queued two. A live Extension Development Host/provider repeat remains part of the final UI/runtime gate | pass |
| Shared managed-task projection and recovery UI | Non-persisted safe-projection store outside the hot session sync path; all-or-nothing single-batch snapshot reconciliation; generation-safe reconnect/reset handling; duplicate-safe authoritative actions; exact compaction removal; root/task leaf selectors; distinct bounded dispatch strip with partial/failure state and child navigation | 47 focused API/store/routing/presentation/forwarding tests pass, including stale snapshot, malformed snapshot, immutable execution metadata, reset/removal races, retry idempotency, action visibility, and provider-native separation | expanded affected validation passes UI/web/VS Code lint and type-check plus the complete 1,465-test UI, 59-test VS Code, and 715-test web suites | Initial rendering is capped at 24 task rows. A live Copilot parent showed the distinct dispatch strip and child link; an empty completed child now rendered `Failed`, retained one reference, exposed continue/resume/retry/abandon, created a labelled attempt-2 retry, and restored the complete recovery state after reload with no browser errors | pass |
| Electron awaited owned-resource quit | Normal quit now retains one idempotent server-stop promise and awaits web/OpenCode plus SSH cleanup before `app.quit()`; duplicate quit attempts stay blocked during cleanup; a ten-second outer bound remains for genuinely hung native handles | 3 focused ordering/failure/timeout tests pass; complete Electron suite passes 40/40 | affected validation passes Electron syntax checks and all 40 tests; final full 2,463-test gate passes | Before: exact OpenCode PID 28568 survived under PPID 1 at 878.0 MiB and resisted SIGTERM. After rebuilding, all seven exact PIDs and every main/private/OpenCode listener were gone by the first post-quit sample | pass |
| Workspace dependency/native handoff | Reconciled all three managed-runtime workspace edges into `bun.lock`; after Electron packaging, restored the shared tree to the host Node ABI | Native load probe opens in-memory `better-sqlite3` and loads `node-pty` plus Cursor `sqlite3` | frozen-lock install reports 1,534 installs checked with no changes; final full 2,463-test gate passes | `bun install --force` completed in 6.65 seconds; the feature and external Test worktrees retained only intended source/doc changes | pass |

## Provider Compatibility Matrix

| Scenario | ChatGPT/OpenAI | GitHub Copilot | Cursor | Evidence / limitation |
| --- | --- | --- | --- | --- |
| Ordinary chat | blocked | pass | pass | OpenAI usage limit blocked this run; Copilot GPT-4.1 completed in both Orchestrator and Builder; Cursor completed normally |
| Long streaming response | blocked | pass | blocked | Copilot completed a 7,217-character, 300-line response in 33.7 seconds without losing session state; other provider repeats remain blocked |
| Tool-heavy work | blocked | pass | pass | Copilot used core read and shell tools after the scoped override; Cursor completed a live patch tool call |
| Expandable tool details | blocked | pass | pass | Copilot read expansion exposed the concrete file; Cursor live patch expanded to a concrete file/+1 detail; pure coverage proves output-only aliases, error-only payloads, and explicit terminal no-details fallback |
| Provider-native subagents | blocked | blocked | not exposed live | Cursor SDK task-event contracts are covered without inventing activity, but the live prompt did not emit a native subagent task |
| DevRyan-managed subagents | blocked | pass | automated pass; live pending | OpenAI usage was blocked. Copilot exercised parent start/wait, five-way admission/FIFO, targeted abort, partial recovery, and restart. Cursor uses the existing virtual-provider owner in focused transport tests; live managed Cursor is retained as a later matrix item |
| Partial output then failure | blocked | blocked | pass | Cursor native-task test retains substantial partial summary, terminal error status, and provider reason in the parent tool record; UI labels it partial |
| Manual abort and recovery | blocked | pass | pass | A live Copilot shell turn was stopped, retained its interrupted command record, returned idle, and accepted a follow-up in 1.8 seconds; Cursor native-task coverage retains partial output, finishes cancelled, clears the active run, and proves no post-finalization event flood |
| Provider failure | pass | pass | pass | OpenAI invalid-model error was visible; Copilot surfaced unsupported-model errors and recovered on a supported model; Cursor exposed the missing question-tool limitation without inventing a card |

## User-Visible Scenario Matrix

| Scenario | Baseline | Final | Evidence / limitation |
| --- | --- | --- | --- |
| Single-question submission | pass | pass | Live single-choice submit returned 200 and removed the card; pending card restored after reload |
| Multiple-question submission | fail | pass | Live two-question single/multi-select request completed with exact answers and one reply POST |
| Partial question acknowledgement retry | fail | pass | Pure reducer and routing coverage prove fulfilled groups are excluded; simultaneous live request groups were not exposed |
| Current-session completion indicator | fail | pass | Live completion in the displayed session produced no green; sync scheduling test prevents the stale record |
| Background unread completion | pass | pass | Live background completion stayed green across full reload; selecting it synchronously cleared green and persisted the read state |
| Question indicator persistence | pass | pass | Blue remained on the background session across reload/switch and cleared after acknowledged reply |
| Plan indicator persistence | pass | pass | Active and background proposed plans remained yellow; persisted plan ownership triggered sequential authoritative restoration after full reload |
| Managed task ownership and status | absent | pass | Safe projections render in a root-scoped `DevRyan dispatch` strip with explicit DevRyan mode/status, distinct from provider-native task tool rows; live Copilot parent/child navigation and reload restoration pass |
| Managed partial-result recovery | absent | pass | Failed/aborted/interrupted envelopes retain bounded preview, failure reason, child link, and only authoritative continue/resume/retry/abandon actions. Live empty-output failure and attempt-2 retry restored after reload; duplicate actions are serialized and failed requests remain retryable |
| Initial usage load | fail | pass | Full reload produced one discovery request and one request for each of five configured visible adapters |
| 30-minute usage refresh | fail | pass | Injected-clock tests prove one baseline timer, optional faster cadence, cleanup, and stop/restart behavior |
| Transient usage refresh failure | fail | pass | Live offline ChatGPT refresh retained last valid rows with visible stale/failure state; online retry cleared the notice |
| Stream byte integrity benchmark | fail | pass | Exact at 500 and 50,000 delta bytes after explicit replay completion |
| Abort deterministic model failure | fail | not exposed | Automated retry-event path passes; current source runtime emitted terminal `session.error`, so no retry abort request was observable |
| Question duplicate-click protection | fail | pass | Browser double-click produced exactly one POST and card removal followed the 200 response |
| Question provider-error retry | fail | pass | Browser offline submit retained the selected answer/card with visible `Question reply failed`; online retry returned 200 and cleared both |
| Directory create/delete lifecycle | fail | partial | Production-boundary tests return directory-owned counts to zero and isolate unrelated directories; live source startup/reload and repeated Test-project session switching pass, but a second live Test worktree was not created solely to force LRU eviction |
| Source HMR shutdown | fail | pass | Early runs orphaned managed OpenCode; a later 28-minute run exposed a listener-less Bun API parent. The final Ctrl-C repeat cleared all ten exact owned PIDs plus UI, API, and allocated OpenCode ports within six seconds |
| Cursor expandable tool details | fail | pass | Live Cursor Builder patch expanded to `devryan-tool-details-probe.txt +1`; output-only/failure/empty fallbacks have 10 pure assertions |
| Provider-native task failure after partial output | fail | pass | Cursor runtime retains native task output and provider reason with terminal `error`; task presentation marks the result partial and keeps the failure visible |
| Provider-native task abort after partial output | fail | pass | Cursor runtime retains output with terminal `cancelled`, clears the active run, and stops consuming cancel-tail events; task presentation derives partial state from authoritative status |
| Copilot composed tool manifest | fail | pass | Before: Builder and Orchestrator reached 138/139 tools and every normal request failed; after managed plugin loading, the single-name cap still sent 196. The shared policy now disables `resend_*` and `mcp__resend__*` only for Copilot; normal and managed Orchestrator/Builder flows pass |
| Bundled managed-tool discovery | fail | pass | `--pure` exposed neither `devryan_task` nor `council_session`. Managed launch without it exposed both tools plus the distinct provider-native `task`; harness preflight reported no error findings |
| Managed three-worker admission and FIFO | fail | pass | Five live starts produced three running and two queued; cancelling sequence 5 admitted sequence 8 while sequence 9 remained queued; cleanup settled all five with zero active work |
| Managed abort with partial recovery | fail | pass | A live builder child was cancelled only after its bash tool was running; the task settled `aborted`, retained the explicit reason, `partial=true`, two canonical refs, a bounded preview, and `resumable=true` |
| Managed restart persistence | fail | pass | A private mode-0600, 34,878-byte ledger restored six aborted and three completed tasks plus nine result envelopes with zero active work and no new attempt after process restart |
| Copilot account model picker | fail | pass | All-false account payload no longer guesses that every chat row is selectable. GPT-5.3 Codex, GPT-5.4 mini, and Kimi failed and are now hidden; verified utility choices GPT-4.1, GPT-4o, and GPT-4o mini remain |
| Process cleanup after abort | blocked | pass | After the Copilot long-running shell abort and recovery, the owned source tree returned to its ten-process settled topology with no shell child; aggregate RSS was 680.4 MiB and sampled CPU 1.2% |
| Repeated-session memory plateau | blocked | pass | Fresh renderer post-GC heap: 155.7 MiB initial, 156.8 MiB after 1 cycle, 159.6 MiB after 10, and 162.9 MiB after 50; DOM nodes stayed at 6,773 and source process count stayed at 12 |
| Electron native packaging | fail | pass | Before: ARM64 `.app` omitted `better_sqlite3.node`. After: package-time gate finds ARM64 `better-sqlite3`, `node-pty`, Cursor `sqlite3`, and executable Cursor ripgrep before signing; Intel and ARM native rebuilds were both inspected with `file` |
| Packaged Electron normal quit | fail | pass | Window-state capture prevents destroyed-window rejections, and the final awaited-cleanup barrier prevents the later loaded-state OpenCode orphan. The rebuilt UI returned HTTP 200, exposed all 290 expected tools, restored managed recovery cards, and cleared all seven exact processes/listeners on Cmd-Q |

## Before/After Resource Measurements

| Measurement | Before | After | Comparable method? |
| --- | ---: | ---: | --- |
| Desktop process count at idle | 10 | not yet measured | pending |
| Desktop process count during deterministic retry | 10 | not yet measured | pending |
| Aggregate retry RSS | ~805 MiB start, ~1,209 MiB attempt 10 | not yet measured | pending |
| Renderer active-retry CPU | ~37% | not yet measured | pending |
| GPU active-retry CPU | ~17% | not yet measured | pending |
| Source-stack process count before/after provider-failure scenarios | not applicable | 8 / 8 | same source runtime and PID set |
| Source-stack RSS before/after provider-failure scenarios | ~513 MiB | ~365 MiB | same eight process PIDs; endpoint samples, not a peak |
| Source-stack process count after HMR Ctrl-C | 1 orphaned managed OpenCode child after wrapper/API/Vite exit | 0 of 7 owned processes retained | Same HMR command and Ctrl+C path; after run also cleared UI, API, and allocated OpenCode listener ports |
| Quota initial request fanout | Up to four component timer owners × all 15 visible adapters by code path | 1 discovery + 5 configured-adapter requests | before is static ownership maximum; after is live full-reload count |
| Quota rapid double-click fanout | No aggregate or provider request deduplication | 5 forced provider requests, no overlap or duplicate cycle | live Usage-page double-click after clearing the request log |
| Directory-owned retained entries after 100 synthetic cycles | 0 child stores but 100 completed prefetch entries retained | 0 child stores; prefetch cache/in-flight/revisions all 0; materializer callbacks/state/timers all 0 | Same 100-cycle dependency-free harness; after RSS 39.6 MiB is an endpoint sample, not a leak claim |
| Repeated Test-project session-switch heap | not measured | 155.7 MiB initial / 156.8 MiB at 1 / 159.6 MiB at 10 / 162.9 MiB at 50 | Fresh headless renderer, explicit V8 GC before every sample; same two sessions and stable 6,773 DOM nodes |
| Source process count during 50-cycle session run | 12 | 12 | Same owned HMR/Vite/API/OpenCode/MCP/Cursor-worker process tree; no process was created by switching |
| Source stack after Copilot long/tool/abort/recovery matrix | not measured before this matrix | 10 processes / 680.4 MiB aggregate RSS / 1.2% sampled CPU | Post-settlement endpoint sample; includes one Test-directory Railway/Resend MCP group and no retained shell child, so it is lifecycle evidence rather than a before/after optimization claim |
| Managed web/OpenCode owner after nine live task lifecycles | not applicable | 2 owner processes; 71.4 MiB web + 200.2 MiB OpenCode RSS at settled pre-restart sample | Exact listener owners only; configured MCP subprocesses were not enumerated by command line. The immediate post-restart OpenCode sample was transiently 403.8 MiB, so no memory-reduction claim is made |
| Managed owner shutdown after abort/restart | not applicable | 0 web/OpenCode listeners retained | Exact web and allocated OpenCode ports cleared after each SIGINT; private bridge shutdown is also covered by owner diagnostics tests |
| Managed UI snapshot notifications for 50 restored tasks | 53 store notifications (loading + one update per task + settled) | 3 store notifications (loading + one atomic reconciliation + settled) | Same focused production-store fixture; task contents and final 50-record projection are identical |
| Long-lived HMR API-parent shutdown | One listener-less Bun server retained under PPID 1 at 67.6 MiB after all child/listener cleanup | 0 of 10 exact owned PIDs retained; UI, API, and OpenCode listener ports all clear within 6 seconds | Same HMR Ctrl-C entrypoint; runtime duration differed, so this establishes deterministic cleanup rather than a performance delta |
| Stream stress after directory cleanup | 50,000 / 50,000 bytes, 334 flushes | 50,000 / 50,000 bytes, 337 flushes; 914.7 ms wall, 135.0 MiB RSS | Repaired Bun benchmark; a bounded 64-directory timestamp index preserves pacing after empty queues are released; wall/RSS are run-specific endpoint measurements |
| Cursor idle Agent cache after 20 distinct sessions | 20 retained by the previous unbounded `Map` policy | 16 retained, 4 closed by capacity; shutdown returns retained count to 0 and total closed to 20 | Same dependency-free 20-key lifecycle harness; production Test-project prewarm/delete repeat also completed 20/20 with one worker |
| Cursor persistent-worker RSS through 20 session lifecycles | not measured before policy change | 176.8 MiB after first cold prewarm, 101.3 MiB at 10, 108.2 MiB at 20, 59.5 MiB after all 20 session deletes | Same live worker PID; endpoint RSS samples without explicit GC, so this demonstrates release/plateau behavior rather than a comparable before/after reduction |
| Full validation release gate | 77.41 s / 1,378,156,544-byte peak RSS | 80.30 s / 1,347,436,544-byte peak RSS | Same command but different checkout/cache state and expanded 2,463-test set; recorded as endpoints, not a causal performance claim |
| Full production build | 42.84 s / 2,152,890,368-byte peak RSS | 45.67 s / 2,466,709,504-byte peak RSS | Same command but different checkout/cache state and a larger shared UI/VS Code surface; existing bundle and VS Code CommonJS `import.meta` warnings remain, so no optimization claim is made |
| Electron package build | not measured | 89.68 s / 2,896,986,112-byte peak RSS | Final ARM64 package includes web staging, Swift helper, native rebuild, signed `.app`, ZIP, DMG, and block maps; this is an endpoint, not an optimization claim |
| Isolated packaged Electron idle topology | packaged baseline had 10 processes with configured MCP children | 7 processes / 556.8 MiB aggregate RSS: main, renderer, four Chromium service helpers, one OpenCode child | Latest loaded isolated profile did not start the baseline's separate MCP children, so counts are intentionally not treated as comparable |
| Loaded packaged Electron quit cleanup | Main plus five helpers exited but one 878.0 MiB OpenCode child remained under PPID 1 with three listeners | 0 of 7 exact owned PIDs retained; main, private bridge, and every OpenCode listener cleared | Same ARM64 artifact/profile/data and Cmd-Q path before/after; the after artifact includes the awaited cleanup barrier and passed deep signature verification |

## 2026-07-11 Targeted Stop And Session-Revert Isolation Follow-up

The external fixture was reconfirmed as `/Users/zoubair/Repositories/Test`,
clean `main` at `6baa1e60b38f675835915bd0f11f35ae8b899d72`. Builder mode with GitHub
Copilot GPT-4.1 created and edited uniquely named files in two independent
sessions. Every tracked fixture file was hashed before the run.

| Scenario | Result | Evidence |
| --- | --- | --- |
| Stop during one long shell tool | pass | Stop was issued after two early writes and during a 45-second sleep. The late write stayed absent for 50 seconds beyond Stop; `/api/session/status` no longer listed the session; the assistant record retained `MessageAbortedError`, an errored shell part, and patch metadata. |
| Revert Session A's interrupted turn | pass | `devryan-revert-a.txt` returned to its checkpoint hash, the post-checkpoint file was deleted, the late file remained absent, and Session B's file retained hash `b4bb1c18ece75ab8a79052fc37bded165ae9ac9eab1db15a8e42428fdbc44c90`. The UI hid the reverted suffix and restored the clicked prompt into the input. |
| Initial cross-session isolation | pass | All six tracked file hashes remained equal to baseline and Session B retained both messages with no revert marker. |
| Move Session A farther back after Session B was itself reverted | fail before fix | Session B's absent untracked file was recreated with the same protected hash. Session A's OpenCode unrevert snapshot still contained the path, while the pre-call Git status and Session A diff did not. |
| Completed-turn earlier-boundary move | fail before fix | The server returned 409 because it reverse-applied the already-reverted later-turn diff a second time. |
| Added file without a trailing newline | fail before fix | OpenCode emitted `\\ No newline at end of file`, but scoped reconstruction inserted a newline and rejected the otherwise exact current file. |
| Exact A2/B2 replay after fix | pass | A2 reverted to its checkpoint, B2 reverted to absence, then A2 moved to its first message with HTTP 200. Both controlled files remained absent and all tracked hashes still matched baseline. |
| Fixture cleanup | pass | Final `git status --porcelain=v1` is empty; all original tracked hashes match and every controlled test path is absent. |

The root fix remains outside streaming and normal session hot paths. Scoped
revert now inspects at most the current unrevert snapshot and the first relevant
patch snapshot, filters their trees against Git-tracked paths, and snapshots
only non-Git paths (including absence tombstones). An earlier boundary reverses
only the newly hidden message interval. Unified-patch side reconstruction now
honors no-final-newline markers. No dependency or cross-runtime contract was
added.

The focused server baseline was 18 passing proxy/revert tests. Three
regressions were added test-first (each observed red before implementation),
bringing the suite to 21 passing tests and 69 assertions. The final live replay
is the user-visible proof; static checks alone were not used to claim success.

## Remaining Risks And Unknowns

- Retry-path memory growth remains confirmed but not classified as a leak. The
  separate clean 50-cycle session-switch run reached a narrow post-GC plateau;
  it does not prove provider-retry or long-stream heap behavior.
- The current source OpenAI runtime exposed a real usage retry and a terminal
  invalid-model error, but not a `session.status: retry` carrying the model
  error. The new bounded auto-abort branch is covered through the real sync
  reducer boundary; its upstream retry/abort request remains `not exposed` in
  this runtime pass rather than being claimed from static checks.
- Provider-native subagent visibility depends on events actually exposed by the
  provider/OpenCode contract. Unsupported activity will be `not exposed`, not
  inferred.
- Cursor provider-native failure and abort recovery is verified through the
  production normalization/persistence boundary and shared task presentation.
  The live Cursor probe exposed a patch tool but no native subagent, so a live
  partial-task failure was not manufactured merely to turn automated evidence
  into a runtime claim.
- The Cursor Agent count/TTL/release policy is verified at its production cache
  boundary, through the host worker command path, and with 20 real session
  prewarms/deletes. The worker intentionally does not expose provider Agent
  objects as a public diagnostic; the exact live count remains established by
  the production policy test rather than private runtime introspection.
- Cursor ACP explicitly reported that its current tool surface does not expose
  the structured question tool. The question-card runtime scenario therefore
  used the configured OpenCode Zen provider; Cursor is recorded as `not
  exposed` for native structured questions rather than treated as a card bug.
- GitHub Copilot now runs supported models by disabling both OpenCode naming
  forms for only the optional Resend MCP namespace on Copilot prompt requests;
  all core tools and Railway remain available. A configuration with a different set
  of exceptionally large MCP namespaces could still exceed the provider's
  128-tool ceiling and needs an upstream/composed-manifest introspection
  contract rather than speculative client-side counting.
- Web/Electron and VS Code managed OpenCode no longer use `--pure` or suppress
  default plugins, because live web evidence proved that those switches hide
  config-origin bundled tools. VS Code launch tests now require the same policy
  and validate that only a complete private IPv4-loopback URL/token pair enters
  the child environment. A live Extension Development Host tool-discovery run
  remains pending the final runtime matrix.
- Modern Copilot payloads with no picker-enabled models are now narrowed to the
  API-returned utility IDs that GitHub documents as universally enabled. The
  current account verified GPT-4.1, GPT-4o, and GPT-4o mini; unsupported newer
  rows are no longer advertised. GitHub model availability remains dynamic,
  so picker-enabled rows continue to come from the account response rather
  than a DevRyan allowlist.
- Oh My OpenCode Slim locally defines wrapper installation, presets, agent
  metadata, and runtime hooks, but no durable DevRyan scheduler/recovery
  contract. The managed orchestration phase must not guess missing Slim policy.
- Local packaging had no Apple notarization credentials. The emitted app passes
  the explicit native-artifact gate and deep `codesign` verification, but the
  expected ad-hoc build is rejected by Gatekeeper and notarization remains a CI
  credentialed release check.
- The Intel and ARM native rebuilds both produced the requested architectures;
  only the local ARM64 `.app`/ZIP/DMG was emitted. The release workflow remains
  authoritative for the complete two-architecture artifact matrix.
- Electron packaging rebuilds the shared workspace native modules in place.
  The emitted app is self-contained, but a developer returning immediately to
  the host Node CLI must restore host ABI bindings. `bun install --force` was
  repeated at final handoff and restored loadable `better-sqlite3`, `node-pty`,
  and Cursor `sqlite3` in 6.65 seconds. A dedicated package-staging dependency
  tree remains the recommended follow-up if local package/development switching
  becomes a frequent workflow.
- The earlier `opencode-agents.test.js` wrong response and later provider-route
  HTTP parser error shared a confirmed test-harness cause: Supertest started an
  unspecified IPv6 listener but connected to the same numeric port on
  `127.0.0.1`. macOS permits an unrelated IPv4 listener on that number. Route
  tests now target the server's actual address family; the deterministic
  same-port regression, 10,000-request stress run, and complete 689-test web
  suite pass. This changes test transport only, not production HTTP behavior.
- The source HMR shutdown leaks are fixed for both reproduced macOS watcher
  paths: detached OpenCode/MCP descendants and the listener-less Bun API
  parent. Other development wrappers still have locally duplicated shutdown
  helpers; they were not changed without a matching runtime reproduction and
  remain a targeted follow-up if their nested process topology proves
  equivalent.

## Final Changed-File And Architecture Summary

The pass is organized as review-sized commits from baseline `fc716bea`, changing
239 files (about 20,300 additions and fewer than 800 deletions). The distribution is: 93 UI,
58 web, 26 VS Code, 26 orchestration-runtime, 14 Electron, 8 Cursor-runtime,
6 script, and 8 root/docs/config files.

The principal architecture decisions are:

- keep high-frequency streaming state and managed-task projections in separate,
  narrowly subscribed stores, with authoritative session/question/plan state;
- assign one owner to question submission, quota polling, directory cleanup,
  Cursor Agent retention, and each long-lived process/timer/listener boundary;
- define provider-neutral DevRyan-managed orchestration in a dependency-free
  core with `owner: "devryan"`, `dvr_task_` identity, a hard three-worker limit,
  deterministic FIFO admission, durable bounded history, immutable terminal
  envelopes, and explicit retry/resume/continue/abandon recovery;
- keep provider-native tasks observational and distinct: they are never counted,
  cancelled, or synthesized by the DevRyan scheduler;
- host one scheduler per web/Electron or VS Code owner, connect bundled tools
  through a private loopback bearer RPC, and strip ambient settings that could
  suppress those bundled tools;
- project only bounded, prompt-free managed state to the UI, publish exact
  compaction-removal events, and render a root-scoped dispatch strip outside
  the hot message stream;
- use narrow compatibility policy where evidence requires it: Copilot receives
  only the optional Resend namespace tool cap and account-authoritative model
  discovery, while Cursor receives bounded Agent retention and explicit native
  task failure/abort preservation; and
- make shutdown ownership deterministic from HMR through packaged Electron,
  including detached process-group reaping and an awaited Electron quit barrier.

## 2026-07-15 Targeted Reliability Follow-up

This follow-up applied 27 additional regression-first changes in the isolated
`codex/mcp-warmup-singleflight` worktree. Each confirmed issue received a red
test before implementation, focused verification immediately after the change,
the affected user journey through the production UI, and the applicable
repository validation tier. No dependency was added and no provider prompt,
model, reasoning setting, or output limit was changed.

| Area | Confirmed defects closed |
| --- | --- |
| Background and payload efficiency | Inactive-directory sidebar hydration could start directory-owned runtime services; managed task results duplicated large terminal payloads; a source-owned local plugin and its packaged fallback could both register. |
| Managed orchestration and plugins | A launch could outlive lost scheduler ownership; a pre-execution hook failure could strand pending-start barriers; the read-only plugin catalog missed OpenCode's singular `plugin/` directory. |
| Reconnect and retry | Bootstrap could restore a manually stopped retry; reconnect could reapply a stale status snapshot over a newer SSE event; restored idle queues did not retry on connection recovery; fixed abort-guard TTL could expire before an advertised retry deadline. |
| Message, queue, and revert delivery | Bounded child polls could regress terminal state and omit cached history; failed directory delete could replace newer session state; failed revert could discard a concurrent turn; manual queued dispatch lacked stable retry identity; authoritative message echo could retain/remerge optimistic part IDs; provisional assistant messages could remain parentless; filesystem aliases could misroute newly created sessions. |
| Permanent session deletion | External deletion could strand the selected session; selection, queue, composer, context, permission-auto-accept, notification/timer, UI/worktree/abort, materialization/lifecycle/blocking-request, and unexpected-abort reconciliation owners could survive or write back after permanent deletion. Archive remains reversible and preserves all of these owners. |

### Follow-up Measurements

| Measurement | Before | After | Interpretation |
| --- | ---: | ---: | --- |
| Inactive-directory runtime expansion | 7 processes / about 0.95 GiB to 13 processes / about 1.83 GiB after one second-directory message read | Automatic inactive-directory reads are suppressed; active Test selection and normal bootstrap remain functional | Removes a reproduced source of avoidable MCP/runtime fanout; no general OpenCode process-reduction claim is made. |
| Managed terminal result serialization | Two copies of a 60,014-byte preview; original production-shaped capture was 121,212 bytes | Current deterministic shape is 120,373 to 60,260 bytes, one preview, 49.94% smaller | Only model-facing tool output is compacted; ledger, RPC, UI, and acknowledgement records remain complete. |
| Duplicate plugin tool schemas | OpenAI 285 schemas / 270,507 characters; other measured providers 288 / 272,966 | OpenAI 281 / 266,464; other measured providers 284 / 268,923 | Removes exactly four schemas and 4,043 characters attributable to duplicate Slim registration; unrelated duplicates are not misattributed. |
| Raw streaming delivery probe | Model hypothesis predicted 1,000 reducer/React deliveries | 1,000 roughly 1 ms raw deltas produced 56 reducer deliveries through the 24 ms coalescing frame | Rejected the proposed per-delta render regression; no production batching change was made. |
| Final full validation | Earlier ledger baseline: 77.41 seconds / 1.38 GB peak for the smaller historical suite | 100.99 seconds / 1.20 GB peak; 2,803 tests plus workspace lint and type-check | Suite size and cache state differ, so this is a release-gate endpoint rather than a speed claim. |
| Final production build | Earlier ledger baseline: 42.84 seconds / 2.15 GB peak | 138.83 seconds / 2.08 GB peak | Cold/cache conditions differed materially. Existing `import.meta`, dynamic-chunk, dependency `eval`, and large-chunk warnings remain visible; no build-speed improvement is claimed. |

### Provider And Runtime Coverage

- OpenAI was exercised through DevRyan for read-only Test-repository review and
  successive independent hypotheses, including `openai/gpt-5.6-terra-fast`.
- The protected live matrix already records GitHub Copilot GPT-4.1/GPT-4o/
  GPT-4o mini, Cursor, and OpenCode Zen journeys. This follow-up preserved those
  provider-specific paths and re-ran the complete shared runtime suites.
- Current discovery still reports Anthropic, Google, and OpenCode Go as
  connected. Their shared request, schema, selection, sync, queue, retry, and
  runtime contracts are covered; this follow-up did not manufacture new
  billable live completions merely to turn contract evidence into a stronger
  claim.
- Web/Electron and VS Code share the managed plugin, orchestration executor,
  selection, queue, reconnect, and deletion contracts touched here. The final
  full gate and production build passed both runtime owners. Legacy Tauri
  received no new feature work.

### Final Verification And Visual Evidence

- `bun run validate:full`: pass. Counts were 17 script, 107 orchestration, 111
  Cursor runtime, 40 Electron, 1,625 UI, 808 web, and 95 VS Code tests.
- `bun run build`: pass for web, Electron, and VS Code with only the existing
  warning categories listed above.
- The final focused unexpected-abort suites passed independently at 84/84 and
  47/47, avoiding their known process-global Bun mock-order conflict.
- Twenty-one named visual captures are retained under
  `/Users/zoubair/.codex/visualizations/2026/07/14/019f62f4-16c6-7063-92ea-0608c34c405c/`.
  Backend-heavy transitions without a meaningful static comparison were still
  exercised through their consuming production UI during their focused loop.
- The final unexpected-abort replay held the exact `limit=200` reconciliation,
  emitted authoritative deletion, released the late response, and proved no
  stale text returned. It recorded no console/runtime errors or blocked
  mutations while retaining the OpenAI hypothesis response.

### Rejected Findings And Residual Risk

Source inspection or deterministic replay rejected model hypotheses about
queued cancellation after slot admission, cross-session poll overwrite,
asynchronous notification acknowledgement, a nonexistent delayed parent-child
activity event, one React commit per delta, whole-record archive rollback, and
stale indicator-loop restoration. These were not converted into speculative
production changes.

No confirmed high-severity regression remains. Residual work is limited to:

- the broader repeated tool-schema provenance outside the four schemas owned by
  duplicate Slim registration; presentation-layer deduplication would hide
  duplicate hook execution and is therefore unsafe without stronger OpenCode or
  user-configuration provenance;
- a fresh billable live-completion repeat for every connected provider, which
  was not required by a provider-specific production change in this follow-up;
- the existing large bundle/chunk warnings and provider-retry heap-growth
  classification, neither of which has a reproducible regression attributable
  to these changes.
