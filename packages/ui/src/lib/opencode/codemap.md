# packages/ui/src/lib/opencode/

## Responsibility
Client integration layer for OpenCode HTTP/SSE APIs and runtime conventions.

## Design
API-wrapper modules normalize request/response shapes and streaming event handling.
Provider prompt compatibility overrides are isolated in `provider-prompt-tools.ts`; `client.ts` resolves provider and Plan Mode Context policies immediately before each transport attempt. Its fail-closed read-only indexing capability is refreshed from health, so queued prompts and retries cannot retain stale managed-runtime privileges.

## Flow
UI actions call client methods; SSE events are decoded and forwarded to sync/stores.

## Integration
Core dependency for chat/session/settings workflows and cross-runtime parity.
