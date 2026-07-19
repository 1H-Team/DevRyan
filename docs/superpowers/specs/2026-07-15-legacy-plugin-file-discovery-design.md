# Legacy plugin file discovery design

## Context

OpenCode loads JavaScript and TypeScript plugin files from the singular
`plugin/` directory. DevRyan's read-only Plugins Settings model currently scans
only the plural `plugins/` compatibility directory. An active user plugin such
as `~/.config/opencode/plugin/cursor-acp.js` therefore affects the runtime and
tool catalog while remaining absent from Settings. The same omission exists in
the VS Code implementation.

## Decision

Discover supported plugin files from both directory conventions at each scope:

- user: `<config-root>/plugin/` and `<config-root>/plugins/`;
- project: `<project>/.opencode/plugin/` and
  `<project>/.opencode/plugins/`.

The singular directory is listed first, followed by the plural compatibility
directory. Files remain distinct by absolute path, even when both directories
contain the same file name, because OpenCode can load both and duplicate runtime
behavior is precisely the state Settings must reveal.

The response contract does not change. Each file keeps the existing `PluginFile`
shape and path-derived identifier, so the shared UI needs no new branch. The
change remains read-only: DevRyan will not delete, rename, disable, or quarantine
user plugin files.

## Alternatives rejected

- Scan only `plugin/`: this would hide DevRyan's existing plural compatibility
  files, including the managed Slim wrapper.
- Deduplicate by file name: two paths with the same name can both execute and
  must both remain visible.
- Infer files only from the effective OpenCode config: config output can include
  resolved file URLs, but filesystem discovery is still required for inactive
  or failed files and for the existing Settings contract.

## Verification

- Web and VS Code regression tests create singular and plural user/project
  files and assert all four are returned in deterministic order.
- Existing malformed-entry and read-only route behavior remains unchanged.
- The real Plugins Settings page shows the previously hidden singular user
  plugin file once the fixed server is used.
