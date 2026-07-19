# Queued reconnect auto-send design

## Confirmed problem

Natural queued sending is triggered by `useQueuedMessageAutoSend` when a session
first appears idle or transitions from a non-idle status to idle. The queue
flusher correctly restores claimed rows after a failed send, including their
dispatch-scoped message identity.

If that send failure coincides with a transport disconnect, the restored queue
can be stranded:

1. the idle transition starts a flush;
2. the transport drops and the send fails;
3. the claimed row is restored while the hook already remembers `idle`;
4. reconnect restores the authoritative status as the same `idle` value;
5. no status edge or first-observation edge exists, so no second flush starts.

The invariant is that a non-empty queue restored by a connection failure gets
one new dispatch opportunity when the authoritative connection returns and the
session is still idle and unblocked.

## Design

Subscribe the existing queue hook to the leaf `useConfigStore.isConnected`
value and retain its previous value in a ref. Move the dispatch-edge decision
into a pure helper shared with focused tests.

Keep that connection value authoritative at its event-pipeline boundary. A
WS-to-SSE transport switch is only an attempt to use another transport; it is
not evidence that the fallback reached the server. The switch therefore keeps
the current connection state unchanged. Only the fallback stream's successful
`markConnected()` callback may publish the reconnect edge. The SSE SDK returns
a stream wrapper before it opens the HTTP response, so constructing that
wrapper is also not proof of connectivity. SSE calls `markConnected()` only
after a parsed or yielded event. A stream that rejects before its first event
continues to publish `disconnected` and remains disconnected across later
transport switches.

An idle queue may dispatch when any one of these edges is present:

- the session became idle;
- the session is first observed idle;
- the connection changed from disconnected to connected.

No dispatch is allowed while disconnected, non-idle, blocked, or empty. A
steady connected state is not a retry signal, so repeated renders or repeated
`connected` writes cannot duplicate the flush.

## Safety and scope

- The change is shared-provider UI logic; provider prompts, models, tools, and
  retry policy are unchanged.
- Queue identity, FIFO claiming, rollback, attachment handling, and Builder
  handoff authorization remain owned by `queuedSend.ts`.
- The reconnect edge only grants another attempt. The existing per-session
  in-flight guard and atomic queue claim continue to prevent duplicate sends.
- Blocking requests and non-idle live status remain authoritative.
- The hook uses a leaf connection selector rather than a broad store
  subscription.
- Transport switching still triggers the existing targeted active-directory
  recovery, but it cannot claim that the server is reachable.
- An SSE error response cannot create a transient reconnect pulse before its
  iterator reports the failure.

## Rejected alternatives

- Dispatching every non-empty idle queue on every render could create tight
  retry loops for persistent validation, authorization, or provider failures.
- Triggering queue sends directly from `sync-context.tsx` would couple the
  transport pipeline to composer preparation and handoff policy.
- Adding a new global reconnect epoch store is unnecessary once the existing
  boolean is corrected at its source and supplies a genuine false-to-true edge.
