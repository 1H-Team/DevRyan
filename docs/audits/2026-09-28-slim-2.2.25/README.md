# Oh My OpenCode Slim 2.2.25 upgrade and specialist routing restoration — September 28, 2026

This upgrade follows [the managed plugin upgrade runbook](../../PLUGIN_UPGRADES.md). It shipped together with the Orchestrator routing restoration described below, because both came from the same report.

## Why

The user reported that Orchestrator-primary sessions dispatched only `explorer`. Coding and bug-fix work no longer went to `fixer`, visual work to `designer`, or online lookups to `librarian`.

The cause was DevRyan's own packaged `orchestrator.md`, not Slim. DevRyan's Slim adapter removes Slim's agent prompts and its system transform, so the packaged prompt is the only routing policy in force.

- **v1.2.15** ([simple-task latency audit](../2026-09-25-simple-task-latency.md)) replaced the Fixer-default and Designer-ownership rules with "direct work is the default for small coherent tasks". Its own live runs show zero children for bug-fix and visual-tweak cases.
- **v1.2.17** added Explorer-first discovery. Explorer grounded the location, then the direct-first default made Orchestrator implement everything itself.

The managed-task ledger shows the drop: 97 Fixer and 28 Designer tasks from September 7 to 19, against 2 and 1 from September 20 to 26.

A user-owned plugin (`ponytail`, full mode, installed September 21) appends a "lazy senior developer, code first" ruleset to every system prompt, and so reinforced direct work. It remains installed. Orchestrator now states that appended coding-style guidance governs how the implementing agent writes code, never who implements.

## Routing decision (user-confirmed)

- **Specialist-owned implementation:**
  - `fixer` owns non-design code, bug fixes, tests and backend/config work.
  - `designer` owns every visual or UX change, including fully specified tweaks and approved plans.
  - `librarian` owns current external documentation.
  - Orchestrator implements directly only a trivial one-file edit, Oracle-closeout remediation, or work the user declined to delegate.
- **Kept unchanged:**
  - Explorer-first discovery (2026-09-27).
  - The behavior-under-unchanged-presentation exclusion that keeps Designer off non-visual work (2026-09-09).
  - The closed-scope Fixer gate.
  - Oracle gates.
  - Plan mode stays read-only: Explorer, plus Librarian when external facts matter. The runtime rejects Designer there. Plan approval preserves specialist ownership.

This is prompt policy only. No dispatch gate, cap, or throttle was added.

## Version decision

| Component | Previous | Candidate | Decision |
| --- | --- | --- | --- |
| Oh My OpenCode Slim | 2.2.24 | 2.2.25 | Accepted independent upgrade |

npm `latest` is 2.2.25 (published September 25). `3.0.0-beta.*` and the unreleased `master` were not reviewed. Published integrity, tarball and `dist/index.js` SHA-256 values are in [packages.json](packages.json). The installed 2.2.24 `dist/index.js` is byte-identical to the published package. Runtime dependencies are unchanged between the two versions.

## Upstream change dispositions

| Area | Disposition | Notes |
| --- | --- | --- |
| Agent prompts / delegation text | **Already covered** | The orchestrator and specialist prompt sections are byte-identical to 2.2.24. The adapter still removes `agent` and `experimental.chat.system.transform`, and still restores DevRyan's agents and default agent in place. |
| `apply_patch` rewrite | **Adopt** | Rescue matching is always on and destructive moves are blocked. The real-package checker still accepts leading-indent context drift and still rejects missing context with the same `apply_patch verification failed: Failed to find expected lines` message. |
| `post-file-tool-nudge` removal, compaction reminder strip | **Adopt** | Fewer injected phase reminders. The phase-reminder metadata key (`oh-my-opencode-slim.phaseReminder`) is unchanged, so the adapter keeps stripping it. The reminder instructs `task(...)`, which is denied for Orchestrator. |
| `task_reply` tool, `backgroundJobs.childInputWake` | **Already covered** | Both resolve only Slim background-board jobs created through Slim's `task` tool. Orchestrator's `task` is denied, and `devryan_task` children never enter that board. The managed context still hides `prompt`/`promptAsync`, so Slim cannot submit a wake. The health-check baseline rises from 9 to 10 tools. |
| Foreground fallback fixes | **Already covered** | `ForegroundFallbackManager.handleEvent` still returns early when disabled. The managed overlay keeps writing `fallback.enabled: false`. |
| `model` chain with `inheritModelFrom` | **Already covered** | DevRyan does not configure agent model chains. |
| `smartfetch` / `webfetch` security fixes | **Adopt** | Used by Librarian through Slim's `webfetch` tool. |
| Multiplexer `cmux` → `cmux-tui` | **Not used** | Neither the repository profile nor the personal Slim config sets `multiplexer`. |
| Configuration schema | **Already covered** | New optional keys only. The repository profile schema URL moves to 2.2.25. |

The DevRyan adapter bytes are unchanged, so duplicate-output profiles keep matching mechanically. Requalifying them is a separate decision.

## Verification record

- **Focused web Vitest: all passed.**
  - Agent prompt contracts: 8 files, 115 tests.
  - Managed plugins, default plugins, user-profile provisioning (including an idempotent 2.2.24 → 2.2.25 upgrade), Slim config/installer and adapter: 24 files, 604 tests.
- **Evaluation harness** (`node --test scripts/agent-evals/*.test.mjs`): 131 tests passed. The routing cases now expect:
  - `fixer` for a natural bug fix
  - `designer` for a natural visual change
  - `librarian` for a new external-documentation case
- **Real-package checker** (`scripts/qa/plugin-upgrades.mjs`, disposable `.cache` profile, no provider requests): passed on 2.2.25 with synthetic settings and again with sanitized personal agent models and variants.
- **Full gate on the exact release content**, in an isolated worktree with none of the concurrent session's edits:
  - `bun run validate:full` passed, including the web suite (418 files, 4635 tests) and the legacy Tauri cargo tests. The ignored sidecar and `web-dist` artifacts were copied from the main checkout for this step.
  - `bun run build` and `bun run bundle:check` passed.

## Live verification (real providers, isolated `web-verify` host)

The host ran on port 3101 with data directory `~/.config/openchamber-verify` and Slim 2.2.25 provisioned; its health check reported 10 tools. Test projects were disposable repositories under `.cache/routing-live/`. Orchestrator ran GPT-6 Astra (medium) and specialists ran on the user's configured models. No live run edited source from the root session.

**Ad-hoc prompts** (agent names never appear in the prompts):

| Case | Mode | Dispatched | Runs |
| --- | --- | --- | --- |
| Named-file bug fix and regression test | normal | Fixer | 2/2 |
| Specified visual tweak | normal | Designer | 3/3 |
| Unknown-location bug | normal | Explorer, then Fixer | 2/2 |
| Current Node.js docs question | normal | Librarian | 2/2 |
| Mixed button (UI) and `clearCart` (behavior) | normal | Fixer and Designer | 3/3 |
| Intl date formatting per MDN | real Plan mode, then "implement plan" | Explorer and Librarian, then Fixer | 2/2 |
| Primary-button restyle | Plan toggle in the browser UI, then the Implement Plan button | Explorer, then Designer | 1/1 |
| Responsive redesign | normal | Designer | 1/1 routed |

The redesign was routed correctly and Designer edited the files, but the run hit the 45-minute driver timeout while Designer retried a browser check outside the workspace.

**`bun run agent:eval`**: 9 routing cases × 2 repetitions. 16 of 18 runs passed on the first grader. Both failures were `routing-substantial-design`, where Orchestrator sent a second Designer task to restore the specified 24px mobile row gap. The grader now accepts that same-owner review remediation for unprompted cases. A rerun under the updated grader passed 2 of 2 with 10 of 10 graders, and fixture restoration was exact. The journal gap check on the verify host was clean.

**Found during verification:**
- **Claude transport working-directory leak.** The confined Claude transport kept a working directory from another project's state bucket. Claude-backed Designer children given only relative paths sometimes targeted that project, and the confinement rejected the writes. Orchestrator briefs now name files by absolute workspace path, which removed the re-dispatches in reruns. The transport root cause is tracked separately.
- **Headless permission stalls.** Headless runs stall on `external_directory` prompts that no one answers. Those prompts were rejected during testing.
