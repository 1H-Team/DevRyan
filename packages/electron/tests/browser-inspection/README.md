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
