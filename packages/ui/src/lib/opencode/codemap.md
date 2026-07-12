# packages/ui/src/lib/opencode/

## Responsibility
Client integration layer for OpenCode HTTP/SSE APIs and runtime conventions.

## Design
API-wrapper modules normalize request/response shapes and streaming event handling.
Provider prompt compatibility overrides are isolated in `provider-prompt-tools.ts`; `client.ts` applies only restrictions required by the selected provider's request contract, leaving all other providers unchanged.

## Flow
UI actions call client methods; SSE events are decoded and forwarded to sync/stores.

## Integration
Core dependency for chat/session/settings workflows and cross-runtime parity.
