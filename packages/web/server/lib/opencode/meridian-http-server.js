import { EventEmitter } from 'node:events';

// Bun 1.3.14's node:http response does not emit close on client disconnect.
// Preserve the native Request signal for Meridian's existing cancellation path.
export const serveMeridianHttp = (options, onListening, serveNode, bun = globalThis.Bun) => {
  if (!bun?.serve) return serveNode(options, onListening);

  const server = new EventEmitter();
  const native = bun.serve({
    hostname: options.hostname,
    port: options.port,
    idleTimeout: options.idleTimeoutSeconds,
    fetch: options.fetch,
  });
  server.listening = true;
  const address = { address: native.hostname, family: native.hostname.includes(':') ? 'IPv6' : 'IPv4', port: native.port };
  server.address = () => server.listening ? address : null;
  let closePromise;
  server.close = (callback) => {
    server.listening = false;
    closePromise ??= Promise.resolve(native.stop()).then(() => { server.emit('close'); });
    closePromise.then(() => callback?.(), error => callback?.(error));
    return server;
  };
  server.closeAllConnections = () => { void Promise.resolve(native.stop(true)).catch(error => server.emit('error', error)); };
  server.ref = () => { native.ref(); return server; };
  server.unref = () => { native.unref(); return server; };
  queueMicrotask(() => { onListening?.(address); server.emit('listening'); });
  return server;
};
