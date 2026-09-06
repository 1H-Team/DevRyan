import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { CdpConnection, evaluate } from './cdp.mjs';
const requireElectron = createRequire(new URL('../../packages/electron/package.json', import.meta.url));
const { WebSocketServer } = requireElectron('ws');

test('CDP rejects pending commands promptly when the target closes', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  server.on('connection', (socket) => socket.on('message', () => socket.close()));
  const connection = await CdpConnection.connect(`ws://127.0.0.1:${server.address().port}`);
  try { await assert.rejects(connection.send('Runtime.evaluate'), /connection closed/); }
  finally { connection.close(); await new Promise((resolve) => server.close(resolve)); }
});

test('renderer exceptions cannot become successful QA observations', async () => {
  await assert.rejects(evaluate({ send: async () => ({ exceptionDetails: { text: 'fixture exception' } }) }, 'broken()'), /fixture exception/);
});
