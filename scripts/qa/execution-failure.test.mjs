import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLoopbackOpenCodeV2Fixture } from '../perf/loopback-opencode-v2-fixture.mjs';
import { createOpenCodeClient } from '../../packages/web/server/lib/opencode/opencode-client/index.js';
import { runExecutionFailureQa } from './execution-failure.mjs';

for (const skillOnly of [false, true]) test(`execution failure QA ${skillOnly ? 'reuses its selected skill' : 'creates its failure'} session through the authenticated generation-2 client`, async () => {
  const directory = '/qa-execution-failure-contract';
  const fixture = await createLoopbackOpenCodeV2Fixture({ directory });
  const selection = new Error('Browser rendering is outside this wire contract');
  const cdp = { waitFor: async () => {}, async send(method) {
    if (method === 'Runtime.evaluate') return { result: { value: 'ses_perfparent' } };
    assert.equal(method, 'Page.reload'); throw selection;
  } };
  try {
    await assert.rejects(runExecutionFailureQa({ fixture, cdp, directory, skillOnly,
      check: async (_label, action) => action(), screenshot: async () => {} }), error => error === selection);
    const client = createOpenCodeClient({ getRuntime: () => ({ generation: 2, baseUrl: fixture.origin }),
      getAuthHeaders: () => fixture.authHeaders });
    const expectedTitle = skillOnly ? 'Performance parent' : 'Local execution failure fixture';
    const sessions = await client.sessions.list({ directory });
    assert.equal(sessions.length, skillOnly ? 4 : 5);
    const sessionID = sessions.find(session => session.title === expectedTitle)?.id;
    assert.ok(sessionID);
    const session = await client.sessions.get(sessionID, { directory });
    assert.equal(session.directory, directory);
    assert.equal(session.projectID, sessions.find(row => row.id === 'ses_perfparent').projectID);
    assert.equal(session.title, expectedTitle);
    const { records } = await client.sessions.messages(sessionID, {}, { directory });
    assert.equal(records[0].parts[0].text, skillOnly ? 'Load the Checklist skill' : 'Read the fixture file');
    if (skillOnly) {
      const tool = records[1].parts.find(part => part.type === 'tool');
      assert.equal(tool?.tool, 'skill');
      assert.equal(tool.state.status, 'running');
    }
    assert.deepEqual(fixture.getState().unknownRoutes, []);
    assert.deepEqual(fixture.getState().locationRequired, []);
  } finally { await fixture.close(); }
});
