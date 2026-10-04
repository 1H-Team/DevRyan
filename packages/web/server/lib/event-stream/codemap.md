# packages/web/server/lib/event-stream/

## Responsibility
Real-time transport bridge for OpenCode events: parses upstream SSE envelopes, maintains replayable hubs, and broadcasts to global/directory WebSocket clients.

## Design
- `payload-serialization.js` serializes each published payload once, in a small recent cache bounded by entry count and size, for replay accounting, queue accounting and byte-identical WS/SSE frames. Payloads are immutable after publication.
- `bounded-event-queue.js` owns per-connection pre-filter admission: 5,000 entries and 16 MiB including the active filter, pending envelopes and socket buffering. Global/directory WS, global SSE and legacy filtered broadcasts cancel queued work on disconnect or revocation. Overflow closes the client for ordinary replay/recovery; adapters check cancellation after awaited authorization before publishing.
- **Protocol module** (`protocol.js`) centralizes frame serialization/parsing constants.
- **Exactly-once hub + bridge architecture**: the global message hub stores a count/byte-bounded browser replay window and an independent bounded native event-ID dedupe window. Repeated non-empty upstream IDs are dropped before transformation, replay, and fanout; ID-less events remain distinct. Bridge runtimes are transport-only and never run journal, timing, audit, evidence, cache, or notification side effects. An optional generic `transformEventPayload` hook can transform the first accepted upstream payload before replay so live fanout and reconnect replay stay identical; transform failures fall back to the original event. Both native hub constructions (`server/index.js` and the fallback in `runtime.js`) pass `stripEventDiffContent` from `lib/opencode/diff-summary.js`, so `message.updated`/`session.updated` payloads reach the replay buffer and WS clients without diff patch bodies. Replay entries keep only the upstream envelope's routing fields (`eventId`, `directory`), never its untransformed payload.
- **Canonical ingestion** (`canonical-ingestion.js`) composes the raw-event side effects invoked only by the OpenCode watcher; the authoritative envelope directory is forwarded to the journal/session-change host for exact receipt ingestion. **Directory compatibility projection** (`compatibility-events.js`) is a pure status/activity mapper used by the scoped WebSocket bridge; the global bridge forwards synthetic events already published through the hub.
- **Resilient upstream reader** with reconnect and stall-timeout controls (`upstream-reader.js`).
- **Replay cursors** (`global-hub.js`) keep transport identity separate from payload IDs and assign boot-scoped cursors to ID-less events. Clients opting in with `X-DevRyan-Replay-Gap: 1` receive an ID-less `devryan.replay-gap` SSE control event before replay when their cursor is unavailable. The UI handles that named event before updating its cursor and excludes it from the application queue. Older SSE clients retain their existing behavior; WebSocket gap signalling is unchanged.
- **Subscription readiness** (`../opencode/v2/sse-routes.js`, registered by the native proxy): `X-DevRyan-Subscription-Ready: 1` opts global SSE clients into an ID-less `devryan.subscription-ready` control frame with `{type:'ready',scope:'global'}`. It follows principal registration, live event attachment, replay admission and actual upstream hub connectivity. The status listener is installed before checking or starting the hub; upstream disconnect closes opted-in downstream connections and releases their listeners. The frame creates no session activity or replay cursor. Clients without the header retain their previous behavior.
- A previously ready browser without a cursor can request `X-DevRyan-Replay-Unanchored: 1` on opted-in SSE or `replayUnanchored=1` on global WS. `global-hub.js` reuses its current bounded replay window and reports a gap, including for an empty window; principal filtering still applies. Initial cursor-free subscriptions skip history. Global WS clients close on upstream disconnect so the original reconnect path acquires fresh readiness rather than trusting a stale ready frame; directory WS behavior is unchanged.

- Global and directory WebSockets share the same native hub. Directory subscriptions retain directory and principal filters; reconnects emit gaps and reseed active status without upstream `Last-Event-ID`. An owned fallback hub requires an explicit native client and stops only when all directory/global clients disconnect or its runtime closes.

## Flow
1. Upstream SSE stream emits event envelopes.
2. The explicit generation-2 client parses data-only `/api/event` frames and projects native events into the shared UI vocabulary. Missing, legacy, and unknown runtime identities fail before fetch.
3. The watcher invokes canonical side effects once; the hub appends accepted IDs/payloads and transport bridges push frames to clients.
4. Late clients receive buffered replay before live stream continuation.

## Integration
- Called by `server/index.js` when wiring global event routes and WS handlers.
- Feeds UI live session/message state consumers.
- Shares runtime lifecycle with OpenCode watcher/network modules.
