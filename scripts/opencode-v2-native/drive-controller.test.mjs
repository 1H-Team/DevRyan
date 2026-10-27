import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachDriveController } from './drive-controller.mjs';

const capabilities = ['llm.attach', 'llm.request', 'llm.chunk', 'llm.finish', 'llm.disconnect'];
class Socket extends EventTarget {
  sent = [];
  ignore;
  constructor(ignore) { super(); this.ignore = ignore; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
  message(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  send(value) {
    const request = JSON.parse(value); this.sent.push(request);
    if (request.method === this.ignore) return;
    queueMicrotask(() => this.message({ jsonrpc: '2.0', id: request.id, result: request.method === 'simulation.handshake'
      ? { protocolVersion: 1, role: 'backend', capabilities } : { ok: true } }));
  }
  close() { this.dispatchEvent(new Event('close')); }
  invoke(id = 'inv_1') { this.message({ jsonrpc: '2.0', method: 'llm.request', params: { id, url: 'https://api.openai.com/v1/chat/completions', body: {} } }); }
}
const turn = () => new Promise(resolve => setImmediate(resolve));
const attach = (socket, responder, options = {}) => attachDriveController('ws://127.0.0.1:1234', responder,
  { connect: () => socket, timeoutMs: 100, ...options });

test('model tool calls use llm chunks; no simulated tools are attached', async () => {
  const socket = new Socket();
  const driver = await attach(socket, () => ({ items: [{ type: 'toolCall', index: 0, id: 'call_1', name: 'read', input: { filePath: 'fixture' } }], reason: 'tool-calls' }));
  socket.invoke(); await turn(); await turn();
  assert.deepEqual(socket.sent.map(value => value.method), ['simulation.handshake', 'llm.attach', 'llm.chunk', 'llm.finish']);
  assert.equal(driver.requests.length, 1); driver.check(); await driver.close();
});

test('a failed responder never becomes a successful model finish', async () => {
  const socket = new Socket(); const driver = await attach(socket, () => { throw new Error('assertion failed'); });
  socket.invoke(); await turn();
  assert.throws(driver.check, /assertion failed/);
  assert.equal(socket.sent.some(value => value.method === 'llm.finish'), false);
  await assert.rejects(driver.close(), /assertion failed/);
});

test('duplicate invocations fail and shutdown cancels an unresolved responder', async () => {
  const socket = new Socket(); const driver = await attach(socket, () => new Promise(() => {}));
  socket.invoke(); socket.invoke(); await turn();
  assert.throws(driver.check, /duplicate/); await assert.rejects(driver.close(), /duplicate/);
  const otherSocket = new Socket(); const other = await attach(otherSocket, () => new Promise(() => {}));
  otherSocket.invoke(); await turn(); await other.close();
});

test('missing RPC reply is a bounded failure', async () => {
  const socket = new Socket('llm.attach');
  await assert.rejects(attach(socket, () => ({ items: [], reason: 'stop' }), { timeoutMs: 10 }), /RPC timed out/);
});

test('unknown notifications and request bounds fail closed', async () => {
  const socket = new Socket(); const driver = await attach(socket, () => new Promise(() => {}), { maxRequests: 1 });
  socket.invoke(); socket.invoke('inv_2'); await turn();
  assert.throws(driver.check, /bound exceeded/); await assert.rejects(driver.close(), /bound exceeded/);
  const otherSocket = new Socket(); const other = await attach(otherSocket, () => ({ items: [], reason: 'stop' }));
  otherSocket.message({ jsonrpc: '2.0', method: 'tool.invocation', params: {} });
  assert.throws(other.check, /Malformed/); await assert.rejects(other.close(), /Malformed/);
});
