# Validation results

Final verification ran against the shared working tree on 2026-09-08. Other repository work was present; no unrelated source or assertions were changed to make the gate pass.

| Check | Result |
| --- | --- |
| `bun run validate:full` | Failed in script tests after lint, type checks and documentation validation passed. Two QA timing assertions failed; their combined isolated rerun passed. |
| Complete script-suite rerun | 585 passed, 1 failed. `scripts/agent-evals/client.test.mjs`, “completes terminal inspect and repair turns when orchestration is unavailable and empty”, exceeded its 200 ms deadline. Exact isolated rerun: 1 passed. |
| `bun run test:visual-fixture` | 2 passed. |
| Complete workspace package suites | All package commands passed except web; see below. |
| Harness runtime | 194 passed, 0 failed, including storage/scale/restore and new attribution tests. |
| UI | Package command passed, including isolated component/store/API tests and 3,577 tests in its final shared batch. |
| Electron | 309 passed, 0 failed. |
| Cursor, shared runtime, orchestration, legacy desktop and all Bot packages | Package commands passed. |
| Web | 3,854 passed, 5 failed across 368 files. All five failures are in `server/lib/opencode/runtime-agent-overlays.test.js`. Session-changes plugin and SSE watcher tests passed. |
| `bun run build` | Passed. |
| Electron web-asset build/staging | Passed; completed before the accepted QA journeys. |
| `bun run bundle:check` | Passed. |
| Isolated web and Electron session-changes QA | Both passed: 24 checks and 37 individually reviewed screenshots each. |
| Final documentation validation and whitespace check | Passed. |

The five web failures compare runtime permission overlays with exact expected maps. The actual maps additionally include the canonical repository and its derived OpenCode worktree container. The affected cases cover packaged skill overlays, directory switching, project-agent skill permissions, exact skill overlays, and process-wide data permissions. They do not exercise receipt attribution. Their assertions were left intact.

The full validation gate remains failed. Passing targeted retries is recorded as diagnostic evidence, not as a successful full run. Live model providers, physical mobile devices, signed packages, Docker and installed-app verification were not run.

Local command logs are retained under `.cache/`: `session-changes-validation-isolated.log`, `session-changes-timing-retry.log`, `session-changes-scripts-final.log`, `session-changes-eval-timing-retry.log`, `session-changes-workspace-final.log`, `session-changes-build-final.log`, `session-changes-stage-verified.log`, `session-changes-bundle-final.log`, and `session-changes-docs-final.log`. The accepted QA source directories are `qa/web-session-changes-zqz5y3` and `qa/electron-session-changes-5LGle7` beneath that directory. The durable visual evidence is linked in [the audit](README.md).
