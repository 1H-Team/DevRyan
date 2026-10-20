import { describe, expect, mock, test } from 'bun:test';

const schema = { optional() { return this; }, int() { return this; }, min() { return this; }, max() { return this; }, describe() { return this; } };
const tool = (definition) => definition;
tool.schema = {
  array: () => schema,
  boolean: () => schema,
  enum: () => schema,
  number: () => schema,
  string: () => schema,
};
mock.module('@opencode-ai/plugin', () => ({ tool }));
const module = await import('../src-tauri/resources/default-config/plugins/devryan-managed-orchestration.mjs');
const { DevRyanManagedOrchestrationPlugin } = module;

const user = (metadata) => ({ info: { id: 'msg_user', role: 'user', sessionID: 'ses_root', metadata }, parts: [] });
const assistant = { info: { id: 'msg_assistant', role: 'assistant', sessionID: 'ses_root', parentID: 'msg_user' }, parts: [] };

describe('bundled managed orchestration Plan Mode identity', () => {
  test('accepts canonical and saved legacy metadata without enabling ordinary messages', async () => {
    const previousFetch = globalThis.fetch;
    const previousUrl = process.env.DEVRYAN_ORCHESTRATION_URL;
    const previousToken = process.env.DEVRYAN_ORCHESTRATION_TOKEN;
    const submitted = [];
    globalThis.fetch = async (_url, options) => {
      submitted.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok: true, result: { task: { taskId: 'task_1', status: 'running' } } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };
    process.env.DEVRYAN_ORCHESTRATION_URL = 'http://127.0.0.1:43210/rpc';
    process.env.DEVRYAN_ORCHESTRATION_TOKEN = 'test-token';
    try {
      expect(Object.keys(module)).toEqual(['DevRyanManagedOrchestrationPlugin']);
      for (const [metadata, readOnly] of [
        [{ devryanPlanMode: true }, true],
        [{ openchamberPlanMode: true }, true],
        [{ devryanPlanMode: false, openchamberPlanMode: true }, false],
        [{ devryanPlanMode: false }, false],
      ]) {
        const parent = user(metadata);
        const client = { session: { message: async ({ path }) => ({
          data: path.messageID === 'msg_assistant' ? assistant : parent,
        }) } };
        const plugin = await DevRyanManagedOrchestrationPlugin({ client });
        await plugin.tool.devryan_task.execute({ action: 'start', agent: 'explorer', prompt: 'Inspect only.',
          provider_id: 'test-provider', model_id: 'test-model' }, {
          sessionID: 'ses_root', messageID: 'msg_assistant', agent: 'orchestrator', directory: '/workspace',
          abort: new AbortController().signal,
        });
        expect(submitted.at(-1).method).toBe('submit');
        expect(submitted.at(-1).params.readOnly).toBe(readOnly);
      }
    } finally {
      globalThis.fetch = previousFetch;
      if (previousUrl === undefined) delete process.env.DEVRYAN_ORCHESTRATION_URL;
      else process.env.DEVRYAN_ORCHESTRATION_URL = previousUrl;
      if (previousToken === undefined) delete process.env.DEVRYAN_ORCHESTRATION_TOKEN;
      else process.env.DEVRYAN_ORCHESTRATION_TOKEN = previousToken;
    }
  });
});
