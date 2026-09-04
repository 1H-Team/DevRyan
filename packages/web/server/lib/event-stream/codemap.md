# packages/web/server/lib/event-stream/

## Responsibility
Real-time transport bridge for OpenCode events: parses upstream SSE envelopes, maintains replayable hubs, and broadcasts to global/directory WebSocket clients.

## Design
- **Protocol module** (`protocol.js`) centralizes frame serialization/parsing constants.
- **Exactly-once hub + bridge architecture**: the global message hub stores a count/byte-bounded replay window and a matching event-ID set. Repeated non-empty upstream IDs are dropped before transformation, replay, and fanout; ID-less events remain distinct. Bridge runtimes are transport-only and never run journal, timing, audit, evidence, cache, or notification side effects. An optional generic `transformEventPayload` hook can transform the first accepted upstream payload before replay so live fanout and reconnect replay stay identical; transform failures fall back to the original event. Both hub constructions (`server/index.js` and the fallback in `runtime.js`) pass `stripEventDiffContent` from `lib/opencode/diff-summary.js`, so `message.updated`/`session.updated` payloads reach the replay buffer and WS clients without diff patch bodies.
- **Canonical ingestion** (`canonical-ingestion.js`) composes the raw-event side effects invoked only by the OpenCode watcher, including optional context-mode IOERR recovery. **Directory compatibility projection** (`compatibility-events.js`) is a pure status/activity mapper used by the scoped WebSocket bridge; the global bridge forwards synthetic events already published through the hub.
- **Resilient upstream reader** with reconnect and stall-timeout controls (`upstream-reader.js`).

## Flow
1. Upstream SSE stream emits event envelopes.
2. `parseSseEventEnvelope` normalizes event payloads.
3. The watcher invokes canonical side effects once; the hub appends accepted IDs/payloads and transport bridges push frames to clients.
4. Late clients receive buffered replay before live stream continuation.

## Integration
- Called by `server/index.js` when wiring global event routes and WS handlers.
- Feeds UI live session/message state consumers.
- Shares runtime lifecycle with OpenCode watcher/network modules.
