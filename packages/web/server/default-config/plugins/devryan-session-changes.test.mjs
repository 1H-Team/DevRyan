import { afterEach, expect, test } from 'vitest';
import plugin from './devryan-session-changes.mjs';

const originalUrl = process.env.DEVRYAN_ORCHESTRATION_URL;
const originalToken = process.env.DEVRYAN_ORCHESTRATION_TOKEN;
afterEach(() => {
  if (originalUrl === undefined) delete process.env.DEVRYAN_ORCHESTRATION_URL; else process.env.DEVRYAN_ORCHESTRATION_URL = originalUrl;
  if (originalToken === undefined) delete process.env.DEVRYAN_ORCHESTRATION_TOKEN; else process.env.DEVRYAN_ORCHESTRATION_TOKEN = originalToken;
});

test('captures shell, file and MCP execution boundaries without parsing commands', async () => {
  process.env.DEVRYAN_ORCHESTRATION_URL = 'http://127.0.0.1:1/rpc';
  process.env.DEVRYAN_ORCHESTRATION_TOKEN = 'fixture';
  const calls = [];
  const hooks = await plugin({ directory: '/fixture', fetchImpl: async (_url, init) => {
    calls.push(JSON.parse(init.body)); return Response.json({ ok: true });
  } });
  for (const tool of ['bash', 'oc_bash', 'write', 'ctx_execute', 'mcp_custom_execution']) {
    await hooks['tool.execute.before']({ tool, sessionID: 'ses_a', callID: tool });
    await hooks['tool.execute.after']({ tool, sessionID: 'ses_a', callID: tool });
  }
  await hooks['tool.execute.before']({ tool: 'read', sessionID: 'ses_a', callID: 'read' });
  await hooks['tool.execute.before']({ tool: 'devryan_task', sessionID: 'ses_a', callID: 'dispatch' });
  await hooks['tool.execute.before']({ tool: 'council_session', sessionID: 'ses_a', callID: 'council' });
  expect(calls).toHaveLength(10);
  expect(calls[0]).toEqual({ method: 'session_changes', params: { action: 'before', sessionID: 'ses_a', callID: 'bash', directory: '/fixture' } });
});

test('external runtimes are not mutated', async () => {
  delete process.env.DEVRYAN_ORCHESTRATION_URL; delete process.env.DEVRYAN_ORCHESTRATION_TOKEN;
  expect(await plugin({ directory: '/fixture' })).toEqual({});
});
