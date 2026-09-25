# packages/web/server/lib/quota/providers/google/

## Responsibility
Google-specific quota provider implementation for the Gemini CLI auth source (auth source resolution, token refresh, quota/model fetch, normalization). Antigravity quota was removed with the retired Antigravity plugin.

## Design
- `auth.js` discovers the Gemini CLI auth source from the OpenCode auth store and supplies its OAuth client credentials.
- `api.js` owns Google HTTP calls (token refresh + quota/model endpoints).
- `transforms.js` converts bucket/model payloads into canonical quota model usage data on a daily window.
- `index.js` orchestrates the source-specific quota fetch and partial-failure handling.

## Flow
1. `fetchGoogleQuota()` filters to the Gemini auth source.
2. Refreshes the token when expired and fetches quota/model data.
3. Transforms and merges models into a shared map, recording per-source failures.
4. Returns `configured:false` when the Gemini auth source is missing, or a best-effort error/success result when it exists.

## Integration
- Invoked via the quota provider registry as provider `google`.
- Uses shared result contract from `quota/utils` and contributes normalized model windows for UI quota display.
