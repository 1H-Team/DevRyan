# packages/web/server/lib/quota/

## Responsibility
Provider-agnostic quota reporting module for model/provider usage limits, exposing lookup and refresh endpoints.

## Design
- **Provider registry pattern**: runtime resolves configured quota providers and dispatches by `providerId`.
- **Directory-scoped resolution**: routes accept header/query project directory hints and normalize via shared resolver.
- **Error contract discipline**: route layer wraps provider exceptions into HTTP status/error payloads.
- **Managed secrets**: `credentials/store.js` owns allowlisted private atomic files; `credentials/providers.js` owns exact shapes and safe status; `credentials/cursor-import.js` owns explicit read-only Cursor import.

## Flow
1. Request hits `/api/quota/providers`, `/api/quota/credentials/:providerId`, or `/api/quota/:providerId`.
2. Route resolves effective working directory (header/query + project resolver).
3. Credential routes canonicalize the allowlisted provider, enforce 16 KB input, validate before atomic persistence, and return safe status only.
4. Quota runtime lists providers or fetches provider-specific data (optionally `refresh=true`) using documented source precedence.
5. Result payload returns provider list/usage snapshot to clients.

## Integration
- Mounted by server runtime and consumed by UI quota features.
- Depends on provider implementations in `quota/providers/**` and utils under `quota/utils/**`.
- Coordinates with project-directory resolution from opencode/project modules.
