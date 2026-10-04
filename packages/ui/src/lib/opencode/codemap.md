# packages/ui/src/lib/opencode/

## Responsibility
Client integration layer for OpenCode HTTP/SSE APIs and runtime conventions.

## Design
API-wrapper modules normalize request/response shapes and streaming event handling.
Provider prompt compatibility overrides are isolated in `provider-prompt-tools.ts`; `client.ts` resolves provider and Plan Mode Context policies immediately before each transport attempt. Its fail-closed read-only indexing capability is refreshed from health, so queued prompts and retries cannot retain stale managed-runtime privileges.

`client.ts` binds the current pipeline subscription gate to input transport. Prompt, slash command and immediate-subtask methods wait after preparation and recheck synchronously on every actual attempt; raw shell, manual compaction, visible Git-session generation, retained-input Resume/Continue and explicit managed retry/resume use the same boundary. A known refusal before any POST retains draft/queue selections and pre-click status. If an earlier POST was unconfirmed, a later readiness failure remains ambiguous and preserves busy state. Read-only requests, Stop, discard and background auto-recovery settings remain ungated.

## Flow
UI actions call client methods; SSE events are decoded and forwarded to sync/stores.

## Integration
Core dependency for chat/session/settings workflows and cross-runtime parity.
