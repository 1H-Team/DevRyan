# Upstream provenance

Base: Oh My OpenCode Slim `v3.0.4` (tag object `98208e76606c7fa3c1309d946c5c72ac8c7f5e96`),
`src/` only, from https://github.com/alvinunreal/oh-my-opencode-slim.

DevRyan owns this code. Upstream releases are candidates: port individual fixes
that apply, record each one below with its upstream commit, and never replace
the tree wholesale.

## Removed from the base

- `multiplexer/`, `marketplace/`, `marketplace-contract/`, `companion/`, the TUI
  entry points (`tui*.ts`), `preset-editor-domain.ts` and every `codemap.md`.
- `cli/` except the skill-permission helpers (`skills.ts`, `custom-skills.ts`,
  `custom-skills-registry.ts`, `paths.ts`).

- Sources no DevRyan entry point reaches (pruned to the import graph of
  `src/devryan/index.ts`), including the auto-update hook and built-in MCP
  injection.

## Tests removed or replaced

Upstream tests of code DevRyan removed or moved into the host owners:

- Removed: `build-info`, `config/loader` and `config/skills-add-remove` (file
  discovery is host-owned; the loader reads the bound configuration),
  `utils/logger` (host log sinks), `hooks/auto-update-checker/*`,
  `v2/permission-rules-bridge`, `v2/setup-compaction` and
  `v2/setup-generation-reset` (host-owned permissions, compaction and
  generation state).
- Replaced with owner-based tests: `v2/interview-bridge` (fake interview
  owner; `/implement` is disabled), `tools/smartfetch/secondary-model`
  (owner `secondary` call instead of temporary sessions), and single cases in
  `tools/smartfetch/tool`, `tools/smartfetch/utils`, `config/presets` and
  `v2/setup-chat-headers`.
- `test/preload.ts` installs filesystem/fetch test owners and isolates the
  XDG and OpenCode directories, matching upstream `test-isolation.ts`.

## Ported upstream commits

None yet.
