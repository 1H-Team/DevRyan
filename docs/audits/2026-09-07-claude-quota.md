# Claude subscription quota investigation — 2026-09-07

## Findings

The installed Claude bridge loses actual client tool results during repeated native resumes, changes its system prefix after Git edits, and enables background status inference that is absent from client usage counters. These mechanisms were reproduced with the installed native executable against a synthetic, loopback-only provider. The correction preserves the selected native history branch, removes the mutable Git snapshot in passthrough mode, stops processing at forwarded tool hooks, and uses normal SDK mode.

The retained incident is a real usage problem, not a duplicate SSE accounting problem. It does **not**, by itself, establish a precise 10× subscription multiplier. Subscription percentages, native usage, and displayed context occupancy measure different things.

The sustained live control subsequently reproduced an expensive read loop: its first brief timed out after ten minutes, with 398 successful file reads, no edits, and a confirmed **16-point five-hour quota increase**. The matched direct run completed all twelve briefs for a one-point increase. These are different completion outcomes, so the figures must not be presented as an equal-work cost ratio.

Live paired quota verification is being recorded separately below. No parity claim should be inferred from the offline fixture's synthetic token values.

## Runtime and incident evidence

The running installed DevRyan/OpenCode processes started after the affected afternoon sessions. Their in-memory Meridian request telemetry was empty; persisted Meridian telemetry was not enabled. This prevents reconstructing every original provider attempt, including failed attempts and background classifiers. The diagnostic journal was inspected first, and the journal gap check found no gap for the affected Claude sessions. Unrelated Bot computer gaps do not establish Claude coverage loss.

The running application was DevRyan `1.1.15`, started at 19:21:29 local time, with its OpenCode `1.18.29` process started at 19:22:01. The installed managed tuple was `opencode-with-claude@1.8.0`, `@rynfar/meridian@1.62.6`, `@anthropic-ai/claude-agent-sdk@0.2.141`, and native Claude Code `2.1.215`. The executable came from the optional `@anthropic-ai/claude-code-darwin-arm64` package. Native incident records independently confirm `2.1.215`. The running configuration used Claude's code system prompt and disabled the additional client system prompt; duplicated combined prompts were not the cause in this installation.

The installed Meridian bundle already included the previous HTTP and tool-handoff fix. Its SHA-256 was `49ac980820bd255c96f98924a43573d9ec58c32dfee3ea506ca75fa7221d8ac4`; the unpatched source gate is `522decb5f1d2775c04f3a5c9b7e75f49a41fa40de1a62ebe4e2806167ca7b0ab`. The study's control retains those existing fixes.

The affected Designer child `ses_f839f6f89ffeLEKdyY8Nh9D8N6`, under parent `ses_f83a7fa7fffeLxeEWLnguod6KU`, used exact `claude-opus-4-8` with medium effort. It joins to native session `b2c84308-3a71-4889-83bb-62d3473cd206` through its 207 distinct Anthropic message IDs:

| Counter | Native Claude | OpenCode/journal |
| --- | ---: | ---: |
| Uncached input | 414 | 414 |
| Cache creation | 13,475,857 | 13,475,857 |
| Cache reads | 4,716,259 | 4,716,259 |
| Output including reasoning | 137,982 | 45,063 output + 92,919 reasoning |
| Nonzero provider responses | 207 | 207 |
| Native SDK session IDs | 1 | Correlated native file |

The cache-read fraction was **25.924%** of processed input. Native records assign the cache writes to the one-hour tier, and successive requests were seconds apart. The retained file spans 14:58:20–15:46:09 UTC, with no compact-summary record or compaction-boundary subtype. Five-minute expiration and repeated SDK-session eviction do not explain this retained session. The native output figure already includes reasoning; adding reasoning to that native number would double count it. Split assistant content records and resumed transcript copies must be deduplicated by provider message ID.

The separately observed user task used `claude-fable-5`, high effort, and Claude Code `2.1.260`. From the pre-acceptance baseline through its completion it produced 133 native responses, 38,763,719 cache-read tokens, 214,163 cache-write tokens, 266 uncached input tokens, and 97,426 output tokens in one native session: **99.450% cache reads**. The five-hour quota moved from 5% to 13%, weekly from 41% to 43%, and the Fable-specific weekly window from 14% to 18%. This is useful observational evidence, but different model, effort, runtime version, workload and preceding context prevent treating it as a paired benchmark.

## Causal reproduction and correction

### Client results revert to native denials

Meridian returns native tool calls to OpenCode and blocks native execution. Its transcript therefore contains a denial placeholder for each forwarded tool. The next request resumes at the preceding assistant UUID and supplies the actual client result. Without a native fork, the old denied branch remains in the same transcript file. A later resume can reconstruct that old branch, replacing an earlier actual result with the denial.

The fixture verified native parent UUID chains and compared the actual synthetic provider request bodies. The real result was present on one request and replaced by a denial on the next. This occurs without changing SDK session ID and reproduces on both Claude Code `2.1.215` and `2.1.260`. Upgrading the executable alone did not fix it.

The correction sets supported SDK `forkSession: true` only for passthrough resumes with a selected assistant checkpoint. The native fork persists the selected branch and its actual preceding results. Ordinary warm continuations retain their session, and existing explicit undo/fork behavior remains authoritative. No native transcript is edited by DevRyan.

### Git edits invalidate the prefix

Each per-tool SDK process recomputes the native Git status snapshot. Editing a previously clean file changes the system prompt at the beginning of the next request, even after history retention is corrected. Moving the dynamic section into the initial user message also changes a previously cached prefix and did not solve the fixture.

Passthrough uses client tools and disables native tools. Setting `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` in that mode removes the mutable startup snapshot on the pinned executable. The accompanying note tells Claude to read Git state through client tools when needed and use prior results/history to distinguish its edits from existing work. Explicit project/client instructions and the client tool inventory remain available.

### Hidden status and continuation requests

Meridian sets `CLAUDE_CODE_SESSION_KIND=bg` to suppress a scratchpad hint. With the pinned CLI this also triggers Haiku session-status classification, including recent assistant text and tool summaries. These requests do not appear as main assistant usage records or as separate Meridian client requests. Removing that implicit background mode removed the classifier requests; no scratchpad section was present in the resulting pinned passthrough prompt.

Separately, denying a tool does not stop the model loop. An asynchronous SDK interrupt can lose a race to another provider request. The forwarded hook now also returns the documented `continue: false` when early stopping is enabled. The existing complete-tool-envelope capture, terminal drain and native checkpoint verification still decide whether the session can be retained. [Claude hook output reference](https://code.claude.com/docs/en/hooks#json-output).

### Offline acceptance

`scripts/qa/meridian-prefix.mjs` copies the managed package, selects the explicit native executable for both streaming and non-streaming paths, uses dummy API credentials against a loopback gateway, changes Git state between turns, and verifies the full system/tool/prior-message prefix plus every expected real result. The gateway records only authored synthetic requests and no headers or credentials. Its token values are deliberately synthetic.

The installed control with six handoffs and two parallel tools lost 2, 4, 6, 8, 10 and then 12 previously delivered results across later requests. It made 10 provider requests for eight client requests, including two background classifier calls, while retaining one native session ID.

The final correction passed **20 handoffs with four parallel tools**: all 80 actual results remained in a stable prefix, with 22 client requests and exactly 22 provider requests, including the terminal turn and an ordinary warm follow-up. A separate non-streaming run passed ten handoffs with three parallel tools and exactly 12 provider requests for 12 client requests. Both used the verified installed CLI `2.1.215`; the synthetic provider observed no extra request in either corrected run. Their intentional native fork counts were 21 and 11 respectively.

## Live comparison protocol

The guarded editing study is exposed through `node scripts/qa/meridian-designer-continuity.mjs --quota CONFIG.json`. The configuration names an explicitly prepared private runtime, installed module source, exact native executable, authoritative loopback quota origin, a baseline file, cache-owned output, and the separately observed reference transcript used for local activity detection. Preparation uses `prepareMeridianFixture`, `seedEditingFixture`, and `prepareClaudeQuotaRuntime`; it does not read credentials or submit inference.

The three arms use the same authored TSX/CSS fixture and three prompt strings from `claude-quota-fixture.mjs`: edit and add/run tests, follow-up edit and extend/run tests, then review/run tests. Direct Claude runs in a genuine interactive PTY using the web package's existing `node-pty` dependency. The DevRyan arms run the actual web server and OpenCode plugin stack in an owned profile. All use the installed native Claude executable, exact Opus 4.8, and medium effort. Native and OpenCode tools/system instructions necessarily differ; that is a measured harness difference, not a claim of identical provider bodies.

“Fresh start” means a new project and session. Shared provider prefixes can remain cached across arms, so these are not guaranteed cold-provider-cache measurements. Warm continuation means the two follow-up turns within that same project/session. The isolated DevRyan provider advertised a one-million-token context limit; no custom context limit or forced compaction was used. These small live fixtures do not establish behavior at the compaction boundary.

OAuth access is obtained through the existing installed credential abstraction and supplied only in child environments. Tokens, refresh credentials, passwords, and auth headers are not stored in study evidence. The installed runtime and user sessions are not restarted or patched. Private runtimes are stopped through their owned process handles.

The original five-hour baseline was 5%. The user initially authorized a 20-point total ceiling and subsequently raised it to **40 percentage points**, including observational reference work, failures, and retests. Diagnostic admission reserves at least five points; candidate admission initially left two points of headroom, increased to four after the sustained control's burst. Missing/stale authoritative quota suspends new prompts; resets, negative deltas and newly observed reference activity invalidate a measurement. Each turn records immediate and delayed quota readings plus independent file checks and a real `node --test` run. Percentage resolution is one point; a displayed zero delta does not mean free inference.

### Small editing comparison

Three valid repetitions per arm completed the small fixture. Accepted arm order was direct/control/candidate, candidate/control/direct, then control/direct/candidate. The third cohort's first direct attempt completed the file work but lacked a valid post-work quota endpoint and was excluded; its replacement is the accepted direct run. Additional stopped attempts remain in the retained manifest and count against the overall budget.

| Arm, three accepted runs | Native main responses | Cache writes | Cache reads | Cache-read fraction | Five-hour deltas |
| --- | ---: | ---: | ---: | ---: | --- |
| Direct interactive Claude | 35 | 30,594 | 756,715 | 96.106% | 0, 0, 0 points |
| Installed DevRyan control | 41 | 77,826 | 1,002,765 | 92.791% | 0, 0, 0 points |
| Corrected DevRyan | 37 | 23,818 | 945,926 | 97.536% | 0, 0, 0 points |

Weekly and Fable-specific weekly deltas were also zero in every accepted small run. Each arm passed independent file checks and its model-authored regression tests. These counts describe the actual runs; the model can choose different tool sequences despite identical briefs. The quota display's one-point resolution prevents a consumption ratio or a 25% parity conclusion from these small samples.

An early runner accepted a recently fetched reading even when it predated the last model response. That was corrected to require an OAuth fetch after completed work and a 30-second reporting allowance. Three earlier endpoints were recovered from recorded pre-prompt readings before the next attempt, with no intervening inference; the raw result files were preserved. The final accepted cohort uses the corrected runner throughout. A function regression rejects the original timing mistake.

### Sustained editing comparison

The optional `sustained` workload uses twelve fixed briefs and an authored React review workbench. It adds search, status filters, stable sorting, pagination, summaries, full-set CSV export, immutable moderation/replies, safe highlighting, view composition, accessibility and compact layout. Every turn must change real TypeScript/TSX, CSS and regression tests. An external grader exercises public behavior and rendered React markup; the final turn performs a browser build. The larger test is intended to provide a measurable quota signal after the small runs remained below display resolution.

The preliminary one-brief calibration made 124 line additions across five source/CSS/test files and passed its behavior and regression tests. Its scope check correctly rejected a GitHub CLI state file created before the first prompt. Native startup state was redirected to owned XDG directories outside the project, and a real no-prompt CLI startup then passed with no untracked project files, no native assistant response and complete process cleanup. All full arms use the final frozen template with its stylesheet wired into the component.

The first full direct run completed all twelve briefs, passed every cumulative behavior check and its regression tests, and produced JavaScript and CSS in the final browser build. It made 108 native main responses, with 6,826,671 cache-read tokens, 85,756 one-hour cache-write tokens, 203 uncached input tokens and 59,227 output tokens. Its five-hour and weekly deltas were each one point. This run is retained as a functional pilot, but excluded from the paired comparison: the starter ignored `dist/` while the brief named `build/`, so the model correctly added `build/` to a frozen manifest. The final starter now ignores both directories. A deterministic contract builds that exact starter and verifies that the build creates no unexpected project files; the full external verifier also passed a separate handwritten reference implementation and rejected a deliberately broken summary. All accepted full runs must use the same corrected, hash-checked template, grader and prompts.

The five-hour window reset at 01:20 UTC on September 8. A fresh OAuth reading reported zero usage with a null reset timestamp, indicating an inactive window. The study retained ten observed points of prior consumption plus one point for rounding uncertainty under the same 40-point ceiling. The first active provider reading then bound the new window to its actual 06:30 UTC reset; subsequent resets cannot renew the budget implicitly.

Before restarting the full comparison, model work paused because the existing access token could not cover a full workload. Renewal through the installed bridge's normal refresh endpoint failed without a diagnostic reason; its installed credential helper then successfully performed the ordinary renewal at 02:55 UTC, giving eight more hours of access. No token or refresh credential was written to study evidence. The installed runtime bundle was neither patched nor restarted. Quota freshness remained a separate admission requirement after renewal.

The first accepted direct run completed all twelve briefs and the browser build in 23.1 minutes. It made 116 native main responses, with 7,933,846 cache reads, 100,669 one-hour cache writes, 219 uncached input tokens and 67,481 output tokens: 98.744% cache reads. Its five-hour delta was one point; weekly and Fable-specific deltas were zero. It retained one 961,981-byte native transcript, and owned-process cleanup completed.

The installed-control attempt timed out on its first brief after ten minutes of model work. The journal records 398 completed `read` calls and two completed `glob` calls, while Git confirms that the workspace was unchanged. Most fixture files were read 43–45 times. The native transcript repeatedly alternates between requesting the domain/data/CSS group and the README/TSX/test group. A correlated read ID has both its native denial placeholder and its actual client result in separate transcript branches. All 90 native main responses used exact Opus 4.8; recovered provider observations confirm medium effort with adaptive thinking. The journal gap check, including raw-chunk verification, passed.

That failed control produced 3,784,042 one-hour cache writes, 2,067,024 cache reads, 180 uncached input tokens and 44,676 output tokens in one native session: 35.326% cache reads. A fresh OAuth endpoint after cleanup plus the reporting allowance confirms a **16-point five-hour increase**, a two-point weekly increase and no Fable-specific change. All owned processes were stopped. The failed attempt remains in the manifest; it is not counted as a completed workload or dropped from the study's cost.

The sustained protocol was then narrowed to three completed direct/corrected pairs in direct/corrected, corrected/direct, then direct/corrected order, using the same frozen fixture, grader and prompts. Repeating the expensive failed control was suspended to preserve the existing 40-point ceiling for verification of the correction; three small control repetitions had already completed. After the observed burst, candidate admission retains four points of headroom. Final corrected results and quota acceptance will be appended after these runs complete.

The first sustained corrected attempt began after quota reporting recovered, made three `edit` calls and one `write`, and changed TypeScript/TSX and CSS. The active freshness guard then stopped it during the first brief. Its six native responses produced 165,793 cache reads, 11,022 cache writes, 12 uncached input tokens and 3,309 output tokens: 93.760% cache reads. Its journal passed raw-chunk gap verification, and owned-process cleanup left no processes. No brief or full workload is counted as complete. A single diagnostic request to the same authoritative OAuth usage endpoint returned HTTP 429 at 03:49 UTC, confirming upstream quota-reporting rate limiting for this interruption; it did not submit inference or retain credentials. Model work then paused for a reporting cooldown. A fresh reading at 04:00 UTC supplied a valid delayed endpoint with zero displayed change in all tracked windows; the partial attempt remains excluded. Before another workload, a quota-only readiness check requires three successive fresh readings at 90-second intervals. The remaining attempts use the reduced polling cadence; prompts, template, grader, model, effort, post-work endpoint requirements and the active freshness bound remain unchanged.

The corrected replacement completed all twelve briefs, their cumulative external checks, the model-authored regression tests, and the browser JavaScript/CSS build. Exact model/effort, source hash, native evidence and owned-process cleanup checks passed. The first full pair is therefore accepted:

| First full pair | Direct interactive Claude | Corrected DevRyan |
| --- | ---: | ---: |
| Completed briefs | 12 | 12 |
| Native main responses | 116 | 110 |
| Uncached input | 219 | 220 |
| Output including reasoning | 67,481 | 67,477 |
| One-hour cache writes | 100,669 | 90,847 |
| Cache reads | 7,933,846 | 7,738,049 |
| Cache-read fraction | 98.744% | 98.837% |
| Five-hour quota delta | 1 point | 2 points |
| Weekly / Fable-specific deltas | 0 / 0 points | 0 / 0 points |
| Model-work and verification interval | 15.3 minutes | 19.1 minutes |
| Wall time including setup and quota waits | 23.1 minutes | 40.5 minutes |
| Native transcript files / bytes | 1 / 961,981 | 99 / 26,971,048 |

The corrected runtime recorded 110 Meridian invocations and 99 distinct native SDK sessions, consistent with intentional checkpoint forks plus ordinary warm continuations. Both arms used only one-hour cache writes. Their successful native usage is close, while their displayed quota deltas differ by one point. The endpoint resolution prevents treating this pair as either established 25% quota parity or a precise twofold consumption ratio. The wall-time comparison also includes different quota-reporting waits and observation-reuse cadences.

The next corrected attempt was stopped during its first brief by another stale quota reading. It had made source, CSS and test edits, but is excluded: the independently inspected partial workspace passes the external behavior check and still has one incorrect model-authored test expectation. The agent had not completed the brief or corrected that expectation before interruption. Its nine native responses recorded 262,161 cache reads, 12,860 cache writes, 18 uncached input tokens and 4,878 output tokens. Recovered exact-effort evidence and journal raw-chunk verification passed, and all owned processes were stopped. A fresh delayed endpoint confirmed zero displayed change in all tracked windows. No partial code or assertion was repaired by the study operator to turn this attempt into a pass.

Model work then paused before the 06:30 UTC reset: the remaining time did not accommodate another full pair with the existing startup margins. Both arms of an accepted pair must belong to the same quota windows; a completed arm whose counterpart moves beyond a reset is retained as unpaired and its cost remains in the study ledger. Thirty observed points have been used so far, with 31 charged to the admission ledger after the earlier rounding reserve. A proposed increase from 40 to 50 points is awaiting user approval; the 40-point ceiling remains in force.

### Idle, cancellation and recovery

Direct interactive Claude and corrected DevRyan each passed an observation of at least six minutes with no new native assistant response and no displayed quota change. Each then started a real foreground Bash tool, acknowledged cancellation, and left its delayed completion sentinel absent past fifty seconds. No new native assistant response appeared after the settled abort; a subsequent review/test prompt passed. Owned process cleanup reported no remaining processes.

The corrected DevRyan attempt first completed the small file work but stopped when its final quota observation became stale. That failed attempt is retained, including its one-point five-hour delta. The unfinished cancellation stage was then run against the same independently verified project and persisted OpenCode session after restarting only its private runtime. This recovery stage passed exact model/effort checks and had zero displayed delta. Direct and recovered DevRyan request totals cover different scopes and are not a cancellation cost comparison.

The installed quota reader has a 30-second cache and can serve stale data for up to fifteen minutes after refresh failures; the public projection can still report no error in that case. The study uses the actual OAuth fetch time. Its runner initially reused valid observations for up to sixty seconds; after the confirmed 429 this became 85 seconds to reduce refresh bursts and can wait up to ten minutes with model work idle. The ninety-second freshness bound during active inference remains unchanged. HTTP 429 was verified for the sustained corrected interruption; the retained evidence does not identify the cause of every earlier stale interval.

## Repository verification

The full validation command passed workspace lint, type checks and documentation checks, then stopped on ten timing-sensitive script test failures under parallel load. The same five affected test files passed all 61 tests unchanged in a serial rerun. The complete script suite then passed all 579 tests serially, and every remaining `test:full` group was executed. One bot-egress response-boundary test raised `ECONNRESET`; the unchanged package passed all 32 tests on rerun. No assertion, timeout or unrelated implementation was changed to obtain these results.

The remaining coverage passed, including 3,572 UI tests, 3,761 web tests, Electron tests, the legacy desktop's locked Cargo suite and all shared/runtime packages. The final script suite passed all 585 tests under its normal parallel runner after the longer fixture and quota-window guards were added. Its starter test is a template seeded into the disposable project; a deterministic contract test runs the seeded React tests and rejects the unimplemented baseline. The quota/prefix/fixture tests pass all 16 cases, including regressions rejecting a quota snapshot that predates completed work, preserving the study budget across resets, and verifying ignored browser-build output. The production patch's focused installer/handoff tests passed all 29 cases. `bun run validate:quick` also passed after the observation-reuse adjustment, including the UI and web suites.

`bun run build` and `bun run bundle:check` passed. The latter measured web-main gzip at 1,379,639 bytes against a 1,456,388-byte budget. A final real-CLI offline smoke also passed five provider/client requests with zero hidden requests after cleanup handling was added. These are local build and runtime checks, not signed-release or packaged-Electron acceptance evidence.

## Alternative harnesses

| Project and pinned revision | Claude execution model | Implication for DevRyan |
| --- | --- | --- |
| [T3 Code `0d34579`](https://github.com/pingdotgg/t3code/blob/0d34579d674920cc47fc5c908494f51ed3895204/apps/server/src/provider/Layers/ClaudeAdapter.ts) | Owns a long-lived SDK query with queued user input and native/MCP tool execution. Its current capability probe supplies an async prompt that never yields an inference prompt. | Avoids the deny/interrupt/resume translation at every client tool. A useful reference for a first-class Claude runtime adapter; not a drop-in OpenCode model provider. |
| [OpenClaw `fd1f8bd`](https://github.com/openclaw/openclaw/blob/fd1f8bd1d260bd45becad89b0a1218cffc9f6d7b/extensions/anthropic/cli-backend.ts) | Keeps a native Claude CLI session warm over stdio and exposes gateway tools through loopback MCP while retaining host policy. Its Claude backend also disables dynamic Git instructions for cache stability. | A relevant architectural reference for keeping native Claude history/tool execution intact while preserving host-owned tools. |
| [Hermes Agent `6178e9f`](https://github.com/NousResearch/hermes-agent/blob/6178e9f4eed8d99f4fc550add939d58c7bed6206/agent/anthropic_adapter.py) | Direct Anthropic Messages transport with OAuth and tool/product-identity transformations, rather than the native Claude SDK tool loop. | Its documented Max route uses extra usage and does not spend the included allowance; it is not a like-for-like replacement for this subscription comparison. Check the pinned [provider documentation](https://github.com/NousResearch/hermes-agent/blob/6178e9f4eed8d99f4fc550add939d58c7bed6206/website/docs/integrations/providers.md). |
| [Meridian `58f8a70`](https://github.com/rynfar/meridian/blob/58f8a70402fce471712cd4650f721afcb80f05d7/src/proxy/query.ts) | Converts an external model-provider/tool protocol into per-request native SDK queries, passing client tools through denial/checkpoint/resume boundaries. | Fits the existing OpenCode provider interface, but this translation is the source of the reproduced history/cache hazards and subprocess overhead. |

The near-term correction can remain bounded to the managed Meridian patch. For a future replacement, a warm native Claude session with host tools exposed through MCP is the stronger direction to evaluate, using T3/OpenClaw as references. That requires an explicit architecture decision covering permissions, cancellation, session recovery, compaction, tool ownership and usage attribution; this investigation does not silently migrate the runtime.

Anthropic's SDK subscription policy must be read from its current update: enforcement announced earlier was paused on June 15. Hermes' extra-usage transport is a separate claim in Hermes' own documentation. [Current Claude plan/SDK policy](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), [Claude prompt caching](https://code.claude.com/docs/en/prompt-caching).

## Rollback and remaining limits

The managed installer accepts only the pinned original, complete HTTP-only patch, complete previous handoff revision, or complete current revision. Partial edits or an unknown source hash fail closed. The existing atomic helper/entrypoint installation is retained.

The final candidate bundle SHA-256 is `3780a40b4d02927087565706ce3e8d4cb355be8cd8c6b6b0be44f4c497cf5114`. For rollback, retain the earlier HTTP/handoff fix and reverse only the five exact `MERIDIAN_PREFIX_EDITS` replacements. Verify that the resulting entry matches the previous installed SHA-256 `49ac980820bd255c96f98924a43573d9ec58c32dfee3ea506ca75fa7221d8ac4`; refuse partial or unknown input. Keep an original backup and replace the entry atomically while the affected runtime is stopped. Validate this procedure in a fresh private profile before applying it to an installation.

Returning to an older DevRyan build alone does **not** remove the current patch: the older installer does not recognize this new revision and will reject it. Restore the verified previous bundle before provisioning with that older installer. The installed production runtime has not been modified by this study. Do not manually rewrite its native transcripts.

Native forking creates additional transcript files and copies the selected history at each tool checkpoint. This avoids corrupting history but increases local disk use; it is a compatibility correction, not a claim that per-tool process/fork overhead is eliminated. Previously damaged histories are not automatically reconstructed. Long-term warm-session integration would avoid these repeated copies.

Native transcript counters cover successful assistant usage records, not every failed provider attempt or auxiliary inference. Live provider bodies and authorization headers are not intercepted. Model, context occupancy and API-equivalent cost do not substitute for authoritative subscription quota. Local reference inactivity cannot exclude unobserved activity on another device.

Forked transcripts can copy an earlier response under another transcript session ID. Usage remains deduplicated by provider message ID; the reusable reader reports observed transcript IDs separately. Use Meridian request telemetry for actual SDK invocation lineage. Earlier result files used a session count calculated after deduplication; that field is unsuitable for counting intentional forks and is excluded from the comparison.
