# Session change recovery verification

The working-tree implementation replaces session-wide recoverable capture errors
with call-scoped evidence, accepts stronger completion and mode evidence without
discarding historical revisions, and records complete native Cursor task diffs
through a private acknowledged outbox before preview truncation. Pending summaries
retain files and retry while subscribed; settled failures use specific messages.
Verified descendant contributions survive deletion of an intermediate child.

The contract is documented in [Session change summaries](../../SESSION_CHANGES.md).
[The manifest](manifest.json) records feature-source and web-build hashes. Other
working-tree changes were present during validation.

## Deterministic checks

Workspace lint, type checks, documentation validation, `bun run build`, Electron
web-asset staging, and `bun run bundle:check` passed. The startup bundle was
1,384,660 bytes compressed against a 1,456,388-byte budget.

All new recovery regressions passed, covering late and historical receipt repair,
stronger completion and executable modes, stale delivery, genuine conflicts,
immutable revisions, ancestor notification, deleted intermediate descendants,
native read-only tasks, interrupted/replayed settlement, unsupported nested
execution, asynchronous ingestion, and stale restore rejection. Cursor's 133-test
suite passed, including full diffs across direct, one-shot, and persistent-worker
execution. The new card, parser, and subscription retry tests also passed.

The full repository gate did **not** pass. Two script-suite timing failures passed
on a separate 36-test rerun. A harness capture-limit timeout passed when rerun
alone. The UI JSX-copy scan continued to exceed its five-second limit. The web
suite reported timing failures, directory-permission expectation failures and
three worker-startup errors; the worker files subsequently ran. The two Cursor
web event-ordering failures also reproduced against an archived, unchanged HEAD
runtime. Assertions and timeouts were preserved. [Package results](package-tests.json)
record the original package exits rather than treating retries as a clean full run.

## Reviewed web states

Both isolated web attempts passed the new recovery and native-evidence checks:
the late exact receipt cleared its error without reload, and 28 native file edits
survived the 24-row activity preview. The last native patch retained its complete
6,800-character added line. A delayed private settlement, without a UI refresh
event, was discovered by subscription backoff. Unsafe Undo remained disabled.

- [Before recovery](web-before-recovery.png) retains the verified file and offers Retry.
- [After recovery](web-after-recovery.png) shows both files without the error.
- [Native pending](web-native-pending.png) retains all 28 files while loading.
- [Native settled](web-native-settled.png) clears loading without a coverage warning.
- [Narrow error state](web-mobile-evidence-error.png) keeps the known file and readable, specific evidence error.

These original PNGs were individually inspected. All ten original screenshots
from the second web attempt were inspected, including its failure state. The
full theme/width journey remains incomplete: one run timed out during mobile
Undo, and another while waiting for an existing card to load. There were no
recorded console errors or journal gaps. [Web QA evidence](web-qa.json) retains
the failed overall outcome.

## Electron and scope

Electron deterministic tests passed (309 tests). Isolated native QA encountered
a Git-fixture preparation failure and startup selection timeouts. The runner now
uses the shared stable pointer helper and an explicit initial CSS viewport; its
four helper/runner tests passed. A final attempt exceeded Electron’s loopback
startup deadline, and direct inspection of the retained window also timed out.
[Automated evidence](electron-result.json) and [direct inspection evidence](electron-manual-native-result.json)
retain these failures. Native end-to-end acceptance is not established. The
recorded journals had no gaps, but they do not establish a successful native journey.

This verification uses disposable fixture data and the shared production
web/Electron host. No live provider run, installed-app update, or deployment was
performed. The original reported session was not identified in retained incident
evidence; unrecoverable execution gaps still remain explicit.
