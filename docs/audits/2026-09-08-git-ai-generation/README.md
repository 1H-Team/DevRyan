# Git AI generation verification — 2026-09-08

Working-tree verification against base revision `39271d53d2c20dce8bb7c7d4ea34bad85cbad556`.

## Root cause and correction

The installed runtime journal recorded three commit drafts falling back in 863–943 ms, without retrying. The commit route previously made one direct Zen request under a 20-second overall deadline. The journal sanitizer also discarded its `providerOutcome` field.

A synthetic live probe identified a second failure: standalone free-tier requests returned HTTP 400 with “OpenCode's free tier can only be used in OpenCode.” Production Git generation now uses the native OpenCode provider through temporary no-tools helpers, following the documented [OpenCode session/message/abort APIs](https://opencode.ai/docs/server/). The injected standalone transport remains available for compatibility tests.

Both Git generators prioritize warm catalog models, include cooling models in remaining slots, and try at most three distinct candidates. Failures advance immediately and each attempt gets at most 15 seconds. Native abort/delete cleanup is bounded separately and finishes before another model starts. Commit fallback follows exhaustion or missing catalog data; PRs retain the Builder/session-model fallback. PR HTTP timeout is 150 seconds to accommodate both tiers and cleanup. Internal text helpers are excluded from navigation and completion notifications.

## Live provider check

An isolated OpenCode 1.18.29 process used a disposable workspace and private XDG/config/data paths, without the user's configuration or credentials. Only synthetic source changes were submitted.

| Feature | First attempt | Second attempt | Result |
| --- | --- | --- | --- |
| Commit draft | `nemotron-3.5-lightning-free`, timeout at 15.012 s | `big-pickle`, valid draft in 5.945 s | AI success |
| PR draft | `nemotron-3.5-lightning-free`, timeout at 15.012 s | `big-pickle`, valid draft in 6.376 s | AI success |

No text-helper sessions remained. The owned native process was terminated afterward. This establishes live recovery at verification time, not future provider availability. Local evidence: `.cache/git-generation-verification/native-live.json`.

## UI and journal review

The rebuilt web UI ran in an isolated Electron-hosted Chromium window against the real Express Git routes and a controlled native-provider fixture. GitHub was deliberately disconnected; no commit, push, or PR publication was performed.

All four button-driven checks passed:

- Failed/invalid free models followed by an AI commit subject and body from the third model.
- A local commit draft and explicit warning only after all three attempts failed.
- AI PR title and Markdown body generation.
- Exhausted free and Builder models preserve both PR fields and show a retryable error.

Reviewed all four 1280×800 captures (`commit-ai`, `commit-fallback`, `pr-ai`, `pr-failure-preserved`) in `.cache/qa/web-chat-7uzARm/`. Subjects, details, PR title/body and failure feedback are legible in the source sidebar. The PR success capture still includes the preceding commit-fallback toast. One expected browser console error corresponds to the deliberately failed PR generation; no unexpected renderer exceptions were recorded. Helper session count and cleanup errors were both zero.

The retained journal shows ordered model attempts with duration, sequence, HTTP status and classified `reason`; the journal gap check returned no gaps. Repository-local QA output retains `result.json`, screenshots, attempt receipts and the sanitized journal. This is web/shared-UI verification, not a packaged Electron, signing or updater acceptance claim.

## Automated verification

Focused tests cover rotation, timeout aborts and late replies, native HTTP 200 provider errors, invalid output, cooldown recovery, duplicate models, empty/stale/unavailable catalogs, staged-only scope, both commit routes, PR fallback, helper cleanup, and sanitizer retention. The web/Electron build and startup bundle-budget check passed.

Earlier broad runs exposed a bootstrap timing flake (one extra retry with a 30 ms request budget while building), two unrelated rebase-fixture 5-second timeouts, and a new visibility-test typing error. The bootstrap test passed in isolation; the test typing was corrected before the final gate. The final full validation passed, including the previously timing-sensitive checks, without weakening assertions or increasing their timeouts.


Final gates:

- `bun run validate:full`: passed (exit 0), including workspace lint/types, documentation, script/runtime suites, legacy Cargo contracts, 3,572 shared-UI tests and 3,794 web tests.
- `bun run build`: passed; Electron main was rebundled after the final directory-normalization adjustment.
- `bun run bundle:check`: passed; web-main gzip 1,381,272 bytes against a 1,456,388-byte budget.
- `bun run docs:validate` and `git diff --check`: passed. Documentation warnings concern existing historical/generated references.
- Live native OpenCode commit/PR generation: passed with recovery to the second free model and zero remaining helpers.
- Isolated UI: all four checks passed; screenshots reviewed and journal gap check clean.

No installed DevRyan runtime was stopped or replaced. The disposable native runtime directory was removed after preserving its content-free verification receipt.
