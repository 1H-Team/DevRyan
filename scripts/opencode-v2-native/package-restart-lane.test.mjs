import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTrackedRestartDriver } from './package-restart-lane.mjs';

test('compiled restart driver holds completion even when original tool result and notice arrive together', () => {
  const driver = createTrackedRestartDriver('coexisting-notice');
  const request = messages => ({ body: { messages, tools: [{ function: { name: 'shell' } }] } });
  const initial = driver.responder(request([{ role: 'user', content: driver.marker }]));
  assert.equal(initial.items[0].input.background, true);
  const messages = [{ role: 'tool', tool_call_id: driver.callID, content: 'Shell command started (shell ID: job_fixture)' },
    { role: 'user', content: '<shell id="job_fixture" state="completed">done</shell>' }];
  const held = driver.responder(request(messages)); assert.equal(typeof held.then, 'function');
  assert.equal(driver.state().held, true); assert.equal(driver.state().completed, false);
  driver.resume(); const resumed = driver.responder(request(messages));
  assert.equal(resumed.items[0].text, 'completed coexisting-notice');
  assert.throws(() => driver.responder(request(messages)), /duplicate/);
});

test('compiled restart driver cannot resume an unrelated job or a response before the crash window', () => {
  const driver = createTrackedRestartDriver('exact-notice'); assert.throws(driver.resume);
  const request = messages => ({ body: { messages, tools: [{ function: { name: 'shell' } }] } });
  driver.responder(request([{ role: 'user', content: driver.marker }]));
  assert.throws(() => driver.responder(request([{ role: 'user', content: '<shell id="unrelated" state="completed">done</shell>' }])));
  assert.equal(driver.state().held, false);
});
