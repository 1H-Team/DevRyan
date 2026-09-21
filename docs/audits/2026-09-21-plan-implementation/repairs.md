# Implementation repairs

The requested repairs from the [critical review](implementation-review.md) are
implemented in the existing working tree. Existing user changes remain intact;
no commit, deployment or release was made.

## Changes

| Finding | Repair and focused evidence |
| --- | --- |
| F1 | Observation stops after four unsuccessful passes with `workspace_changing`. Both fresh filesystem stamp and current ledger publication guards remain. Separate fixtures exercise file churn and ledger churn; neither can install a stale base. |
| F2 | Shared preparation exposes actual progress through a shared meter, including copied admission contexts. Joiners retain their cancellation, overall deadline and stall watchdog. Healthy progress, cancellation, timeout and hung-producer fixtures pass. |
| F3 | A synchronous store subscription invalidates pending clicks on session/draft navigation. Completed requests retire; passive protection checks the authoritative selection. Helper and actual-store fixtures cover stale effects, rapid clicks, promotion and draft A → B → A. Protection still precedes explicit session display. |
| F4 | Terminal leases retain durable cleanup work, including older uncleaned records. Poller loss, cancellation and drain settle preparation before cleanup. Claim synchronously fences the poller timer. Recovery preserves living-host consumers and uncertain native receipts. |
| F5 | Keeper initialization remains single-flight, retries only after failed-child reaping, and blocks replacement when termination remains unconfirmed. Independent shutdown owners still drain. The real server shutdown now invokes execution-host drain after Cursor settlement. |
| F6a | Recovery isolates each lease and each cleanup attempt; one missing receipt does not stop unrelated work. Any unresolved failure keeps retention readiness closed. |
| F7 | The deterministic snapshot ref identity commits before ref installation. Cleanup also releases legacy orphan refs by their deterministic identity, tolerating absent refs. A missing native receipt still prevents cleanup. |
| F9 | Required artifact failure keeps server diagnostics available while fencing affected execution with a typed 503. Managed spawn, prompt/command/shell routes, the private bridge and Cursor enforce readiness. Web packaging verifies every declared architecture before staging and verifies the staged copies; paired capability versions and digests remain required. |
| F10 | Cleanup failure no longer replaces the durable publication result. Deferred cleanup is diagnosed and remains discoverable. Read-only private directories can be cleaned after settlement without following symlinks into project/dependency inputs. |
| F12 | A verified older SSH instance can receive signed shutdown independently of version. Update/start waits for confirmed listener absence. Local challenge/signature and manager-ordering fixtures pass. |
| F13 | Both performance tools require the full instance cookie pair. They no longer assume a legacy cookie or derive the listening port from a proxy URL. CLI help and documentation explain the format. |
| Abort before spawn | The companion checks cancellation immediately before spawning and uses the existing independent cancel-before-start acknowledgement. Its pinned patch/source digests and runtime version advance to `1.18.31-devryan.5`. |
| Cursor payload gap | Owned prompt/title inputs freeze before preparation, enforce the 16 MiB UTF-8 preflight bound, and check the exact remapped payload before launch. The worker reader enforces the same cap. Full history is retained; tests cover mutation during preparation and both rejection boundaries. |

Accepted conservative behavior from the review remains: uncertain termination
receipts are protected, ambiguous retention acknowledgements stay held, and
selection failures cannot bypass server protection. No synthetic heartbeat or
uncaptured execution fallback was added.

## Verification

Focused regressions pass for execution admission, changing observations, pin and
cleanup recovery, selection helpers and actual store integration, artifact
readiness, lifecycle admission, SSH, performance authentication and Cursor.

The pinned companion build passed 55 tests, type checking and native dispatcher
acceptance on macOS arm64, including concurrent Revert/Redo, process-tree
cancellation, retention ownership and Cursor publication/cancellation. It uses
disposable fixtures without live provider credentials or installed-app state.

| Check | Result |
| --- | --- |
| `bun run validate:full` | Passed workspace lint, types, documentation and deterministic suites, including all 4,250 server tests across 398 files. |
| `bun run build` | Passed web and Electron builds. |
| `bun run bundle:check` | Passed: 4,808,264 raw bytes and 1,414,689 gzip bytes, below the 4,962,877 / 1,456,388 budgets. |
| `bun run verify:revert-runtime` | Passed current macOS arm64 paired-artifact digest and capability verification. |
| Missing-architecture distribution fixture | Passed the expected rejection: absent declared Intel artifacts stop web packaging before staging. This is not Intel build or execution evidence. |

The first full run caught a Git-fixture timing assumption and an extra shutdown
await when no execution host exists; both were corrected. A tunnel authorization
fixture also returned 404 once. Its 401/403 assertions remain intact, with added
route and cookie-class diagnostics. It passed in the 38-test focused rerun and
the complete server rerun; the cause of that initial 404 was not established.

The documentation validator retains existing historical-document missing-source
and generated-target warnings. `git diff --check` reports only eight single-space
blank context lines inside the companion unified patch; those patch-format lines
are preserved. Command logs are kept locally under
`.cache/agent-handoffs/repair/`.

## Remaining release evidence

Intel native execution and its paired binaries, signed installation/update, real
remote SSH and live-provider acceptance remain platform/release checks. This
machine's arm64 acceptance does not establish those results. The declared Intel
support policy remains intact; missing Intel artifacts block a distributable web
package. Retention stays disabled by default.
