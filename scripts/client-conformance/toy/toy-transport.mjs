// Harness-owned toy transport module (self-test corpus of the client
// conformance harness): a WebSocket client with reconnect, a fetch load and a
// drain of an injected async stream. Its ports are the global WebSocket and
// fetch, the injected sdk and onEvent, and the logger module. Package C0f adds
// what the product's transport families do: the window it dispatches an Event
// on, an options object with a callback handed to the sdk, answers awaited
// together, and the logger's session id, a data export drawn at load. The C0f
// fix round adds a job of the module's own racing an immediate answer, and an
// api object injected at a key of the options. Product code never imports it.
import { log, logSession } from './toy-log.mjs';

export function connect(sdk, options) {
  const { url, onEvent } = options;
  const clientId = crypto.randomUUID();
  let closed = false;
  let retries = 0;
  const received = [];
  let socket = null;
  let unsubscribe = null;
  const open = () => {
    socket = new WebSocket(`${url}?client=${clientId}&attempt=${retries}&log=${logSession}`);
    socket.onmessage = (message) => {
      const event = JSON.parse(message.data);
      received.push(event.type);
      onEvent({ ...event, tag: log('event', event.type) });
    };
    socket.onclose = () => {
      if (closed) return;
      retries += 1;
      setTimeout(open, 10 * retries);
    };
  };
  open();
  return {
    async load(session) {
      const response = await fetch(`${url}/session/${session}`, { method: 'GET', headers: { accept: 'application/json' } });
      const body = await response.json();
      onEvent({ type: 'loaded', body, tag: log('loaded', body.id) });
      return body;
    },
    async drain() {
      let count = 0;
      for await (const event of sdk.events()) {
        count += 1;
        onEvent(event);
        if (event.type === 'done') break;
      }
      return count;
    },
    async loadAll(sessions) {
      const responses = await Promise.all(sessions.map((session) => fetch(`${url}/session/${session}`)));
      onEvent({ type: 'loaded-all', count: responses.length });
      return responses.map((response) => response.ok);
    },
    async loadBodies(sessions) {
      const responses = await Promise.all(sessions.map((session) => fetch(`${url}/session/${session}`)));
      const bodies = await Promise.all(responses.map((response) => response.json()));
      return bodies.map((body) => body.id);
    },
    // Answers the module does not wait for, beside one it does (the bootstrap's optional enrichment): their places
    // among the jobs of one drain decide where the entry's own answer lands.
    async loadAside(sessions) {
      const [first, ...rest] = sessions;
      for (const session of rest) void fetch(`${url}/session/${session}`).then((response) => { onEvent({ type: 'aside', ok: response.ok }); });
      const response = await fetch(`${url}/session/${first}`);
      onEvent({ type: 'first', ok: response.ok });
      return response.ok;
    },
    // An answer and a job of the module's own that no effect shows (the C0f fix round): what the continuation sees
    // depends on the very generation the answer is given at.
    async loadRace(session, hops) {
      let seen = 'before';
      void (async () => { for (let index = 0; index < hops; index += 1) await undefined; seen = 'after'; })();
      const response = await fetch(`${url}/session/${session}`);
      onEvent({ type: 'race', seen, ok: response.ok });
      return seen;
    },
    // The options as they were handed in (the C0f fix round): with an object injected at a key of them (the api), the
    // module holds a wrapper around them, and hands back the very options object.
    settings() { return options; },
    ping() { return options.api.ping(url); },
    async loadUnless(session, signal) {
      const response = await fetch(`${url}/session/${session}`, { signal });
      return signal.aborted ? null : response.ok;
    },
    subscribe(topic) {
      const items = [];
      // The sdk answers an unsubscribe function: a port of its own (`sdk.subscribe#<call>`), called later.
      unsubscribe = sdk.subscribe({ topic, onItem: (item) => { items.push(item); onEvent({ type: 'item', item }); } }) ?? null;
      return items;
    },
    stopSubscription() { return unsubscribe ? unsubscribe() : null; },
    announce() {
      if (typeof window === 'undefined') return false;
      return window.dispatchEvent(new Event('toy:connected'));
    },
    send(payload) { socket.send(JSON.stringify(payload)); return received.length; },
    close() { closed = true; socket.close(); },
  };
}
