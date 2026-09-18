# Blank desktop window: renderer exit recovery

## Incident evidence

The installed DevRyan 1.2.6 native log records the main window's renderer exiting
at local log time `2026-09-18 13:47:55.392`, with `reason: clean-exit` and
`exitCode: 0`. The window remained alive and blank. Subsequent native runtime
samples and journal heartbeats continued. The diagnostic journal gap check
reported no gaps. Native logs were read with the user's explicit authorization.

The prior main-process handler only logged `render-process-gone`. It never
restored the renderer or offered a native recovery action. The event explains the
blank window and its persistence, but the available evidence does not establish
what initiated the clean exit. It does not establish renderer heap exhaustion.
A working installed-app window was subsequently observed with its sidebar,
composer, and source panel rendered; no runtime restart was performed by this task.

## Change

The per-window recovery controller handles unexpected exits, including clean
exits, with one deferred renderer reload. It leaves the backend running. Its
automatic retry budget resets only after a document has remained loaded for one
minute. Repeated exits, reload failures, and a thirty-second recovery deadline
offer a native dialog; View → Reload Window also works without renderer IPC.
Shutdown, closed windows, and superseding navigations invalidate delayed actions.
Recovery logs contain lifecycle metadata, not page URLs or document content.

This addresses renderer-process exits. It does not claim to prevent every
possible blank page caused by unrelated JavaScript, network, or GPU failures.

## Verification

- `bun run validate:affected`: passed documentation validation, Electron syntax
  checks, package lint command, and all 331 Electron tests. The 15 focused
  recovery tests cover clean exits and crashes, bounded retries, independent
  window budgets, failed and stalled loads, stale actions, and shutdown cleanup.
- `node packages/electron/tests/renderer-recovery/run.mjs`: passed on Electron
  41.2.1. A disposable preload executes `process.exit(0)` and the actual renderer
  reports `clean-exit`. The same document returns automatically. A second actual
  renderer crash requests native recovery instead of looping; accepting the
  injected dialog response restores it.
- `bun run build`: passed the web production build and Electron main bundle.
  Vite reported large-chunk warnings.
- `bun run bundle:check`: passed startup bundle budgets. Documentation validation
  and whitespace checks also passed after the verification record was added.

The native fixture uses isolated storage, logs, crash files, an in-memory browser
partition, a mock keychain, and blocked external network requests. It starts no
DevRyan backend and cleans up only its owned process and files. Native-dialog
appearance, signed packaging, and installing the change into the user's app are
not claimed as verified. The source/build fix has not replaced the installed app.
