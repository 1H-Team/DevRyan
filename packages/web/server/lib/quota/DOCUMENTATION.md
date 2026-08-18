# Quota Module Documentation

## Purpose
This module fetches quota and usage signals for supported providers in the web server runtime.

## Entrypoints and structure
- `packages/web/server/lib/quota/index.js`: public entrypoint imported by `packages/web/server/index.js`.
- `packages/web/server/lib/quota/routes.js`: Express route registration for quota endpoints.
- `packages/web/server/lib/quota/providers/index.js`: provider registry, configured-provider list, and provider dispatcher.
- `packages/web/server/lib/quota/providers/interface.js`: JSDoc provider contract used as implementation reference.
- `packages/web/server/lib/quota/credentials/`: allowlisted managed-credential normalization, private atomic storage, and explicit Cursor import.
- `packages/web/server/lib/quota/providers/google/`: Google/Gemini and Antigravity auth-source-specific API and transform modules.
- `packages/web/server/lib/quota/utils/`: shared auth, transform, and formatting helpers.
- `@openchamber/shared-runtime/lib/quota-adapters.js`: injected request/parsing contract shared with the VS Code host for z.ai, Kimi, Codex, xAI, and DeepSeek.

## Supported provider IDs (dispatcher)

These provider IDs are currently dispatchable via `fetchQuotaForProvider(providerId)` in `packages/web/server/lib/quota/providers/index.js`.

| Provider ID | Display name | Module | Auth aliases/keys |
| --- | --- | --- | --- |
| `claude` | Claude | `providers/claude.js` | `anthropic`, `claude`, `anthropic-oauth`, `opencode-with-claude` |
| `codex` | ChatGPT | `providers/codex.js` | `openai`, `codex`, `chatgpt` |
| `deepseek` | DeepSeek | `providers/deepseek.js` | `deepseek` API key/token |
| `cursor-acp` | Cursor | `providers/cursor-acp.js` | Environment/token-file OAuth, managed OAuth/dashboard credential, then legacy `cursor-acp.usageSessionToken`; API alias `cursor` |
| `google` | Google | `providers/google/index.js` | `google`, `google.oauth` |
| `antigravity` | Antigravity | `providers/google/index.js` | Antigravity accounts file |
| `github-copilot` | GitHub Copilot | `providers/copilot.js` | `github-copilot`, `copilot` |
| `github-copilot-addon` | GitHub Copilot Add-on | `providers/copilot.js` | `github-copilot`, `copilot` |
| `kimi-for-coding` | Kimi for Coding | `providers/kimi.js` | `kimi-for-coding`, `kimi` |
| `nano-gpt` | NanoGPT | `providers/nanogpt.js` | `nano-gpt`, `nanogpt`, `nano_gpt` |
| `openrouter` | OpenRouter | `providers/openrouter.js` | `openrouter` |
| `opencode-go` | OpenCode Go | `providers/opencode-go.js` | `opencode-go`, `opencodego`, `go`; environment pair, managed credential, then legacy auth usage fields |
| `zai-coding-plan` | z.ai | `providers/zai.js` | `zai-coding-plan`, `zai`, `z.ai` |
| `xai` | xAI | `providers/xai.js` | `xai`, `grok`, `xai-oauth` OAuth access/refresh tokens |
| `zhipuai-coding-plan` | Zhipu AI Coding Plan | `providers/zhipuai-coding-plan.js` | `zhipuai-coding-plan`, `zhipuai`, `zhipu` |
| `minimax-coding-plan` | MiniMax Coding Plan (minimax.io) | `providers/minimax-coding-plan.js` | `minimax-coding-plan` |
| `minimax-cn-coding-plan` | MiniMax Coding Plan (minimaxi.com) | `providers/minimax-cn-coding-plan.js` | `minimax-cn-coding-plan` |
| `ollama-cloud` | Ollama Cloud | `providers/ollama-cloud.js` | Managed cookie, then legacy `~/.config/ollama-quota/cookie` fallback |

## Codex reset-bank credits

The Codex provider uses the OpenAI/ChatGPT OAuth entry (`openai`, `codex`, or `chatgpt`) and fetches the standard usage payload from `https://chatgpt.com/backend-api/wham/usage`. When possible it also makes a best-effort request to the private `https://chatgpt.com/backend-api/wham/rate-limit-reset-credits` endpoint to display reset-bank credits with per-credit expiry dates.

Codex rate-limit window labels are derived from each window's `limit_window_seconds`, not from whether OpenAI reports it as `primary_window` or `secondary_window`. A 5-hour duration maps to `5h`, a 7-day duration maps to `weekly`, and other positive durations use the shared duration-label convention. If duration metadata is absent or invalid, the compatibility fallback remains primary → `5h` and secondary → `weekly`.

The reset-credit endpoint is undocumented and can change independently of the stable usage payload. Provider failures from this secondary request must not fail quota refresh. If the dedicated request fails, the provider falls back to `rate_limit_reset_credits.available_count` from `/wham/usage` when present. Extra-usage availability/balance is always rendered as its own value-only row when the usage payload reports it, independently of reset-bank credits.

## Shared provider adapters

z.ai, Kimi, Codex, xAI, and DeepSeek host modules are deliberately thin: credential discovery and persistence stay in the host, while requests and payload normalization live in `@openchamber/shared-runtime`. This keeps web/Electron and VS Code output equivalent and makes adapters independently testable with injected `fetch` and clock functions.

xAI requests the pinned CLI billing endpoint with manual redirect handling. Redirects are rejected, and an HTTP 401 permits one refresh-and-retry when a refresh token and host persistence callback are available; otherwise the result asks the user to re-authenticate. DeepSeek maps available currency balances to value-only rows because the API does not expose a percentage window.

## Internal-only provider module
- `providers/openai.js` exists for logic parity/reuse but is intentionally not registered for dispatcher ID routing.
- `providers/claude-meridian.js` validates and queries the active local `opencode-with-claude`/Meridian runtime through bounded loopback-only quota and per-session context endpoints. Context lookup resolves and caches the OpenCode → Claude session mapping, coalesces reads per session, and refreshes that mapping after native compaction.
- `providers/claude-code-usage.js` is the compatibility fallback for older Meridian releases. It runs the local, non-billable `/usage` command with JSON output and no session persistence.
- `providers/claude-code-status.js` reads legacy status-line JSON only as degraded last-known data. A status-line result is never reported as a successful fresh quota read, and quota reads never install or modify Claude status-line settings.

## Anthropic usage sources

Anthropic discovery and fetching use the same resolved runtime context. For managed runtimes, the quota route combines OpenCode auth/config with the safe effective Anthropic `baseURL` from the active `/config/providers` response before listing or fetching `claude`. External OpenCode runtimes never use host-local Anthropic credentials, proxies, or Claude Code state.

The Claude provider uses these sources in priority order:

1. When OpenCode auth contains an Anthropic OAuth access token under any supported alias, `providers/claude.js` calls Anthropic's OAuth usage endpoint (`https://api.anthropic.com/api/oauth/usage`) and maps `five_hour`, `seven_day`, and arbitrary model-specific seven-day windows into the shared quota response shape. HTTP failures, malformed responses, and payloads without a valid primary five-hour or seven-day window fall through to the managed-runtime sources instead of terminating refresh.
2. For a locally managed `opencode-with-claude` runtime, the quota route resolves Anthropic's effective `baseURL` from the active OpenCode `/config/providers` response and calls Meridian's structured quota endpoint. Only explicit `http://127.0.0.1:<port>` and `http://localhost:<port>` origins are allowed; the request has a timeout and a 64 KB response limit.
3. If the structured endpoint is unavailable (including older Meridian versions), DevRyan runs `claude -p /usage --output-format json --no-session-persistence --max-turns 1` and maps the returned subscription limits.
4. Legacy status-line data may be returned only with `ok: false` and a visible warning after all live sources fail. A provider with a viable configured source remains `configured: true` on total refresh failure so the Usage UI shows the error instead of hiding Anthropic.

### Anthropic active context

`GET /api/session/:sessionID/context-usage` is the authenticated, read-only normalized context contract used by web and Electron. Managed principals must own the requested session. For a safe local Meridian runtime, the route resolves `/v1/sessions/:openCodeSessionID/recover` once and reads `/v1/sessions/:claudeSessionID/context-usage`; `?refreshSession=true` invalidates the mapping at a compaction boundary. Origins must be explicit loopback HTTP ports, responses are capped at 64 KiB, requests time out, and malformed or unavailable data returns a complete `status: "unavailable"`, `source: "message-fallback"` payload instead of failing startup. External OpenCode never reaches host-local Meridian state.

Active context is `inputTokens + cacheReadTokens + cacheWriteTokens`. `lastOutputTokens` is reported separately and is not part of the context meter.

## OpenCode Go usage source

OpenCode Go usage is dashboard-backed because OpenCode documents Go model endpoints but not a stable usage API. `providers/opencode-go.js` resolves a complete environment credential first, then the managed credential, then `auth["opencode-go"].usageWorkspaceId` + `auth["opencode-go"].usageAuthCookie`. It fetches `https://opencode.ai/workspace/<workspaceId>/go` with manual redirect handling and parses the server-rendered `rollingUsage`, `weeklyUsage`, and `monthlyUsage` fields into the shared quota window shape. The provider is considered configured when either the Go API key or usage credentials exist; if only the API key exists, the quota result returns a configured setup error instead of hiding the provider.

## Managed quota credentials

The managed layer is additive and does not replace or mutate existing provider auth. Canonical provider IDs are `opencode-go`, `ollama-cloud`, and `cursor-acp`; HTTP callers may use `cursor` as an alias for `cursor-acp`, but discovery exposes only the canonical row.

- Files live under `${OPENCHAMBER_DATA_DIR ?? ~/.config/openchamber}/quota/<provider>.json`.
- Provider IDs are allowlisted before path construction. Directories use mode `0700`; temporary and final files use `0600`; writes use same-directory atomic rename with exact temporary-file cleanup.
- Payloads are bounded to 16 KB in the route and storage host, use exact provider-specific shapes, and reject CR/LF/NUL injection, unknown fields, mixed Cursor dashboard/OAuth forms, and invalid workspace IDs.
- Status responses contain only `configured`, optional safe metadata (`workspaceId`, `credentialKind`, `hasRefreshToken`, `effectiveSource`), and a fixed mask. Secrets and secret fragments are never returned or logged.
- `configured` describes only the managed file. `effectiveSource` may still report an environment, token-file, or legacy fallback after deletion.

Routes are registered before the generic provider route:

- `GET /api/quota/credentials/:providerId`
- `PUT /api/quota/credentials/:providerId` (validate before write)
- `POST /api/quota/credentials/:providerId/validate`
- `POST /api/quota/credentials/:providerId/import` (Cursor on macOS only)
- `DELETE /api/quota/credentials/:providerId`

Stable error codes are `UNSUPPORTED_PROVIDER`, `INVALID_CREDENTIAL`, `NOT_CONFIGURED`, `IMPORT_UNAVAILABLE`, and `PAYLOAD_TOO_LARGE`. Cursor import performs a fixed, read-only SQLite query through an argument array and never writes Cursor's database. Cursor OAuth access-token refresh persists only when the source is the managed file; environment variables, token files, Cursor storage, legacy OpenCode auth fields, and the Cursor SDK execution key are never modified.

Credential precedence is intentional:

1. OpenCode Go: explicit environment pair → managed credential → legacy OpenCode auth usage fields.
2. Cursor: explicit environment OAuth → explicit token-file OAuth → managed OAuth/dashboard → legacy dashboard session token.
3. Ollama Cloud: managed cookie → legacy cookie file.

## Response contract
All providers should return results via shared helpers to preserve API shape:
- Required fields: `providerId`, `providerName`, `ok`, `configured`, `usage`, `fetchedAt`
- Optional fields: `error`, `errorCode`, `warnings`, and `usageUpdatedAt` (the provider measurement time for the displayed usage)
- Usage windows may include optional `description` copy and `valueLabel`. A value-only row has `usedPercent: null`; clients render its label without a progress bar.
- `warnings` describe skipped or incomplete portions of an otherwise successful provider response. They do not discard valid rows.
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
