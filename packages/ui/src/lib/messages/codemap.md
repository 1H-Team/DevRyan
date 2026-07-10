# packages/ui/src/lib/messages/

## Responsibility
Utilities for message shaping, formatting, and cross-component message semantics.

## Design
Pure transform helpers keep message logic reusable outside React components.
- `actionablePlan.ts` detects plan-mode prompts, explicit plan sentinels, and structured plan fallbacks.
- `planCardRender.ts` maps a resolved message-level plan split back onto rendered text groups so the card appears at the right point in mixed text streams.
- `transientStreamError.ts` normalizes provider error details and detects likely retryable mid-stream transport failures without overriding auth or abort handling.
- `providerModelNotFound.ts` detects OpenCode `ProviderModelNotFoundError` / "Model not found" failures so chat and toasts can show actionable recovery copy.
- `transientRecovery.ts` plans either original-prompt resend or visible continuation recovery from the latest transient assistant failure.

## Flow
Incoming/outgoing message payloads are normalized before store insertion or render.

## Integration
Used by chat, sync reducers, and compose/send flows.
