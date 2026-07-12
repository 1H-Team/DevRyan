# Quota Module Documentation

## Purpose
This module fetches quota and usage signals for supported providers in the web server runtime.

## Entrypoints and structure
- `packages/web/server/lib/quota/index.js`: public entrypoint imported by `packages/web/server/index.js`.
- `packages/web/server/lib/quota/routes.js`: Express route registration for quota endpoints.
- `packages/web/server/lib/quota/providers/index.js`: provider registry, configured-provider list, and provider dispatcher.
- `packages/web/server/lib/quota/providers/interface.js`: JSDoc provider contract used as implementation reference.
- `packages/web/server/lib/quota/providers/google/`: Google/Gemini and Antigravity auth-source-specific API and transform modules.
- `packages/web/server/lib/quota/utils/`: shared auth, transform, and formatting helpers.

## Supported provider IDs (dispatcher)

These provider IDs are currently dispatchable via `fetchQuotaForProvider(providerId)` in `packages/web/server/lib/quota/providers/index.js`.

| Provider ID | Display name | Module | Auth aliases/keys |
| --- | --- | --- | --- |
| `claude` | Anthropic | `providers/claude.js` | `anthropic`, `claude`, `anthropic-oauth`, `opencode-with-claude` |
| `codex` | ChatGPT | `providers/codex.js` | `openai`, `codex`, `chatgpt` |
| `cursor-acp` | Cursor | `providers/cursor-acp.js` | `cursor-acp.usageSessionToken` |
| `google` | Google | `providers/google/index.js` | `google`, `google.oauth` |
| `antigravity` | Antigravity | `providers/google/index.js` | Antigravity accounts file |
| `github-copilot` | GitHub Copilot | `providers/copilot.js` | `github-copilot`, `copilot` |
| `github-copilot-addon` | GitHub Copilot Add-on | `providers/copilot.js` | `github-copilot`, `copilot` |
| `kimi-for-coding` | Kimi for Coding | `providers/kimi.js` | `kimi-for-coding`, `kimi` |
| `nano-gpt` | NanoGPT | `providers/nanogpt.js` | `nano-gpt`, `nanogpt`, `nano_gpt` |
| `openrouter` | OpenRouter | `providers/openrouter.js` | `openrouter` |
| `opencode-go` | OpenCode Go | `providers/opencode-go.js` | `opencode-go`, `opencodego`, `go`; usage credentials from `OPENCODE_GO_WORKSPACE_ID` + `OPENCODE_GO_AUTH_COOKIE` or auth fields `usageWorkspaceId` + `usageAuthCookie` |
| `zai-coding-plan` | z.ai | `providers/zai.js` | `zai-coding-plan`, `zai`, `z.ai` |
| `zhipuai-coding-plan` | Zhipu AI Coding Plan | `providers/zhipuai-coding-plan.js` | `zhipuai-coding-plan`, `zhipuai`, `zhipu` |
| `minimax-coding-plan` | MiniMax Coding Plan (minimax.io) | `providers/minimax-coding-plan.js` | `minimax-coding-plan` |
| `minimax-cn-coding-plan` | MiniMax Coding Plan (minimaxi.com) | `providers/minimax-cn-coding-plan.js` | `minimax-cn-coding-plan` |
| `ollama-cloud` | Ollama Cloud | `providers/ollama-cloud.js` | Cookie file at `~/.config/ollama-quota/cookie` (raw session cookie string) |

## Codex reset-bank credits

The Codex provider uses the OpenAI/ChatGPT OAuth entry (`openai`, `codex`, or `chatgpt`) and fetches the standard usage payload from `https://chatgpt.com/backend-api/wham/usage`. When possible it also makes a best-effort request to the private `https://chatgpt.com/backend-api/wham/rate-limit-reset-credits` endpoint to display reset-bank credits with per-credit expiry dates.

The reset-credit endpoint is undocumented and can change independently of the stable usage payload. Provider failures from this secondary request must not fail quota refresh. If the dedicated request fails, the provider falls back to `rate_limit_reset_credits.available_count` from `/wham/usage` when present; if neither source reports reset-bank data, the legacy `credits.balance` dollar row remains available.

## Internal-only provider module
- `providers/openai.js` exists for logic parity/reuse but is intentionally not registered for dispatcher ID routing.
- `providers/claude-code-status.js` is a fallback reader for Claude Code status-line JSON at `~/.cache/openchamber/claude-code-status.json`; it is used only by the Anthropic provider when OAuth tokens are unavailable but the local Claude proxy config exists.
- `providers/claude-code-status-setup.js` installs and repairs OpenChamber's managed Claude Code status-line bridge at `~/.cache/openchamber/claude-code-status-line.sh`. The bridge reads Claude Code's official `statusLine` stdin JSON, atomically writes it to `~/.cache/openchamber/claude-code-status.json`, and lets OpenChamber display the `rate_limits.five_hour.used_percentage` and `rate_limits.seven_day.used_percentage` windows. If Claude Code already has a custom `statusLine`, OpenChamber does not overwrite it; the quota result reports manual setup guidance instead.

## Anthropic usage sources

The Claude provider has two usage data sources, in priority order:

1. When OpenCode auth contains an Anthropic OAuth access token, `providers/claude.js` calls Anthropic's OAuth usage endpoint (`https://api.anthropic.com/api/oauth/usage`) and maps `five_hour`, `seven_day`, and model-specific seven-day windows into the shared quota response shape.
2. When no token exists but the local `opencode-with-claude` proxy config is detected, `providers/claude.js` self-heals the Claude Code status-line bridge and reads Claude Code's status JSON. This path reports the overall 5-hour and 7-day windows from Claude Code `rate_limits` data. If Claude Code has not emitted a status-line payload yet, OpenChamber runs `claude -p "Reply with exactly: OK" --output-format text` to force a minimal non-interactive Claude Code response, then reads the status JSON again. If the CLI is missing, unauthenticated, or still does not emit status-line usage, the provider returns a configured error with deterministic guidance.

## OpenCode Go usage source

OpenCode Go usage is dashboard-backed because OpenCode documents Go model endpoints but not a stable usage API. `providers/opencode-go.js` reads `OPENCODE_GO_WORKSPACE_ID` + `OPENCODE_GO_AUTH_COOKIE` first, then falls back to `auth["opencode-go"].usageWorkspaceId` + `auth["opencode-go"].usageAuthCookie`. It fetches `https://opencode.ai/workspace/<workspaceId>/go` with the `auth` cookie and parses the server-rendered `rollingUsage`, `weeklyUsage`, and `monthlyUsage` fields into the shared quota window shape. The provider is considered configured when either the Go API key or usage credentials exist; if only the API key exists, the quota result returns a configured setup error instead of hiding the provider.

## Response contract
All providers should return results via shared helpers to preserve API shape:
- Required fields: `providerId`, `providerName`, `ok`, `configured`, `usage`, `fetchedAt`
- Optional field: `error`
- Usage windows may include optional `description` copy for provider-specific bucket explanations.
- Unsupported provider requests should return `ok: false`, `configured: false`, `error: Unsupported provider`

Quota routes accept the active project directory via `x-opencode-directory` or `?directory=` so project-local `.opencode/opencode.json` provider config is included in provider detection.

## Client refresh ownership

The shared UI has one quota polling owner in `packages/ui/src/apps/AppEffects.tsx`.
It delegates scheduling to `packages/ui/src/stores/quota-refresh-coordinator.ts`
and state/transport to `packages/ui/src/stores/useQuotaStore.ts`.

- Startup performs configured-provider discovery through
  `GET /api/quota/providers`, followed by one initial refresh of only those
  provider IDs.
- The mandatory baseline cadence is 30 minutes. The existing optional
  auto-refresh preference may choose a faster 30-second to 5-minute cadence,
  but it does not disable the baseline refresh.
- Header, desktop chrome, VS Code, and Usage settings surfaces can request a
  manual refresh but do not own timers.
- Provider requests are deduplicated per provider. A coordinator request that
  arrives during a cycle is merged into at most one ordered follow-up cycle.
- Successful data is retained when a later request fails. UI state records
  `lastAttemptAt`, `lastSuccessAt`, and `refreshError` separately and derives
  staleness from the active cadence.
- Authentication and provider-configuration success paths request safe
  rediscovery instead of starting additional polling loops.

Do not log quota payloads, provider tokens, cookies, or response bodies when
measuring refresh behavior. Request counts and status codes are sufficient.

## Add a new provider (quick steps)
1. Choose module shape based on complexity:
   - Simple providers: create `packages/web/server/lib/quota/providers/<provider>.js`.
   - Complex providers (multi-source auth, multiple API calls, non-trivial transforms): create `packages/web/server/lib/quota/providers/<provider>/` with split modules like Google (`index.js`, `auth.js`, `api.js`, `transforms.js`).
2. Export `providerId`, `providerName`, `aliases`, `isConfigured`, and `fetchQuota`.
3. Use shared helpers from `packages/web/server/lib/quota/utils/index.js` (`buildResult`, `toUsageWindow`, auth/conversion helpers) to keep payload shape consistent.
4. Register the provider in `packages/web/server/lib/quota/providers/index.js`.
5. If needed for direct use, export a named fetcher from `packages/web/server/lib/quota/providers/index.js` and `packages/web/server/lib/quota/index.js`.
6. Update this file with the new provider ID, module path, and alias/auth details.
7. Validate with `bun run type-check`, `bun run lint`, and `bun run build`.

## Notes for contributors
- Keep provider IDs stable; clients use them directly.
- Keep one visible UI entry per provider family even when dispatcher aliases are accepted for compatibility.
- Keep Google and Antigravity behavior changes isolated and review `providers/google/*` together; Antigravity reuses the Google module but fetches only the Antigravity auth source.
