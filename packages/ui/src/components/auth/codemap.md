# packages/ui/src/components/auth/

## Responsibility

Authentication UI components for login, token/device flows, dependency and
schema failures, local session reset, and loopback agent verification.

## Design

- `SessionAuthGate.tsx` owns rendering, password/passkey submission, retry,
  partial-failure-safe local reset, and explicit developer/admin fixture login.
- `sessionAuthState.ts` is the pure response classifier and deterministic
  developer-first agent identity ordering used by the gate and its tests.

## Flow

`GET /auth/session` responses are classified as authenticated, locked,
rate-limited, identity unavailable, managed-account setup required, schema
migration required, or an unexpected server response. Only a rejected fetch is
rendered as “Unable to reach server.”
For managed users, the accepted gate remains subscribed to low-frequency project
metadata invalidations and event-stream reconnects, coalesces them, and reloads the
same principal's authoritative assignment snapshot without resetting directory state.
Remembered loopback administrators retain a separate low-frequency offline-grace
availability signal. While it is active, the gate keeps the session authenticated,
revalidates with bounded backoff and on tab return, and exposes an immediate retry
used by protected Settings pages.

## Integration
Integrated with lib/opencode/github auth endpoints and settings views.
