# packages/web/server/lib/opencode/

## Responsibility
Core OpenCode integration layer: config entities (agents/commands/skills/providers/mcp), auth/session state, route registration, process/network bootstrap, and lifecycle management.

## Design
- **Barrel API** (`index.js`) re-exports domain operations for server composition.
- **Runtime factories** (`*-runtime.js`) isolate IO-heavy behaviors (network, startup, watcher, shutdown).
- **Route split by concern** (`core-routes.js`, `openchamber-routes.js`, `skill-routes.js`, `provider-routes` patterns).
- **Config scope model** in shared helpers (`shared.js`) for user/project/global entity resolution.
- **Provider integration aliases** (`provider-integrations.js`) normalize DevRyan-managed provider ids such as GitHub Copilot across upstream payloads, auth files, and config-source checks.
- **OpenCode Slim adapter** (`slim-config.js` + `agents.js`) reads `oh-my-opencode-slim` config/presets, composes those model defaults with Slim-installed global `agents/*.md` prompt files, exposes Slim-managed agents to Settings, and writes Slim agent model/variant overrides back to the Slim config instead of DevRyan's sidecar.
- **Managed runtime overlays** (`runtime-agent-overlays.js`) generate high-precedence OpenCode config directories so user-side agent model defaults, skill visibility, and runtime-only user remote MCP timeout guards apply at execution time without editing project/package agent markdown or persisted MCP config.
- **Harness diagnostics** (`harness-result.js`, `harness-preflight.js`, `turn-timing.js`, `agent-runtime-warmup.js`) expose additive response envelopes, in-memory first-turn timings, latest read-only runtime warmup state, and read-only preflight findings/audits without creating hidden sessions or prompts.

## Flow
1. Server bootstrap resolves env/config (`env-config`, `settings-normalization-runtime`).
2. Startup pipeline creates OpenCode process/network/session runtimes.
3. Route registrars expose config/auth/control APIs to UI and CLI.
4. Watchers + event handlers update session/auth/theme state and drive downstream SSE/WS notifications.

## Integration
- Primary dependency of `packages/web/server/index.js`.
- Integrates with `ui-auth`, `event-stream`, `skills-catalog`, `tunnels`, and filesystem/project modules.
- Contract provider for UI settings/auth/config editors and CLI automation paths.
