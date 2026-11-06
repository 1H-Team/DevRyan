import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { promisify } from 'node:util';

// Test-only. Serves `https://<host>` from a local request handler per host, so
// Git in a test talks to the real host name (and formats its credential
// prompts for it) while nothing leaves the machine. Git reaches the hosts
// through a CONNECT proxy on 127.0.0.1 that terminates TLS with a throwaway
// self-signed certificate made by the openssl command-line tool.

const execFileAsync = promisify(execFile);
let secureContext = null;

const testSecureContext = () => {
  secureContext ||= (async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-test-certificate-'));
    try {
      const keyFile = path.join(directory, 'key.pem');
      const certificateFile = path.join(directory, 'certificate.pem');
      await execFileAsync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=devryan-test',
        '-keyout', keyFile, '-out', certificateFile,
      ]);
      return tls.createSecureContext({ key: await fs.readFile(keyFile), cert: await fs.readFile(certificateFile) });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  })();
  return secureContext;
};

// `handlers` maps a host name to an HTTP request handler. Returns the global Git
// configuration lines that send those hosts, and only those, through the
// proxy without verifying the certificate, and `close`, which ends every
// connection.
export const startHttpsHosts = async (handlers) => {
  const context = await testSecureContext();
  const servers = new Map(Object.entries(handlers).map(([host, handler]) => [host, http.createServer(handler)]));
  const sockets = new Set();
  const proxy = http.createServer((_request, response) => response.writeHead(405).end());
  proxy.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  proxy.on('connect', (request, socket, head) => {
    const target = /^([^:]+):443$/.exec(request.url || '');
    const server = target ? servers.get(target[1].toLowerCase()) : undefined;
    if (!server) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) socket.unshift(head);
    const secure = new tls.TLSSocket(socket, { isServer: true, secureContext: context });
    secure.on('error', () => {});
    server.emit('connection', secure);
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  return {
    gitConfig: [...servers.keys()].flatMap((host) => [
      `[http "https://${host}"]`,
      `\tproxy = ${proxyUrl}`,
      '\tsslVerify = false',
    ]),
    close: async () => {
      const closed = new Promise((resolve) => proxy.close(resolve));
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
};
