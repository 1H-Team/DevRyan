# Retry-deadline abort guard design

## Confirmed problem

`abort-retry-guard.ts` gives an explicit Stop a fixed 60-second lifetime. That
window is independent of the authoritative `SessionStatus` retry deadline.
When a provider reports a retry whose `next` attempt is more than 60 seconds
away, the following sequence is reachable in DevRyan's state machine:

1. the directory store contains `session.status: retry` with a future `next`;
2. the user stops the session, DevRyan registers the guard, and OpenCode ignores
   the abort while sleeping in provider backoff;
3. DevRyan optimistically renders the session idle;
4. the fixed guard expires before the advertised retry attempt;
5. the later `retry` or `busy` status is accepted from the live stream or a
   reconnect snapshot, so the stopped turn becomes active again.

The existing expiration test proves this overwrite after 60 seconds. OpenAI
review through DevRyan independently identified the same sequence while
correctly noting that the repository does not prove which provider backoffs
currently exceed one minute. The defect is the state machine's inability to
honor Stop for a valid retry deadline, not a claim about one provider's current
policy.

Real-UI fault injection exposed a companion state edge: the retry reducer can
correctly publish guarded `idle` while `streaming.ts` still retains the prior
incomplete assistant shell through its narrow premature-idle exception. That
tracked streaming ID keeps the composer on Stop even though the guarded status
is idle. A manual retry abort must not be treated as a premature server idle.

## Design

Retain the narrow per-session guard, but replace its fixed expiration with an
authoritative retry-aware deadline:

- a newly registered guard keeps the existing 60-second base window;
- when the current status is `retry`, registration also records its retry
  identity (`attempt` plus raw `next`) and extends the deadline through the
  normalized retry target plus the same 60-second settlement grace;
- a different authoritative retry identity observed while the guard is active
  advances that deadline in the same way;
- repeated copies of the same relative `next` value reuse the first normalized
  target instead of sliding the deadline on every duplicate event;
- epoch milliseconds, epoch seconds, and relative millisecond values follow
  the same normalization already used by the retry countdown UI;
- non-finite or non-positive retry deadlines do not extend the base window.

Every production abort path seeds the guard with the status it is stopping.
This avoids depending on OpenCode to repeat the already-visible retry event
after the abort request.

When guarded idle reaches streaming derivation, the active manual-abort guard
disables only the existing incomplete-assistant retention exception for that
session. The tracked stream completes, so the composer unlocks. Unguarded idle
continues to preserve the narrow out-of-order streaming fallback unchanged.

The guard still clears immediately on idle, error, disposal, or a new local
send. It additionally clears when an authoritative `message.updated` event
advances the cached user-turn boundary. That event is the cross-runtime source
of truth for a new send and prevents a long provider retry deadline from
re-aborting a turn submitted by another connected DevRyan surface. A user
message replayed into an empty or newer cache does not clear the guard.

## Safety and scope

- The guard remains in memory, per session, and bounded by the latest finite
  authoritative retry target plus a fixed settlement grace.
- Provider retry policy, prompts, models, and request payloads are unchanged.
- `retry` remains authoritative when no explicit manual guard exists.
- `busy` still renders as busy while the guard schedules the existing bounded
  re-abort; the change does not fabricate an idle status for legitimate work.
- The streaming exception changes only for an active per-session abort guard;
  ordinary premature idle events keep their current behavior.
- The existing three-attempt and one-second debounce limits remain unchanged.
- A user message that advances the cached turn clears the guard before later
  statuses are reduced, so web and Electronanother browser surface
  share the same new-turn escape hatch without treating historical replay as
  current work.
- Reconnect snapshots continue through the same filter and therefore inherit
  the corrected deadline without a second policy path.

## Rejected alternatives

- Raising the fixed TTL merely moves the defect to a longer provider backoff.
- Keeping the guard forever until idle would let malformed or missing terminal
  events mask unrelated future activity.
- Persisting a stopped-turn tombstone would require stable turn identity in
  `SessionStatus`; the current payload contains only session-level retry data.
- Reimplementing or overriding provider retry policy in DevRyan would be a much
  broader cross-provider behavior change than the confirmed client-state bug.
