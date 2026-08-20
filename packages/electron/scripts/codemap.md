# packages/electron/scripts/

## Responsibility
Holds Electron-specific build/packaging helper scripts used by npm/bun tasks.

## Design
Script-first utilities (small Node/shell entrypoints) that run outside runtime code. They orchestrate packaging steps and release metadata, not app behavior.

Native packaging is explicit and fail-closed: `rebuild-native.mjs` resolves each declared ABI-sensitive dependency from its declaring workspace, and the `afterPack` hook verifies the app bindings plus Cursor SDK `rg`, `cursorsandbox`, and both tree-sitter bindings before signing. Cursor SDK 1.0.28 relies on built-in `node:sqlite`, so Cursor's old transitive `sqlite3` rebuild path is intentionally absent.

## Flow
1. Workspace script invokes a helper in this folder.
2. Helper reads local package/release inputs.
3. Helper emits artifacts or metadata consumed by Electron build/release jobs.

## Integration
- Upstream callers: root `package.json` scripts and CI release workflows.
- Related runtime: `packages/electron/main.mjs` and `packages/web/server/*` (server-in-process model).
- Desktop policy: Electron is primary; Tauri scripts remain legacy-only in `packages/desktop/scripts`.
