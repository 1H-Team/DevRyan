# Real Chromium browser inspection acceptance

From the repository root:

```bash
node packages/electron/tests/browser-inspection/run.mjs
```

The runner starts the pinned workspace Electron binary with a private temporary
profile under `.cache/browser-inspect/`, an in-memory browser partition, denied
permissions, blocked network requests, and a local `data:` tooltip fixture. It
does not load DevRyan's main process, OpenCode, user configuration, or journal.
It deletes its profile and evidence file after printing sanitized JSON results.
A missing Electron binary or unavailable desktop session fails explicitly.

The fixture executes the production browser plugin's generated inspection script
and result parser against Chromium. It covers a present and dismissed tooltip,
computed animation/transition durations, custom CSS properties, absent
attributes, repeated missing results, ambiguous matches, invalid CSS selectors,
and quoted/backslash-containing selector values. It reproduces the original
`getComputedStyle(null)` failure once to establish the regression scenario.

This explicit desktop acceptance command is separate from the platform-neutral
`*.test.*` gate; plugin tests cover lease transport, cancellation, output limits,
and error classification. No fixture source or profile is packaged for release.

## agent-browser 0.38.1 acceptance

The opt-in `upgrade-install.mjs` uses the real npm registry and pinned FFmpeg
release downloads. Stage an isolated `.cache/browser-upgrade/baseline` package
with `agent-browser` exactly `0.33.2` using `bun install --ignore-scripts` first
(no workspace dependency change). Then run:

```bash
node packages/electron/tests/browser-inspection/upgrade-install.mjs /absolute/path/to/bun
node packages/electron/tests/browser-inspection/upgrade-run.mjs /absolute/repository-local/install/root
node packages/electron/tests/browser-inspection/upgrade-run.mjs .cache/browser-upgrade/baseline
```

Use the `installRoot` printed by the installer fixture for the second command.
Installation covers fresh/ensure/repair/upgrade, every published platform filename,
and direct native `--version` with no Node executable on PATH. Only the current
host binary is executed. Runtime acceptance currently requires macOS and its
verified, built native confinement launcher under `packages/web/runtime`.

`upgrade-main.mjs` loads the actual plugin, surface manager, bridge and native
CLI against a deterministic loopback page, with an ephemeral partition and
private repository-local home. It starts hidden, denies external page requests,
and covers core commands, stable/invalidation refs, delta refresh, conditional
screenshots, human clicks/drags, navigation during WebM/MP4 recording, cursor and
contact sheets, simultaneous observation and capture detach. `upgrade-worker.mjs`
executes real bounded sequences under the production native supervisor/profile,
including cooperative cancellation and a denied write outside the private view.
The fixture keeps a test-only scoped loopback lease endpoint; it does not claim
live OpenCode/provider or production file-publication acceptance.

The runner reuses QA process ownership tracking and verifies no descendant needs
rescue termination, fully decodes all four videos with managed FFmpeg, and keeps
results/screenshots/videos/contact sheets/termination receipts under
`.cache/browser-upgrade/acceptance-*`. It never starts the installed DevRyan app.
Hard termination before cooperative cleanup can leave an incomplete recording;
the process supervisor still terminates descendants. This fixture is source
Electron acceptance, separate from signed release-package checks.
