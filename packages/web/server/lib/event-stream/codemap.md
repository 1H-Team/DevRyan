# packages/web/server/lib/event-stream/

## Responsibility
Real-time transport bridge for OpenCode events: parses upstream SSE envelopes, maintains replayable hubs, and broadcasts to global/directory WebSocket clients.

## Design
- `payload-serialization.js` serializes each published payload once, in a small recent cache bounded by entry count and size, for replay accounting, queue accounting and byte-identical WS/SSE frames. Payloads are immutable after publication.
- `bounded-event-queue.js` owns per-connection pre-filter admission: 5,000 entries and 16 MiB including the active filter, pending envelopes and socket buffering. Global/directory WS, global SSE and legacy filtered broadcasts cancel queued work on disconnect or revocation. Overflow closes the client for ordinary replay/recovery; adapters check cancellation after awaited authorization before publishing.
- **Protocol module** (`protocol.js`) centralizes frame serialization/parsing constants.
- **Exactly-once hub + bridge architecture**: the global message hub stores a count/byte-bounded replay window and a matching event-ID set. Repeated non-empty upstream IDs are dropped before transformation, replay, and fanout; ID-less events remain distinct. Bridge runtimes are transport-only and never run journal, timing, audit, evidence, cache, or notification side effects. An optional generic `transformEventPayload` hook can transform the first accepted upstream payload before replay so live fanout and reconnect replay stay identical; transform failures fall back to the original event. Both hub constructions (`server/index.js` and the fallback in `runtime.js`) pass `stripEventDiffContent` from `lib/opencode/diff-summary.js`, so `message.updated`/`session.updated` payloads reach the replay buffer and WS clients without diff patch bodies. Replay entries keep only the upstream envelope's routing fields (`eventId`, `directory`), never its untransformed payload.
- **Canonical ingestion** (`canonical-ingestion.js`) composes the raw-event side effects invoked only by the OpenCode watcher; the authoritative envelope directory is forwarded to the journal/session-change host for exact receipt ingestion. **Directory compatibility projection** (`compatibility-events.js`) is a pure status/activity mapper used by the scoped WebSocket bridge; the global bridge forwards synthetic events already published through the hub.
- **Resilient upstream reader** with reconnect and stall-timeout controls (`upstream-reader.js`).
- **Replay cursors** (`global-hub.js`) keep transport identity separate from payload IDs and assign boot-scoped cursors to ID-less events. Clients opting in with `X-DevRyan-Replay-Gap: 1` receive an ID-less `devryan.replay-gap` SSE control event before replay when their cursor is unavailable. The UI handles that named event before updating its cursor and excludes it from the application queue. Older SSE clients retain their existing behavior; WebSocket gap signalling is unchanged.

## Flow
1. Upstream SSE stream emits event envelopes.
2. `parseSseEventEnvelope` normalizes event payloads.
3. The watcher invokes canonical side effects once; the hub appends accepted IDs/payloads and transport bridges push frames to clients.
4. Late clients receive buffered replay before live stream continuation.

## Integration
- Called by `server/index.js` when wiring global event routes and WS handlers.
- Feeds UI live session/message state consumers.
- Shares runtime lifecycle with OpenCode watcher/network modules.
