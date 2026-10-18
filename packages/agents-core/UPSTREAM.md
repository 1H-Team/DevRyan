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

## DevRyan behaviour changes

- All authority goes through `src/devryan/owners.ts` (see
  `DOCUMENTATION.md`): host log sinks instead of the log file and stderr, a
  frozen per-location configuration instead of file and environment reads,
  invocation owners for paths and web fetch, and a host-verified AST
  executable instead of download or PATH lookup.
- The v2 setup takes its hooks from the host binding and refuses a request
  when a bridge fails instead of degrading it. Storage, generation and model
  probes, the agent registry, MCP and permission bridges, config watching,
  synthesized commands, the retry hook and bundled skill installation are host
  owned and not run.
- The task board renders host-owned task rows with `delegationTool: 'task'` and
  board injection on; fallback selection is the pure
  `selectReviewedSlimFallback`, applied by the host's recovery owner.
- Hook factories take only the context fields they read, so the host passes
  its owned contexts without casts.
- The manual prompt-cache breakpoint the v2 context handler adds after an
  injection is off (`cacheBreakpoint`): the host requires native parts,
  tool results included, to pass through the context hook unchanged.
- The image hook keeps no per-directory state between confined worker runs.
- `/implement` and `interview_submit_state` are not enabled.

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
