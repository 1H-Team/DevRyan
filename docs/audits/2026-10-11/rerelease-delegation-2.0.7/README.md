# v2.0.7 delegation release verification

## Admission and helper replacement preflight

The subsequent replacement includes the second repair recorded in [the attended audit](../live-agent-qa.md): native-supported read-only permissions, bounded admission/catalog cancellation, tool-free helper registration and reduced repeated session-registration locking. Fresh `bun run validate:full`, `bun run build`, `bun run bundle:check`, documentation validation and `git diff --check` passed. Bundle sizes are 4,891,608 raw and 1,442,816 gzip bytes, within their existing budgets. No migration file is modified or untracked. Hosted migration deployment, history/schema checks, signed-image topology, packaged runtime checks and asset digest verification remain required in the new tag-triggered release run before publication. Live provider and attended acceptance remain deferred.

The replaced commit remains recoverable through the local `backup/v2.0.7-before-admission-rerelease-20261011` branch; it is removed from the published `main` ancestry by replacing only its tip. Earlier checks below describe the preceding replacement and are not fresh packaged evidence for this repair.

This replacement preserves the prior v2.0.7 changes and adds the current native Cursor delegation repair. The requested commit message is `release v2.0.7`, tag `v2.0.7`, title `DevRyanv2.0.7`, and public asset allowlist is exactly `DevRyan-2.0.7-arm64.dmg`.

Full validation passed workspace lint, type checks, documentation validation and all deterministic suites, including 4,103 UI tests and the final 14 native web fixtures. The first run stopped in the unchanged offline importer timeout fixture because its owned PID file was not written before the deadline. Its isolated three-case check and the full rerun passed; no timeout or assertion was weakened.

Production web/Electron build, Electron web staging, bundle budgets and fresh native compilation passed. Web-main gzip is 1,442,821 bytes against a 1,456,388-byte budget; existing dependency annotation, eval and chunk warnings remain.

[Web QA](qa-web.json) and [Electron QA](qa-electron.json) passed all seven chat checks each, with no unexpected renderer errors or cleanup failures. Both screenshots were inspected; sidebar, transcript and composer fit. Deliberate fixture cancellation/reconnection is expected.

[Compiled native qualification](native-qualification.json) passed all 52 cases, with no remaining mandatory gates, source changes or cleanup failures. These checks use private fixture profiles and no live provider or installed application data.

No migration files are modified or untracked; the hosted migration workflow checks and applies any pending migrations before the recreated release tag is pushed. Release CI retains signed Bot image, anonymous access, topology, packaged native runtime, migration history/schema marker and exact asset digest gates. Published results are authoritative in the [release workflow](https://github.com/1H-Team/DevRyan/actions/workflows/release.yml) and [v2.0.7 release](https://github.com/1H-Team/DevRyan/releases/tag/v2.0.7).

Cache report and prune preview completed at 35.26 GiB against the 50 GiB budget. No worktree, downloaded CI artifact or installed-app change was made.

Live provider execution, installed-app replacement and attended Cursor account acceptance remain deferred as recorded in [the implementation audit](../live-agent-qa.md). Actual account availability of Haiku Medium is unverified. This release uses existing macOS ad-hoc signing without notarization and does not publish Windows assets.
