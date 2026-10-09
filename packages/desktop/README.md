# DevRyan Desktop (legacy Tauri shell)

This package is the legacy Tauri desktop shell. It is retained only so that
already-installed DevRyan apps keep a working auto-update path.

- Do not add features or speculative backports here.
- New desktop work belongs in [`packages/electron`](../electron/main.mjs), the
  primary desktop shell.
- The decision to remove this package is separate; see the
  [Tauri to Electron cutover runbook](../../docs/TAURI_TO_ELECTRON_CUTOVER.md).
