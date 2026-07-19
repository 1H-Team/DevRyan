# packages/web/server/lib/opencode/

## Responsibility
Core OpenCode integration layer: config entities (agents/commands/skills/providers/mcp), auth/session state, route registration, process/network bootstrap, and lifecycle management.

## Design
- **Barrel API** (`index.js`) re-exports domain operations for server composition.
- **Runtime factories** (`*-runtime.js`) isolate IO-heavy behaviors (network, startup, watcher, shutdown).
- **Route split by concern** (`core-routes.js`, `openchamber-routes.js`, `skill-routes.js`, `provider-routes` patterns).
- **Config scope model** in shared helpers (`shared.js`) for user/project/global entity resolution.
- **Provider integration aliases** (`provider-integrations.js`, `github-copilot-models.js`) normalize DevRyan-managed provider ids such as GitHub Copilot across upstream payloads, auth files, config-source checks, and account-specific model discovery fallbacks; all-false modern picker payloads are narrowed to GitHub's utility-model contract instead of exposing unverified rows.
- **Claude authentication and plugin policy** (`claude-auth-status.js`, `anthropic-oauth-plugin.js`, `providers.js`) uses the official non-billable auth-status command, strips private account metadata, recognizes versioned proxy specs, upgrades DevRyan's legacy bare spec to the reviewed release, and preserves explicit user pins.
- **Exclusive title ownership** (`standard-session-title-runtime.js`, `cursor-session-title-runtime.js`) keeps automatic titles provider-specific: the standard runtime handles accepted proxied non-Cursor prompts with the configured Zen model, while the Cursor runtime handles intercepted Cursor prompts. Both use guarded compare-before-update persistence so explicit/manual titles always win; the UI never persists prompt-derived automatic titles.
- **OpenCode Slim adapter** (`slim-config.js` + `agents.js`) reads `oh-my-opencode-slim` config/presets, composes those model defaults with Slim-installed global `agents/*.md` prompt files, exposes Slim-managed agents to Settings, and writes Slim agent model/variant overrides back to the Slim config instead of DevRyan's sidecar.
- **Managed runtime overlays** (`runtime-agent-overlays.js`, `runtime-surface-policy.js`) generate high-precedence OpenCode config directories so user-side agent model defaults, skill visibility, allowlisted plugins, blocked ambient MCP tombstones, and runtime-only user remote MCP timeout guards apply at execution time without editing project/package agent markdown or persisted MCP config. Source-configured local plugins are not restated in the overlay, and a same-named packaged plugin registration remains dormant until the source entry disappears, preventing duplicate plugin hooks/tool schemas.
- **Plugin read model** (`plugins-readonly.js`) exposes configured entries and both singular `plugin/` and plural `plugins/` user/project files to Settings without mutating runtime configuration.
- **Harness diagnostics and proactive warmup** (`harness-result.js`, `harness-preflight.js`, `harness-tool-manifest.js`, `harness-context-budget.js`, `turn-timing.js`, `agent-runtime-warmup.js`, `project-prewarm-runtime.js`) expose additive response envelopes, lazy live tool-catalog measurements, UTF-8 context budgets, capped/redacted tool-call timelines, latest read-only runtime warmup state, forbidden runtime surface findings, and read-only preflight audits without creating hidden sessions or prompts. Startup and successful restart paths proactively warm known projects sequentially, while directory-keyed single-flight deduplicates overlapping UI warmups.
- **Global behavior ownership** (`global-agents-md-runtime.js`, `global-agents-md-routes.js`) treats `~/.config/opencode/AGENTS.md` as the sole prompt source, keeps external runtimes read-only, and reports refresh failures without hiding successful persistence.

## Flow
1. Server bootstrap resolves env/config (`env-config`, `settings-normalization-runtime`).
2. Startup pipeline creates OpenCode process/network/session runtimes.
3. Route registrars expose config/auth/control APIs to UI and CLI.
4. Watchers + event handlers update session/auth/theme state and drive downstream SSE/WS notifications.

## Integration
- Primary dependency of `packages/web/server/index.js`.
- Integrates with `ui-auth`, `event-stream`, `skills-catalog`, `tunnels`, and filesystem/project modules.
- Contract provider for UI settings/auth/config editors and CLI automation paths.
- Global agent behavior is absent by default and stored only at `~/.config/opencode/AGENTS.md`; clearing it removes the file.
