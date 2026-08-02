# packages/ui/src/lib/messages/

## Responsibility
Utilities for message shaping, formatting, and cross-component message semantics.

## Design
Pure transform helpers keep message logic reusable outside React components.
- `actionablePlan.ts` detects plan-mode prompts, explicit plan sentinels, and structured plan fallbacks.
- `planRevisions.ts` groups turns into logical plan revisions: a user-authored plan request plus any compaction/synthetic continuation turns the runtime injects. It selects the last canonical assistant plan as the revision's single source, tracks settledness across sibling assistants, and assigns before/source/after roles so rendering and background detection agree on one card per revision.
- `planCardRender.ts` maps a resolved message-level plan split back onto rendered text groups so the card appears at the right point in mixed text streams; `mountPlanCard: false` consumes a superseded sibling's plan body without emitting a card.
- `transientStreamError.ts` normalizes provider error details through the shared request/header/stream-idle/connection classifier without overriding auth, model, certificate, or abort handling.
- `providerModelNotFound.ts` detects OpenCode `ProviderModelNotFoundError` / "Model not found" failures so chat and toasts can show actionable recovery copy.
- `transientRecovery.ts` resends the original prompt only when an attempt produced no assistant output; after partial text or tool work it emits the fixed continuation without replaying completed work, and restores attachments only on the resend path.

## Flow
Incoming/outgoing message payloads are normalized before store insertion or render.

## Integration
Used by chat, sync reducers, and compose/send flows.
