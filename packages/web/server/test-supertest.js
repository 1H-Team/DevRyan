import { Server as TlsServer } from 'node:tls';

import supertest from 'supertest';

const methodNames = Object.keys(supertest(() => {}));

const formatLoopbackHost = (address) => (
  address.family === 'IPv6' ? '[::1]' : '127.0.0.1'
);

const loopbackUrl = (app, path) => {
  const address = app.address();
  if (!address || typeof address === 'string') {
    throw new Error('Supertest server did not expose a TCP address');
  }

  const protocol = app instanceof TlsServer ? 'https' : 'http';
  return `${protocol}://${formatLoopbackHost(address)}:${address.port}${path}`;
};

// supertest's own `app.listen(0)` binds the dual-stack wildcard (::). macOS can
// give that listener an ephemeral port another local process already holds on
// 127.0.0.1 or ::1 (OpenCode, Docker, a running DevRyan), and the more specific
// foreign socket then answers instead of the app: spurious failures, or a
// foreign 401/403 passing an assertion. An explicit loopback listener is the
// only possible responder. It binds asynchronously, so `end()` waits for it.
const pendingListeners = new WeakMap();

const listenOnLoopback = (server) => {
  const listening = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  }).finally(() => pendingListeners.delete(server));
  pendingListeners.set(server, listening);
  return listening;
};

class LoopbackTest extends supertest.Test {
  serverAddress(app, path) {
    if (app.address()) {
      return loopbackUrl(app, path);
    }

    let listening = pendingListeners.get(app);
    if (!listening) {
      // Like supertest, the request that starts the listener closes it.
      this._server = app;
      listening = listenOnLoopback(app);
    }
    this._loopbackListening = listening.then(() => {
      this.url = loopbackUrl(app, path);
    });
    return path;
  }

  end(fn) {
    const listening = this._loopbackListening;
    if (!listening) {
      return super.end(fn);
    }

    this._loopbackListening = null;
    listening.then(
      () => super.end(fn),
      (error) => fn?.call(this, error),
    );
    return this;
  }
}

const request = (app, options = {}) => {
  const result = {};

  for (const method of methodNames) {
    result[method] = (path) => {
      const test = new LoopbackTest(app, method, path, options.http2);
      if (options.http2) {
        test.http2();
      }
      return test;
    };
  }

  result.del = result.delete;
  return result;
};

export default request;
