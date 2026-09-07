# Plan recovery, dispatch status, and subtask titles

Verified 2026-09-06 against the working tree based on `0ab667b8c80488b59895268ad9e4bca3e310797f`.

## Changes

- A recognized synthetic provider-recovery wake continues the existing planning revision. Its final marked plan produces one saved, actionable card; ordinary maintenance and later human/implementation turns do not inherit that intent.
- Dispatch rows resolve the latest same-child recovery attempt through the live task index, even after early attempts have been pruned. Status, model, subtask navigation, and recovery actions use that attempt.
- Exact generic managed child titles enter the existing title pipeline. Known runtime preambles are excluded from the title input, custom names remain protected, and late generic snapshots cannot overwrite a meaningful title.

The reported host journals were inspected before implementation. They showed the recovery wake before the missing plan, retained-attempt pruning behind the stale dispatch error, and generic child titles accompanied by usable task briefs. The journal gap check reported no gaps. Private host journal content is not included here.

## Visual acceptance

Both actual UI journeys passed all 11 checks with no browser console errors or cleanup errors. Every captured PNG was manually inspected after each completed run: 13 web images and 12 Electron images. The result summaries record that review separately from automated assertions.

| Check | Web | Electron |
| --- | --- | --- |
| Genuine failure remains visible before recovery | [Failure](web/recovery-failed.png) | [Failure](electron/recovery-failed.png) |
| Sixth attempt shows its current model and running state | [Running](web/recovery-running-live.png) | [Running](electron/recovery-running-live.png) |
| Pruned attempts do not restore the old error after reload | [Reload](web/recovery-running-reload.png) | [Reload](electron/recovery-running-reload.png) |
| Open Subtask opens the canonical child | [Child](web/recovery-child.png) | [Child](electron/recovery-child.png) |
| Recovered plan is saved with an enabled action | [Plan](web/recovery-plan-saved.png) | [Plan](electron/recovery-plan-saved.png) |
| Expanded plan contains the complete content | [Expanded](web/recovery-plan-expanded.png) | [Expanded](electron/recovery-plan-expanded.png) |
| Completed dispatch survives reload | [Completed](web/recovery-completed-reload.png) | [Completed](electron/recovery-completed-reload.png) |
| Narrow layouts keep plan and dispatch usable | [Plan](web/recovery-narrow-plan.png), [dispatch](web/recovery-narrow-dispatch.png) | [Plan](electron/recovery-narrow-plan.png), [dispatch](electron/recovery-narrow-dispatch.png) |
| Explorer title summarizes the task and survives reload | [Explorer](web/recovery-explorer-title.png) | [Explorer](electron/recovery-explorer-title.png) |
| Designer title summarizes the task and survives reload | [Designer](web/recovery-designer-title.png) | [Designer](electron/recovery-designer-title.png) |

The scenario also compares the persisted Markdown bytes with the complete expected plan, requires exactly one saved revision, checks title persistence through canonical session reads, and runs the ordinary composer send/cancel/reconnect smoke checks. Web covers a 390×844 mobile viewport and the [saved-file panel](web/recovery-mobile-saved-file.png). Electron covers a 600×844 narrow desktop viewport.

Summaries: [web](web/result-summary.json), [Electron](electron/result-summary.json).

Earlier iterations exposed an obsolete staged Electron bundle and a late generic-title snapshot overwriting the new title. The staging guard and title merge were corrected before these successful runs. Capture timing and mobile panel handling were also corrected so screenshots show the asserted controls.

## Reproduction and limits

Final validation passed: `bun run build`, `bun run type-check`, `bun run lint`, `bun run test:full`, and `git diff --check`. The full suite includes 3,490 passing UI tests and 3,662 passing web tests. An earlier full run hit evaluator timeout failures while builds and both UI journeys were running concurrently; the final full run passed after those jobs finished.

Follow the build and Electron asset-staging recipe in [QA.md](../../QA.md), then run:

```sh
DEVRYAN_QA_SCENARIO=recovery bun run qa
DEVRYAN_QA_RUNTIME=electron DEVRYAN_QA_SCENARIO=recovery bun run qa
```

These runs use deterministic canonical HTTP/SSE replay and a scoped managed-task snapshot fixture. They exercise the actual UI, web host, persistence, and Electron development shell. They do not execute a live provider recovery or scheduler, test a physical mobile device, or certify a packaged release. The user's active sessions and model preferences were not changed.
