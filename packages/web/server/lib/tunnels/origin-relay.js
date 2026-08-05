import net from 'node:net';

const LOOPBACK_HOST = '127.0.0.1';

export class ManagedRemoteOriginRelayError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ManagedRemoteOriginRelayError';
    this.code = code;
    this.details = details;
  }
}

const closeServer = (server) => new Promise((resolve, reject) => {
  if (!server.listening) {
    resolve();
    return;
  }
  server.close((error) => {
    if (error) {
      reject(error);
      return;
    }
    resolve();
  });
});

export async function startLoopbackOriginRelay({
  originPort,
  targetPort,
  netImpl = net,
}) {
  const cloudflareOriginUrl = `http://${LOOPBACK_HOST}:${originPort}`;
  const activeOriginUrl = `http://${LOOPBACK_HOST}:${targetPort}`;

  if (originPort === targetPort) {
    return {
      active: false,
      cloudflareOriginUrl,
      activeOriginUrl,
      stop: async () => true,
    };
  }

  const sockets = new Set();
  const server = netImpl.createServer({ allowHalfOpen: true }, (clientSocket) => {
    const upstreamSocket = netImpl.createConnection({
      host: LOOPBACK_HOST,
      port: targetPort,
      allowHalfOpen: true,
    });

    sockets.add(clientSocket);
    sockets.add(upstreamSocket);

    const forgetSockets = () => {
      sockets.delete(clientSocket);
      sockets.delete(upstreamSocket);
    };
    const destroyPair = () => {
      clientSocket.destroy();
      upstreamSocket.destroy();
    };

    clientSocket.once('error', destroyPair);
    upstreamSocket.once('error', destroyPair);
    clientSocket.once('close', forgetSockets);
    upstreamSocket.once('close', forgetSockets);

    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      const code = error?.code === 'EADDRINUSE'
        ? 'managed_remote_origin_port_in_use'
        : 'managed_remote_origin_relay_failed';
      const message = error?.code === 'EADDRINUSE'
        ? `Managed remote origin port ${originPort} is already in use.`
        : `Could not bind the managed remote origin relay on ${cloudflareOriginUrl}.`;
      reject(new ManagedRemoteOriginRelayError(code, message, {
        cloudflareOriginUrl,
        activeOriginUrl,
      }));
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: LOOPBACK_HOST, port: originPort, exclusive: true });
  });
  server.unref?.();

  let stopPromise = null;
  const stop = () => {
    if (stopPromise) {
      return stopPromise;
    }
    stopPromise = (async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
      await closeServer(server);
      return true;
    })();
    return stopPromise;
  };

  return {
    active: true,
    cloudflareOriginUrl,
    activeOriginUrl,
    stop,
  };
}
