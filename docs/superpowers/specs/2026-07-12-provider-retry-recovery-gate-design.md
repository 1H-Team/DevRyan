# Provider Retry Recovery Gate Design

## Problem

DevRyan currently treats every OpenCode `session.status: retry` event as a request to stop the provider retry loop. The sync event handler registers an abort guard, offers model recovery immediately, coerces the live status to `idle`, and schedules a bounded abort. This interrupts an otherwise active agent turn before OpenCode can apply its own retry policy.

The Test project reproduction confirmed the behavior. A prompt entered `busy`, emitted one provider `retry` 4.21 seconds later, and was forced to `idle` 114 ms after that. The assistant message completed with zero tokens and zero parts. The provider detail concerned Claude's 1M-context entitlement, but DevRyan's interruption was caused by the unconditional retry handler rather than quota state.

## Desired Behavior

- A provider `retry` event remains authoritative and is reduced as `retry` while the user has not stopped the turn.
- DevRyan does not offer model recovery merely because a live retry event occurred.
- Pressing Stop during a retry still registers the manual abort guard, suppresses subsequent retry statuses, and reissues bounded aborts until authoritative settlement.
- Terminal retryable provider failures continue to offer recovery through `useProviderErrorRecovery`, which requires an authoritative active-to-idle transition and a matching terminal assistant error.

## Architecture

Remove automatic provider-retry registration and recovery creation from the hot sync event boundary. Keep `abort-retry-guard.ts` focused on explicit user-initiated aborts and remove its provider-retry registration API. The existing terminal error recovery hook remains the sole owner of recovery-card creation for failed standard-provider turns.

No new state, dependencies, message heuristics, or timers are introduced.

## Testing

- Change the sync boundary regression test to prove an unguarded retry stays `retry` and does not activate an abort guard.
- Retain guard tests proving manual Stop still coerces retry to idle, schedules re-aborts, respects debounce/caps, and clears on settlement.
- Retain terminal recovery decision tests proving transient and model-not-found terminal assistant errors remain recoverable.
- Run affected UI tests and changed-file-aware validation.

## Documentation

Update the stores and sync documentation so provider recovery is described as terminal-error-driven and the abort guard as manual-stop-only.
