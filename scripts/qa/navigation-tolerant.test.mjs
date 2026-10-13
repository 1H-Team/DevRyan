import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readThroughNavigation, observeReleaseNavigation } from './navigation-tolerant.mjs';

test('read probes retry only the exact navigation error under the original deadline', async () => {
  let calls = 0;
  const cdp = { send: async (_method, _params, { timeoutMs }) => {
    assert.ok(timeoutMs <= 1000);
    if (++calls === 1) throw Error('Inspected target navigated or closed');
    return { result: { value: 42 } };
  } };
  assert.equal(await readThroughNavigation(cdp, '42', { deadline: performance.now() + 1000 }), 42);
  assert.equal(calls, 2);
  for (const message of ['CDP connection closed', 'Cannot find context', 'Inspected target navigated or closed again']) {
    calls = 0;
    await assert.rejects(readThroughNavigation({ send: async () => { calls++; throw Error(message); } }, '42',
      { deadline: performance.now() + 1000 }), { message });
    assert.equal(calls, 1);
  }
  await assert.rejects(readThroughNavigation(cdp, '42', { deadline: performance.now() - 1 }), /deadline expired/);
});

test('readiness loops and terminal or service excess transitions cannot be hidden by successful reads', async () => {
  let listener;
  const cdp = { on: (_event, callback) => { listener = callback; return () => {}; }, send: async () => ({ result: { value: true } }) };
  const frame = (id, parentId) => listener({ frame: { url: 'http://127.0.0.1/', loaderId: id, parentId } });
  const audit = observeReleaseNavigation(cdp, 'data:startup', { initialLoaderId: 'startup' });
  frame('startup');
  frame('subframe', 'parent'); frame('app'); frame('app'); frame('reload'); audit.check();
  assert.equal(audit.phases[0].documents.length, 3);
  frame('loop');
  await assert.rejects(readThroughNavigation(cdp, 'true', { deadline: performance.now() + 1000, check: audit.check }), /Excess committed/);
  const terminal = observeReleaseNavigation(cdp, 'data:startup', { terminal: true, initialLoaderId: 'startup' });
  frame('failure'); terminal.check(); frame('loop'); assert.throws(terminal.check, /terminal-startup/);
  const handoff = observeReleaseNavigation(cdp, 'http://127.0.0.1/');
  handoff.handoff('service-enable'); frame('handoff'); handoff.check(); frame('extra');
  assert.throws(handoff.check, /service-enable/);
});

test('navigation retries do not extend a caller deadline', async () => {
  let calls = 0;
  await assert.rejects(readThroughNavigation({ send: async () => {
    calls++; throw Error('Inspected target navigated or closed');
  } }, 'true', { deadline: performance.now() + 20 }), /deadline expired/);
  assert.ok(calls >= 1 && calls <= 3);
});

test('one authentication reload requires principal initialization on the current local application origin', () => {
  const setup = (options = {}) => {
    const listeners = new Map();
    const audit = observeReleaseNavigation({ on: (name, listener) => {
      listeners.set(name, listener); return () => listeners.delete(name);
    } }, 'data:startup', { initialLoaderId: 'splash', ...options });
    const frame = id => listeners.get('Page.frameNavigated')({ frame: { url: 'http://127.0.0.1:1234/', loaderId: id } });
    const event = { storageId: { isLocalStorage: true, securityOrigin: 'http://127.0.0.1:1234' },
      key: 'devryan.auth.principalId', newValue: 'local-admin' };
    const initialize = (override = {}, updated = false) => listeners.get(`DOMStorage.domStorageItem${updated ? 'Updated' : 'Added'}`)({ ...event, ...override });
    return { audit, frame, initialize, listeners };
  };
  for (const updated of [false, true]) {
    const { audit, frame, initialize, listeners } = setup();
    frame('app'); initialize(updated ? { oldValue: 'anonymous' } : {}, updated);
    frame('auth'); frame('readiness'); audit.check();
    assert.equal(audit.phases[0].documents[2].authenticationReload.principal, 'local-admin');
    initialize(); frame('loop'); assert.throws(audit.check, /Excess committed/);
    audit.complete(); assert.equal(listeners.size, 0);
  }
  for (const override of [
    { key: 'another-key' }, { newValue: 'another-user' },
    { storageId: { isLocalStorage: false, securityOrigin: 'http://127.0.0.1:1234' } },
    { storageId: { isLocalStorage: true, securityOrigin: 'http://127.0.0.1:9999' } },
    { oldValue: 'local-admin' }, { oldValue: 'another-user' },
  ]) {
    const { audit, frame, initialize } = setup();
    frame('app'); initialize(override, 'oldValue' in override); frame('reload'); frame('extra');
    assert.throws(audit.check, /Excess committed/);
  }
  for (const terminal of [false, true]) {
    const { audit, frame, initialize } = setup({ terminal });
    if (!terminal) audit.handoff('service-enable');
    frame('first'); initialize(); frame('extra');
    assert.throws(audit.check, /Excess committed/);
  }
});
