# ECC Performance And Agent-Evaluation Pass

## Scope And Evidence Rules

This audit records the context-efficiency, deterministic startup-bundle, packaged
Orchestrator-prompt, and live agent-evaluation work completed from baseline
`3c55fbc4` on branch `codex/ecc-performance-pass`.

The DevRyan repository and the separately authorized `Test` Git fixture were
the only repositories used. No dependency was added. Raw provider messages,
prompts, tool input/output, credentials, headers, URLs, local report paths, and
session identifiers are excluded from this ledger. Live reports remain only in
the ignored evaluation-report directory.

The results below deliberately separate observed outcomes from unavailable
comparisons. A passing post-change run is not evidence of a speed improvement
without a preserved pre-change run produced by the same method.

## Outcome

- Deterministic startup graphs pass checked raw and gzip budgets for web and VS
  Code. Web startup gzip is 56.40% below the supplied baseline; VS Code chat
  startup gzip is 5.02% below its supplied baseline.
- The packaged Orchestrator prompt is 959 UTF-8 bytes smaller while retaining
  its audited safety, routing, managed-work, Git, and completion contracts. The
  reduction is below 10%, so no context-performance claim is made.
- The post-change OpenAI evaluation matrix passed all nine planned runs and all
  30 graders. One repair-and-test run also passed on each connected GitHub
  Copilot and Cursor provider after live evaluator-compatibility gaps were
  closed with focused tests.
- The Electron managed-task flow passed its UI acceptance checks, including
  live task presentation, child navigation, session revisit, and normal native
  quit cleanup.
- A true VS Code Extension Development Host and an eligible deterministic
  retry-memory profile were unavailable. Neither surface is classified as
  passing, and no memory lifecycle change was made.

## Context And Tool Diagnostics

The web harness preflight now exposes read-only context-budget and tool-catalog
diagnostics only when explicitly requested. Tool discovery is lazy and bounded;
unavailable live endpoints return an explicit unavailable measurement rather
than a zero-valued success. Runtime tool counts preserve ordering and duplicate
occurrences and are labelled `runtimeCatalogUpperBound`. They are not request
token counts. Packaged prompt and visible-skill accounting returns byte/count
metadata without returning prompt or skill-body content.

Turn-timing diagnostics retain a capped, identity-aware sequence of tool name,
normalized status, finality, and safe ordinal. They do not project tool input,
output, or internal call identifiers.

## Packaged Orchestrator Prompt

| Measurement | Before | Final | Change |
| --- | ---: | ---: | ---: |
| Full packaged source | 15,902 bytes | 14,943 bytes | -959 bytes (-6.0307%) |
| Loaded prompt body | 14,772 bytes | 13,813 bytes | -959 bytes (-6.4920%) |

The byte reduction consolidates duplicated policy wording. Exact-frontmatter
and semantic regression tests retain correctness/reliability priority,
question-routing and plan-approval precedence, managed dispatch/recovery,
allowed-agent and provider-native boundaries, Git policy, completion behavior,
and plan-only constraints. Because both reductions are below the specified 10%
threshold, this is measured context shrinkage only; it does not establish lower
latency, resource use, cost, or improved model behavior.

## Deterministic Startup Graphs

The checker reads existing Vite manifests, follows the configured static graph
and immediate dynamic roots, sums each unique emitted JavaScript file using raw
bytes and Node's default gzip level, and rejects prohibited emitted chunk
identities, `.bun` output, budget regressions, and missing roots. It does not
infer source-module membership from generic chunk labels.

| Graph | Supplied baseline raw / gzip | Final raw / gzip | Checked raw / gzip budget | Files | Gzip change |
| --- | ---: | ---: | ---: | ---: | ---: |
| Web main | 17,286,557 / 4,006,124 | 5,926,683 / 1,746,824 | 6,223,018 / 1,834,166 | 21 | -56.40% |
| VS Code chat | 5,424,732 / 1,575,500 | 5,128,339 / 1,496,378 | 5,384,756 / 1,571,197 | 6 | -5.02% |

The intended Git, Diff, Files, Plan, and Settings mixed static/dynamic warnings
are absent after restoring their lazy boundaries. The normal chat graph also no
longer statically includes the VS Code agent-manager surface. Lazy loading has
explicit rejection cleanup and retry coverage, and shared dialog loaders retain
one global owner with deduplicated in-flight imports.

Remaining build output includes large-chunk advisories, an ONNX dependency
`eval` warning, mixed static/dynamic relationships outside the targeted views,
the existing Node module-registration deprecation, three VS Code extension CJS
`import.meta` warnings, and a Swift API deprecation during Electron packaging.
These warnings did not fail the checked graphs or builds and were not broadened
into speculative refactors.

The local Electron package was ad-hoc signed. Its deep signature verification
passed, while the local Gatekeeper assessment rejected the unnotarized package
and notarization was skipped because release credentials were not configured.
This is build evidence, not a notarization or release-readiness claim.

## Live Agent-Evaluation Matrix

No compatible pre-change live reports were preserved. The pre-change matrix is
therefore unavailable, and this audit makes no comparative agent-speed claim.

The primary post-change selection was OpenAI GPT-5.4, Orchestrator, high
reasoning. The same explicit `Test` fixture, case definitions, repetitions, and
grading contracts were used throughout.

| Case | Runs | Graders | Aggregate duration | Result |
| --- | ---: | ---: | ---: | --- |
| Inspect | 3/3 | all passed | 228,867 ms | pass |
| Repair and test | 3/3 | all passed | 253,792 ms | pass |
| Managed change | 3/3 | all passed | 548,590 ms | pass |
| **Total** | **9/9** | **30/30** | **1,031,249 ms** | **pass** |

The nine runs recorded 138 completed tool events. Managed cases produced six
completed managed tasks and six final `continue` dispositions. The per-run
duration range was 54,256–193,194 ms, with a mean of 114,583.22 ms. These are
post-change observations, not before/after performance measurements.

An exploratory nine-run selection using the advertised OpenAI GPT-5.6 Sol
model was rejected by the provider before normal evaluation and is not counted
as the primary matrix. A separate GPT-5.4 inspect probe passed before the full
matrix.

### Connected-provider repair checks

| Provider selection | Runs | Graders | Duration | Result |
| --- | ---: | ---: | ---: | --- |
| GitHub Copilot GPT-4.1, Builder | 1/1 | 3/3 | 34,376 ms | pass |
| Cursor Composer 2.5, Builder | 1/1 | 3/3 | 22,884 ms | pass |

The first Copilot attempt exposed that the direct evaluator did not apply the
shared provider prompt-tool override and was rejected by the provider's tool
manifest limit. The evaluator now reuses that shared policy only for applicable
providers; focused tests prove the OpenAI request remains unchanged.

Cursor returns shell results in a structured JSON envelope and emits a derived
workspace-patch presentation card alongside its executed edit event. The
evaluator now strictly validates the completed shell envelope, bounded exit
codes, exact direct/wrapper commands, and the wrapper's private trailing marker.
The canonical wrapper remains observable under shell `errexit`. Cursor marks
the derived patch card with a runtime-reserved synthetic key. Provider metadata
cannot set that key on an executed tool, and the evaluator excludes a card only
when its marker, canonical producer identity, and patch/input/output/file shape
all match. Commands, output, raw exit metadata, timestamps, and raw session
identities remain private and are not written to reports.

### Final-review trust-boundary follow-up

A subsequent branch review identified three Important issues: provider metadata
could collide with the synthetic marker, signal-terminated Cursor envelopes
could be treated as authoritative test outcomes, and the retained private
runtime tree sat beside rather than beneath the configured report root. All
three were addressed before the final gates.

The producer now removes the reserved marker from prior and incoming provider
metadata while preserving unrelated fields, then sets it only on the runtime's
derived patch card. Adversarial tests prove provider-marked real edits, tests,
and structurally invalid patch cards remain counted while the exact runtime card
is excluded. Cursor result parsing now distinguishes an absent envelope from a
recognizable invalid one, so invalid structured evidence cannot fall back to
conflicting metadata or a wrapper marker. Non-empty, whitespace, missing, and
malformed signal values are rejected. A live fail-closed probe showed that the
installed Cursor SDK uses the exact empty string, rather than `null`, as its
completed no-signal sentinel; the accepted set was therefore narrowed to only
`null` or `""`, with focused RED/GREEN coverage for both successful and failing
test exits and continued rejection of `SIGTERM`.

After a fresh loopback restart, the same Cursor Composer 2.5 Builder/null repair
selection passed 1/1 run and 3/3 graders in 20,955 ms with five completed tool
events. The external fixture again matched its exact starting manifest. The
entire ignored runtime tree (10 files, 152 KiB) was moved intact beneath the
configured ignored report root without reading its contents; no task-owned
live-data directory or raw record-file type remained elsewhere under the task
temporary root.

A final branch rereview then found that the canonical wrapper trusted its inner
test marker even when the outer command carrier exited abnormally. A strict
RED probe reproduced false outcomes for abnormal, conflicting, malformed, and
marker-only carriers. The wrapper-only path now validates
every present strict Cursor-envelope or bounded metadata carrier exit, rejects
disagreement, and requires at least one authoritative outer exit of zero before
parsing the inner marker. Cursor and metadata exits `1` and `137` are rejected
with both GREEN and RED inner markers; outer zero plus inner nonzero remains the
valid captured RED case. Direct-command behavior and the exact `null`/empty
no-signal contract are unchanged.

The rereview's Minor producer/consumer coverage gap was also closed without a
production dependency: the existing web integration fixture now passes the
actual Cursor runtime records through the evaluator collector. It proves the
real provider edit remains counted while the exact runtime-derived patch card
is excluded. After a fresh loopback restart with the wrapper rule active, the
same pinned Cursor repair selection passed 1/1 run and 3/3 graders in 16,155 ms
with five completed tools. Surgical cleanup again restored the exact fixture,
and all source processes stopped.

## Electron UI Check

A signed-in Electron development runtime used OpenAI GPT-5.4, Orchestrator,
high reasoning for one read-only managed case. The parent showed live running
state, then an `Agent Dispatch` card with `Complete` and `Open Subtask` actions.
Opening the child showed its completed read tool card. Returning to the parent,
leaving the session, and reopening the completed managed session preserved the
task card, terminal state, disposition, and child link. Normal native quit
stopped the in-process web runtime and its managed OpenCode lifecycle cleanly.

This check covers task presentation, streaming state, tool-card visibility,
child navigation, disposition, revisit, and native quit for Electron. It does
not substitute for VS Code coverage.

## Fixture And Cleanup Integrity

The external `Test` fixture started and ended at the same HEAD and Git tree,
with six tracked files, zero untracked files, and zero dirty entries. Its exact
content-manifest SHA-256 remained
`7d24d56c5138d9eb7a249ef65c8a8c328748d2fd2e449baaa21e0100841bcefe`
after the OpenAI matrix, provider checks, Electron flow, memory prerequisite,
and unavailable VS Code attempt. Run-owned files were removed surgically; no
reset, checkout, or clean operation was used.

## Explicitly Unavailable Checks

- **Pre-change live matrix:** no same-method report was preserved. No live
  before/after speed or quality comparison is claimed.
- **Retry-memory profile:** the strict invalid-model prerequisite did not fail
  promptly or deterministically; it timed out after 120,567 ms with zero tools.
  The required two-run, five-cycle profile was therefore not started. Memory
  classification is unavailable, and no production memory change was made.
- **VS Code UI:** the installed `code` launcher opened Cursor, while no Visual
  Studio Code or Insiders application was installed. A genuine Extension
  Development Host could not be exercised. The compatibility host was stopped
  without sending a provider prompt, and VS Code UI behavior is not classified.

## Non-Findings And Remaining Risks

- No evidence supports a context-performance, provider-speed, memory-leak, or
  VS Code live-surface claim beyond the explicit measurements above.
- The failed advertised GPT-5.6 Sol selection remains a provider/model
  availability limitation; GPT-5.4 was used only as the explicitly recorded
  primary matrix selection, not as silent substitution.
- Startup graph budgets prove emitted-graph composition and bytes, not runtime
  interaction latency or memory behavior.
- The evaluation harness depends on stable provider tool-result contracts. Its
  strict parsers intentionally fail closed when metadata is malformed,
  conflicting, ambiguous, incomplete, or not causally ordered.
- Existing non-target build warnings remain visible and should be investigated
  only with corresponding runtime or packaging evidence.

## Whole-Branch Review

The complete diff from `3c55fbc4` was reviewed after the live fixes and final
builds. Earlier task ranges had independent approval after their reported
findings were fixed. The integration review rechecked the current production
diff, the provider-result and synthetic-card contracts, startup-graph policy,
prompt claim boundaries, docs, and generated asset names.

The initial integration review found no Critical or Important issue. A later
final branch review found the three Important trust/retention issues recorded
above, and the final rereview found the wrapper-carrier Important plus the
producer/consumer coverage Minor. The follow-ups close every finding with
focused RED/GREEN regressions, two fresh pinned live Cursor passes, the actual
runtime-record integration assertion, and the relocated ignored artifacts. No
legacy Tauri file, dependency declaration/lock resolution, release workflow, or
public legacy-prefixed asset was changed; root `package.json` changes remain
limited to the evaluation and bundle-check scripts. Safety scans found no
forbidden upstream reference, destructive fixture Git command, or `shell: true`
spawn in production evaluation code. The production Cursor integration test
now asserts both sides of the provenance boundary: provider collisions are
removed without losing normal metadata, while the runtime-derived card retains
the reserved marker.

## Final Verification

| Check | Result | Evidence |
| --- | --- | --- |
| `node --test scripts/agent-evals/*.test.mjs` | pass | 94/94 |
| Cursor runtime tests | pass | 111/111 |
| Cursor synthetic-patch integration | pass | 58/58 focused web tests |
| `bun run validate:full` | pass | lint/type-check plus 124 script, 107 orchestration, 111 Cursor, 40 Electron, 1,644 UI, 872 web, 93 VS Code, and 12 quota tests |
| `bun run build` | pass | all workspace production builds exited zero |
| `bun run bundle:check` | pass | exact final graphs and budgets shown above; repeated after packaging builds |
| `bun run electron:build` | pass | ARM64 `DevRyan` ZIP/DMG and blockmaps produced; packaged app signature verified |
| `bun run vscode:build` | pass | extension and webview production builds exited zero |
| Syntax/whitespace/safety review | pass | `node --check`, whole-diff `git diff --check`, policy scans, and final fixture manifest |

All final source processes used for live evaluation were stopped. The external
fixture remained exact after validation and packaging, and no run-owned file or
tracked raw evaluation artifact remained.
