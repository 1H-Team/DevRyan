# DevRyan Desktop (legacy Tauri shell)

This package is the legacy Tauri desktop shell, retained for installed-app
compatibility. Its source uses DevRyan identities and accepts released legacy
settings and process names. The current DMG-only release does not provide a
signed Tauri transition payload, so installed-app updates remain unqualified.

- Do not add features or speculative backports here.
- New desktop work belongs in [`packages/electron`](../electron/main.mjs), the
  primary desktop shell.
- The decision to remove this package is separate; see the
  [Tauri to Electron cutover runbook](../../docs/TAURI_TO_ELECTRON_CUTOVER.md).
