# Native skill loading verification

Date: 2026-09-25. Candidate: DevRyan companion 2.1.1, pinned OpenCode 1.18.32,
macOS arm64. Runtime identity and native-acceptance result: [companion.json](companion.json).

## Incident evidence and fix

Four retained local skill calls took 12,007–16,089 ms. Correlated workspace
preparation took 4,550–8,355 ms; completed events reached the journal 2–4 ms
later. The full journal gap scan found no gaps. These timings identify real
execution overhead, not a delayed UI label; they do not separately account for
every remaining millisecond.

The native skill tool only retrieves Markdown, checks permission and lists
support files. It now uses direct receipts alongside the other audited readers,
without a private workspace or worker. Selection remains by built-in object
identity. Custom skill tools and subsequent script commands remain confined.
The selected Markdown is reread after permission so explicit reloads see edits;
a changed frontmatter name fails closed. The existing fallback switches,
permission hooks, cancellation and Revert generation fences remain in force.

## Matched local measurements

[Raw measurements](latency.json) contain six consecutive calls per arm and
fixture; warm medians exclude the first call. Arms use the saved original
companion and candidate with the same current host, deterministic loopback model,
private homes/ledgers and copies of the same committed repository. Arm order is
reversed on the larger fixture. Other verification processes were running on the
machine, so these are descriptive local timings, not an unloaded hardware or
live-provider benchmark.

| Fixture | Baseline warm median | Candidate warm median | Reduction |
| --- | ---: | ---: | ---: |
| Small | 3,091 ms | 193 ms | 93.8% |
| Repository-sized | 8,953 ms | 185 ms | 97.9% |

The larger baseline's first call took 150,438 ms; the candidate's took 263 ms.
That first-call difference includes initial ledger/workspace setup and is not
part of the warm comparison. Every candidate skill used exactly `direct-admit`
and `direct-finish`, retained an empty-file ownership receipt, returned full
content and support paths, and produced no worker trace. Both fixtures exceeded
the 80% warm-median target.

Reproduce with `node scripts/perf/skill-loading-benchmark.mjs --baseline <original-binary> --candidate <candidate-binary> --launcher <native-launcher> --out <report.json>`.

## Validation

- Companion typecheck and 95 pinned-runtime tests passed, including fresh-content
  reload, permission denial, missing skills, custom-tool shadowing, fallback,
  completion retry and cancellation/Revert fences.
- Seven host tests passed for direct admission/receipts, canonical identities,
  writer rejection, fallback and cancellation/Revert failures.
- Real native acceptance passed for global, project, tilde, symlink and URL skills,
  consecutive calls, owned receipts, concurrent Revert, descendants and Cursor.
- Application build, bundle budgets and runtime artifact verification passed.
- Web and freshly packaged Electron acceptance passed: the actual native skill
  call displays Learning Skill while its completion receipt is deliberately held,
  then clears that status and displays the completed result when released.
  The held duration is test synchronization, not a latency measurement.
- Full validation passed lint/type checks and all suites preceding web, including
  3,819 UI tests. Web finished with 4,333 passed and five failures in the unchanged
  runtime-agent-overlay permission fixtures. Those fixtures walk parent directories
  directly, so repository-local temporary projects inherit the DevRyan Git marker
  even with Git's discovery ceiling. All seven new host tests passed within that run.
  A normal `/tmp` web-suite rerun is pending authorization under the repository path
  boundary; the full gate is not reported as passed.

The initial full-gate attempt failed three existing release fixtures because
repository-local temporary files inherited the repository's ESM package type.
A private CommonJS temporary root restored their normal execution environment;
all three passed before the full-gate rerun. That rerun exposed the related Git
boundary: a non-Git fixture could discover the parent checkout, so the run was
stopped and restarted with `GIT_CEILING_DIRECTORIES` set to the same private
`TMPDIR` (`.cache/skill-test-tmp`). The non-Git fixture passed with that boundary.
No production logic or test assertions were changed for these environment fixes.
An initial UI attempt caught a
variable-name collision in the new QA helper before UI execution; it was corrected
and syntax-checked before rerunning acceptance.

Verification uses no user prompts, credentials or installed-app state. Signing,
notarization, update installation, other platforms and live-provider latency are
outside this local acceptance.

## Visual review

All six generated captures were inspected: web/Electron Revert, then skill loading
and completion. The Revert captures show the restored composer and success toast;
the skill captures show the correct selected session, loading status, completed
skill row and final response. No stale Learning Skill status remains after
completion. Layout is intact at the tested desktop sizes; mobile was not retested.

Retained captures: [web loading](skill-web-loading.png),
[web complete](skill-web-completed.png),
[packaged Electron loading](skill-electron-loading.png),
[packaged Electron complete](skill-electron-completed.png).
[Package identity](package-identity.json) records the freshly bundled shell and
native smoke results. This is a local unsigned QA package, not release signing
or installed-app acceptance.
