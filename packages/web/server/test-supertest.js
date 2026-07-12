import { Server as TlsServer } from 'node:tls';

import supertest from 'supertest';

const methodNames = Object.keys(supertest(() => {}));

const formatLoopbackHost = (address) => (
  address.family === 'IPv6' ? '[::1]' : '127.0.0.1'
);

class LoopbackTest extends supertest.Test {
  serverAddress(app, path) {
    if (!app.address()) {
      this._server = app.listen(0);
    }

    const address = app.address();
    if (!address || typeof address === 'string') {
      throw new Error('Supertest server did not expose a TCP address');
    }

    const protocol = app instanceof TlsServer ? 'https' : 'http';
    return `${protocol}://${formatLoopbackHost(address)}:${address.port}${path}`;
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
