// Harness-owned toy transport module (self-test corpus of the client
// conformance harness): a WebSocket client with reconnect, a fetch load and a
// drain of an injected async stream. Its ports are the global WebSocket and
// fetch, the injected sdk and onEvent, and the logger module. Product code
// never imports it.
import { log } from './toy-log.mjs';

export function connect(sdk, { url, onEvent }) {
  const clientId = crypto.randomUUID();
  let closed = false;
  let retries = 0;
  const received = [];
  let socket = null;
  const open = () => {
    socket = new WebSocket(`${url}?client=${clientId}&attempt=${retries}`);
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
    send(payload) { socket.send(JSON.stringify(payload)); return received.length; },
    close() { closed = true; socket.close(); },
  };
}
