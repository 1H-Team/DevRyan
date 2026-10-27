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

## agent-browser 0.39.2 acceptance

The opt-in installer uses the real npm registry and pinned FFmpeg downloads. It
stages its own 0.38.1 baseline and returns a private `installRoot`:

```bash
node packages/electron/tests/browser-inspection/upgrade-install.mjs /absolute/path/to/bun
node packages/electron/tests/browser-inspection/upgrade-run.mjs /absolute/installRoot --keep-artifacts
bun scripts/build-native-runtime.mjs --output-root .cache/browser-upgrade-native
bun run --cwd packages/electron build:web-assets
bun scripts/qa/browser-live.mjs "$PWD/.cache/browser-upgrade-native" /absolute/installRoot --keep-artifacts
```

Install checks include fresh/ensure/repair/upgrade, every published platform
filename, and native `--version` without Node on PATH. Only the host binary is
executed. Runtime acceptance requires macOS and its verified confinement launcher
under `packages/web/runtime`.

The CLI fixture uses the actual plugin, surface manager, bridge and native CLI
against a deterministic loopback page. It covers core commands, refs, delta
snapshots, conditional screenshots, human clicks/drags, a blue click pulse at the
dispatched coordinates, pulse expiry, navigation recovery, hidden/disabled click
failures, WebM/MP4 recording and contact sheets, concurrent observation, capture
detach, confinement, cancellation, reconnect and persistent pathless screenshots.
It checks descendant cleanup and fully decodes the recorded videos. A real
Chromium web viewer consumes the production observation stream and verifies
click feedback, cross-owner rejection, and lease survival after closing a view.

The full UI runner uses a private native runtime and a deterministic HTTP model
fixture that calls the real browser tool. It checks the activity dot, no automatic
panel opening, direct click-to-view, unrelated-chat isolation, close/reopen,
resize, click feedback, cleanup after completion, and a gap-free session journal.
Renderer screenshots capture the app chrome; `native-click.png` separately
captures the native child view, which CDP's renderer screenshot excludes.
This is not paid-provider, authenticated remote-web, or signed release-package
qualification.

Runs use the OS temporary QA directory and clean up on every outcome unless
`--keep-artifacts` or `DEVRYAN_KEEP_ARTIFACTS=1` is set. The install directory is a
deliverable retained on success for subsequent runs; remove that owned directory
when finished. Native build artifacts stay repository-local for bundle admission.
Retained acceptance evidence includes `result.json`, screenshots, videos, contact
sheets and process cleanup receipts. No test changes the installed app or profile.
