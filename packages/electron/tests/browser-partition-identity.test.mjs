import assert from 'node:assert/strict';
import test from 'node:test';
import { selectBrowserPartitionIdentity } from '../browser-partition-identity.mjs';

test('fresh profiles use DevRyan partitions and existing profiles retain cookies and storage', () => {
  const fresh = selectBrowserPartitionIdentity({ userDataDirectory: '/private/@devryan/electron', readDirectory: () => [] });
  assert.deepEqual(fresh, { shared: 'persist:devryan-browser', manualPrefix: 'persist:devryan-browser-user-',
    agentPrefix: 'persist:devryan-browser-agent-', legacy: false });
  const oldProfile = selectBrowserPartitionIdentity({ userDataDirectory: '/private/@openchamber/electron', readDirectory: () => [] });
  assert.equal(oldProfile.shared, 'persist:openchamber-browser');
  assert.equal(oldProfile.legacy, true);
  const customProfile = selectBrowserPartitionIdentity({ userDataDirectory: '/private/custom',
    readDirectory: () => ['openchamber-browser-user-abc'] });
  assert.equal(customProfile.manualPrefix, 'persist:openchamber-browser-user-');
  assert.equal(customProfile.agentPrefix, 'persist:openchamber-browser-agent-');
});

test('missing partition storage starts canonical while unexpected I/O failures stay visible', () => {
  assert.equal(selectBrowserPartitionIdentity({ userDataDirectory: '/private/custom',
    readDirectory: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } }).legacy, false);
  assert.throws(() => selectBrowserPartitionIdentity({ userDataDirectory: '/private/custom',
    readDirectory: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } }), /denied/);
});
