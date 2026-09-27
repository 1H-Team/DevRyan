# Oh My OpenCode Slim 2.2.24 upgrade — September 26, 2026

This upgrade follows [the managed plugin upgrade runbook](../../PLUGIN_UPGRADES.md).

The working tree already contained unrelated uncommitted changes (harness runtime and the browser plugin). None of them are reset, staged or modified here, and neither is the user's running installation.

## Why

A fixer session failed with `apply_patch verification failed: Failed to find expected lines in …`. The model had indented a context hunk 11 spaces where the file had 12. A second rejection, the same day, had the reverse drift (11 where the file had 10).

The rejection came from Slim's pre-native `tool.execute.before` apply-patch hook, as its own log shows (`apply-patch hook verification … failOpen:false`). It did not come from OpenCode.

Slim 2.2.18's primary matcher tries only exact, Unicode and trailing-whitespace comparators. Its hook fails closed, so it blocked patches that OpenCode's native matcher (which also ignores leading whitespace) would have applied. The agents recovered only by re-reading and retrying. The retained Slim logs show 2 rejections and 81 accepted patches over 7 days.

Replaying the original patch against the exact pre-image with each package's real code gives:

| Code | Original patch | Retried patch |
| --- | --- | --- |
| Slim 2.2.18 hook | rejected (identical message) | accepted |
| Slim 2.2.24 hook | accepted | accepted |
| OpenCode 1.18.32 native `apply_patch` | accepted | accepted |

Slim 2.2.24, like OpenCode's native matcher, writes added lines verbatim. An added line with drifted indentation keeps the model's indentation. This was the accepted trade-off.

## Version decision

| Component | Previous | Candidate | Decision |
| --- | --- | --- | --- |
| Oh My OpenCode Slim | 2.2.18 | 2.2.24 | Accepted independent upgrade |

npm `latest` is 2.2.25 (published September 25). It was not reviewed, so it is not selected.

Published integrity, tarball and `dist/index.js` SHA-256 values are recorded in [packages.json](packages.json). The 2.2.18 tarball hash matches the [September 8 audit](../2026-09-08-plugin-upgrades/packages.json). The installed 2.2.18 and 2.2.24 `dist/index.js` files are byte-identical to the published packages.

## Upstream change dispositions

The package ships only a bundled `dist`, so the review compared per-module slices of the two bundles.

| Area | Disposition | Notes |
| --- | --- | --- |
| apply-patch matching | **Adopt** | `trim` and `unicode-trim` join the primary and anchor comparators. Prefix/suffix rescue stays on the first four comparators. Add File bodies keep their final newline, and overlapping chunks are merged. Hook fail-open/closed rules are unchanged: only `outside_workspace` fails open. |
| `absolute-path-rescue` hook | **Adopt** | Applies only to `read`, `list`, `glob` and `grep`, on `filePath`/`path`, and only for missing absolute paths outside the directory. It rewrites to an existing in-project path with a unique suffix. It runs in the host before confined execution maps project paths to the view directory. It never touches `apply_patch`, edit, write or shell. |
| task-session-manager / fallback | **Adopt, with a dormant exception** | The same-provider policy is off by default. The stop confirmation became an unref'd terminal gate. Explicit unknown `task_id`s are now rejected. `prompt`/`promptAsync` callers stay capability-gated, so DevRyan's managed context still blocks them. **Exception:** `ForegroundFallbackManager.promoteForegroundWaiter` posts to `/experimental/session/{id}/background`, which the pinned runtime serves. It bypasses the managed context. It runs only when fallback is enabled and an agent has a chain (array `model`, or a council seat with several `models`); the same path also aborts the child session. DevRyan's managed overlay now writes `fallback.enabled: false`, which makes the manager's event handler a no-op (adapter bytes unchanged). A project `.opencode/oh-my-opencode-slim.json(c)` containing any `fallback` object still re-enables it. |
| background-job persistence / global store | **Already covered** | Persistence is enabled only by the v2 `setup` path, which DevRyan's adapter does not invoke. The global store stays in memory. |
| TUI snapshot | **Defer (monitor)** | Each child `session.created` synchronously records its parent in `$XDG_DATA_HOME/opencode/storage/oh-my-opencode-slim/<dir-hash>/tui-state.json`, and these entries are never pruned. That is about 70 bytes per child session. It is not material at current session counts. Measure under multi-session load before raising it upstream. |
| Descriptor / v2 admissions | **Already covered** | The default export is still `{ id, server, setup }`. jsdom now loads lazily. Internal admissions are an in-memory map capped at 4096 entries. |
| Configuration schema | **Already covered** | The repository `user-profile/oh-my-opencode-slim.json` and the installer defaults validate against both schemas. New optional keys are `backgroundJobs`, `orchestratorWake`, `fallback` retry delays and per-agent `skills_*`. `multiplexer.zellij_pane_mode` was removed and is stripped at runtime. |
| Agents / prompts | **Already covered; one deferred** | The config hook still injects agents through `config.agent`, and the adapter restores DevRyan's retained agent object and default agent in place. **Deferred:** Slim's new council compaction exception may be worth a separate review of DevRyan's own `council.md`. |
| Injected content | **Already covered** | The phase-reminder metadata key is unchanged, so the adapter still strips it. The only new injected part is the Slim-owned board notice for Slim-tracked jobs. |
| Bundled skills | **Adopt** | `deepwork` wording and example model names changed. Existing skill synchronization preserves customized copies. |
| Dependencies | **Adopt** | `zod` becomes a runtime dependency, and jsdom 30 loads lazily. `@opencode-ai/plugin` 1.18.32 matches the profile pin. Provisioning still installs with `--ignore-scripts`. |
| Multiplexer / TUI / CLI | **Already covered** | Multiplexer code moved out of the server bundle. The tool-loop guard now caps repeated waiting tools per turn. |

The DevRyan adapter bytes are unchanged. Its descriptor, retained-agent and phase-reminder contracts hold for 2.2.24.

## Duplicate-output qualification

The active duplicate-output profiles pin the adapter's bytes (`devryan-oh-my-opencode-slim.mjs`), not Slim's `dist/index.js`. They keep matching mechanically, even though their live evidence was recorded with Slim 2.2.18. Requalifying those routes needs separately authorized live provider runs, and they were not run for this upgrade.

## Verification record

- **Focused web Vitest: 6 files, 96 tests passed.** Covers managed plugins, default plugins, user-profile provisioning (including an idempotent 2.2.18 → 2.2.24 upgrade), the Slim config/installer and the adapter.
- **Real-package checker** (`scripts/qa/plugin-upgrades.mjs`, disposable profile, no provider requests):
  - Installed 2.2.24 preserves host agent models, variants, prompts, permissions and disabled MCPs.
  - Its apply-patch hook accepts leading-indent context drift and still rejects missing context.
  - As a control, the same check fails on 2.2.18 with the incident's exact message.
- **`bun run validate:full`: lint and type checks passed; 4360 of 4361 tests passed.** The one failure is the pin in the duplicate-output qualification test for `devryan-browser.mjs`. That file had concurrent uncommitted edits that this upgrade did not touch. Once those edits were withdrawn, the test file passed on re-run (9/9).
- `bun run build` passed, and `bun run bundle:check` passed within its budgets. `bun run docs:validate` passed.
- **Not run:** isolated live smoke with a provider-backed fixer session, and live duplicate-route requalification. Both need separately authorized provider runs.
