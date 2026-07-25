# packages/web/server/lib/quota/providers/

## Responsibility
Provider adapter registry for quota retrieval across OpenAI/Claude/Codex/Copilot/Google and additional plan-based providers.

## Design
- `index.js` is the dispatch hub: registry table (`isConfigured`, `fetchQuota`), alias resolution, and error wrapping.
- One-file-per-provider adapters isolate API/auth peculiarities while emitting common result shape.
- Dedicated modules isolate structured proxy, CLI, and degraded status sources (for example Claude Meridian quota and Claude Code `/usage`).

## Flow
1. Route/runtime asks registry for configured providers or one provider by ID.
2. Registry resolves aliases (e.g. anthropic→claude) and executes provider `fetchQuota`.
3. Provider reads auth via `quota/utils`, calls the authoritative live source, normalizes usage plus its measurement timestamp, and returns a `buildResult` payload.
4. Registry converts thrown errors into non-throwing provider error results.

## Integration
- Consumed by `lib/quota` route layer.
- Depends on `quota/providers/google/**` submodule and shared `quota/utils/**` helpers.
- External dependencies are provider APIs and local auth artifacts under opencode config/data directories.
