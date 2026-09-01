import fs from 'node:fs/promises';
import { describe, expect, test } from 'bun:test';

import plugin, * as exports from './devryan-bot-tools.mjs';

const TOKEN = 'runtime-token-0123456789abcdef0123456789';
const environment = () => ({
  DEVRYAN_BOT_GATEWAY_URL: 'http://host.docker.internal:57123',
  DEVRYAN_BOT_RUNTIME_TOKEN: TOKEN,
  DEVRYAN_BOT_RUN_ID: 'run-01',
  DEVRYAN_BOT_CHANNEL_ID: 'channel-01',
  DEVRYAN_BOT_REVISION_ID: 'revision-01',
  DEVRYAN_BOT_CHATGPT_IMAGE_GENERATION: '0',
});

const toolApi = Object.assign((definition) => definition, {
  schema: {
    enum: (values) => ({ type: 'enum', values }),
    unknown: () => ({ type: 'unknown' }),
    string: () => ({ type: 'string' }),
  },
});

describe('scoped OpenCode Bot plugin', () => {
  test('exports functions only so OpenCode can load every export as a factory', () => {
    expect(plugin).toBeFunction();
    expect(Object.values(exports).every((value) => typeof value === 'function')).toBe(true);
  });

  test('publishes an explicit approval-gated workspace write tool with call-bound idempotency', async () => {
    const calls = [];
    const loaded = await exports.__test.createPlugin({
      toolApi,
      environment: environment(),
      fetchImpl: async (_url, options) => {
        calls.push(JSON.parse(options.body));
        return new Response(JSON.stringify({
          ok: true,
          result: { written: true, path: 'approval-check.txt' },
        }));
      },
    });

    await expect(loaded.tool.devryan_write.execute({
      path: 'approval-check.txt',
      content: 'BOT_APPROVAL_OK',
    }, { callID: 'call_workspace_1' })).resolves.toBe(JSON.stringify({
      written: true,
      path: 'approval-check.txt',
    }));
    await expect(loaded.tool.devryan_write.execute({
      path: '/workspace/approval-check.txt',
      content: 'BOT_APPROVAL_OK',
    }, { callID: 'call_workspace_2' })).resolves.toBe(JSON.stringify({
      written: true,
      path: 'approval-check.txt',
    }));
    await expect(loaded.tool.devryan_write.execute({
      path: '/approval-check.txt',
      content: 'BOT_APPROVAL_OK',
    }, { callID: 'call_workspace_3' })).resolves.toBe(JSON.stringify({
      written: true,
      path: 'approval-check.txt',
    }));
    expect(calls).toEqual([{
      runId: 'run-01',
      channelId: 'channel-01',
      revisionId: 'revision-01',
      operation: 'workspace.write',
      payload: {
        idempotencyKey: 'call_workspace_1',
        path: 'approval-check.txt',
        content: 'BOT_APPROVAL_OK',
      },
    }, {
      runId: 'run-01',
      channelId: 'channel-01',
      revisionId: 'revision-01',
      operation: 'workspace.write',
      payload: {
        idempotencyKey: 'call_workspace_2',
        path: 'approval-check.txt',
        content: 'BOT_APPROVAL_OK',
      },
    }, {
      runId: 'run-01',
      channelId: 'channel-01',
      revisionId: 'revision-01',
      operation: 'workspace.write',
      payload: {
        idempotencyKey: 'call_workspace_3',
        path: 'approval-check.txt',
        content: 'BOT_APPROVAL_OK',
      },
    }]);
    await expect(loaded.tool.devryan_write.execute({
      path: '../outside',
      content: 'blocked',
    }, { callID: 'call_workspace_4' })).rejects.toMatchObject({
      code: 'DEVRYAN_BOT_INPUT_INVALID',
    });
    await expect(loaded.tool.devryan_write.execute({
      path: '/workspace/../outside',
      content: 'blocked',
    }, { callID: 'call_workspace_5' })).rejects.toMatchObject({
      code: 'DEVRYAN_BOT_INPUT_INVALID',
    });
  });

  test('binds identity to environment capability and never accepts caller-supplied identity', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ ok: true, result: { accepted: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const loaded = await exports.__test.createPlugin({
      toolApi,
      environment: environment(),
      fetchImpl,
    });
    const result = await loaded.tool.devryan_bot.execute({
      operation: 'computer.command',
      payload: { command: 'snapshot' },
    }, {});

    expect(result).toBe(JSON.stringify({ accepted: true }));
    expect(loaded.tool.devryan_bot.description).toContain('persistent browser connector');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://host.docker.internal:57123/api/bots/private/gateway');
    expect(calls[0].options.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].options.redirect).toBe('error');
    expect(JSON.parse(calls[0].options.body)).toEqual({
      runId: 'run-01',
      channelId: 'channel-01',
      revisionId: 'revision-01',
      operation: 'computer.command',
      payload: { command: 'snapshot' },
    });

    await expect(loaded.tool.devryan_bot.execute({
      operation: 'computer.command',
      payload: { channelId: 'another-channel', command: 'snapshot' },
    }, {})).rejects.toMatchObject({ code: 'DEVRYAN_BOT_INPUT_INVALID' });
  });

  test('returns stable errors for invalid configuration, transport, and gateway rejection', async () => {
    await expect(exports.__test.createPlugin({
      toolApi,
      environment: { ...environment(), DEVRYAN_BOT_GATEWAY_URL: 'http://example.com' },
    })).rejects.toMatchObject({ code: 'DEVRYAN_BOT_CONFIG_INVALID' });

    const unavailable = await exports.__test.createPlugin({
      toolApi,
      environment: environment(),
      fetchImpl: async () => { throw new Error('secret transport detail'); },
    });
    await expect(unavailable.tool.devryan_bot.execute({
      operation: 'memory.search',
      payload: { query: 'project' },
    }, {})).rejects.toMatchObject({ code: 'DEVRYAN_BOT_GATEWAY_UNAVAILABLE' });

    const rejected = await exports.__test.createPlugin({
      toolApi,
      environment: environment(),
      fetchImpl: async () => new Response(JSON.stringify({
        ok: false,
        error: { code: 'DEVRYAN_BOT_APPROVAL_REQUIRED', message: 'Approval required' },
      }), { status: 409 }),
    });
    await expect(rejected.tool.devryan_bot.execute({
      operation: 'action.request',
      payload: { action: 'send' },
    }, {})).rejects.toMatchObject({ code: 'DEVRYAN_BOT_APPROVAL_REQUIRED' });
  });

  test('publishes only the reviewed gateway operation inventory', () => {
    expect(exports.__test.OPERATIONS).toEqual([
      'action.request',
      'artifact.get',
      'artifact.put',
      'computer.command',
      'image.generate',
      'library.search',
      'memory.search',
      'workspace.write',
    ]);
  });

  test('publishes an exact dedicated image tool only for a server-granted OAuth capability', async () => {
    let credentialChecks = 0;
    const execute = async (input, context) => ({
      output: `Generated image saved to ${input.out}.`,
      metadata: { out: `/workspace/${input.out}` },
      context,
    });
    const args = {
      prompt: toolApi.schema.string(),
      out: toolApi.schema.string(),
      quality: toolApi.schema.enum(['low', 'medium', 'high', 'auto']),
    };
    const loaded = await exports.__test.createPlugin({
      toolApi,
      environment: { ...environment(), DEVRYAN_BOT_CHATGPT_IMAGE_GENERATION: '1' },
      imageToolFactory: async () => ({ args, execute }),
      beforeImage: async () => { credentialChecks++; },
    });
    expect(loaded.tool.devryan_bot.args.operation.values).not.toContain('image.generate');
    expect(loaded.tool.devryan_bot.description).toContain('separate devryan_image tool');
    expect(loaded.tool.devryan_image.args).toBe(args);
    await expect(loaded.tool.devryan_image.execute({
      prompt: 'A blue square', out: 'blue.png', quality: 'medium',
    }, { directory: '/workspace' })).resolves.toMatchObject({
      metadata: { out: '/workspace/blue.png' },
    });
    // The legacy executor remains callable for persisted tool parts, but is no
    // longer advertised to the model.
    await expect(loaded.tool.devryan_bot.execute({
      operation: 'image.generate',
      payload: { prompt: 'A blue square', out: 'blue.png', quality: 'medium' },
    }, { directory: '/workspace' })).resolves.toMatchObject({
      metadata: { out: '/workspace/blue.png' },
    });

    const unavailable = await exports.__test.createPlugin({
      toolApi,
      environment: environment(),
      imageToolFactory: async () => ({ args, execute }),
    });
    expect(credentialChecks).toBe(2);
    expect(unavailable.tool.devryan_image).toBeUndefined();
    expect(unavailable.tool.devryan_bot.args.operation.values).not.toContain('image.generate');
    await expect(unavailable.tool.devryan_bot.execute({
      operation: 'image.generate',
      payload: { prompt: 'A blue square', out: 'blue.png', quality: 'medium' },
    }, {})).rejects.toMatchObject({
      code: 'bot_image_generation_unavailable',
    });
    await expect(loaded.tool.devryan_bot.execute({
      operation: 'image.generate',
      payload: { prompt: 'No escape', out: '/tmp/blue.png', quality: 'medium' },
    }, {})).rejects.toMatchObject({ code: 'DEVRYAN_BOT_INPUT_INVALID' });
    await expect(loaded.tool.devryan_image.execute({
      prompt: 'No escape', out: '/tmp/blue.png', quality: 'medium',
    }, {})).rejects.toMatchObject({ code: 'DEVRYAN_BOT_INPUT_INVALID' });
  });

  test('pins the image and generates one autonomous but fail-closed Bot agent', async () => {
    const [entrypoint, dockerfile] = await Promise.all([
      fs.readFile(new URL('../docker/opencode/entrypoint.sh', import.meta.url), 'utf8'),
      fs.readFile(new URL('../docker/opencode/Dockerfile', import.meta.url), 'utf8'),
    ]);
    expect(entrypoint.match(/mode: 'primary'/g)).toHaveLength(1);
    expect(entrypoint).toContain('test -r "$SOURCE_PLUGIN"');
    expect(entrypoint).toContain("'*': 'deny'");
    const primary = entrypoint.slice(entrypoint.indexOf('bot: {'), entrypoint.indexOf('explore: {'));
    for (const tool of [
      'read', 'write', 'edit', 'glob', 'grep', 'bash', 'terminal', 'git', 'task',
      'devryan_bot', 'devryan_image', 'devryan_write',
    ]) {
      expect(primary).toContain(`${tool}: 'allow'`);
    }
    for (const tool of [
      'devryan_task', 'browser', 'devryan_browser', 'mcp', 'external_directory',
    ]) {
      expect(primary).toContain(`${tool}: 'deny'`);
    }
    const subagents = entrypoint.slice(entrypoint.indexOf('explore: {'));
    expect(subagents).toContain("task: 'deny'");
    expect(subagents).toContain("devryan_bot: 'deny'");
    expect(subagents).toContain("devryan_image: 'deny'");
    expect(subagents).toContain("browser: 'deny'");
    expect(dockerfile).toContain('opencode-ai@1.18.25 @opencode-ai/plugin@1.18.25 opencode-gpt-imagegen@0.1.10');
    expect(dockerfile).toContain("node_modules/opencode-gpt-imagegen/package.json");
    expect(entrypoint).toContain('launch-opencode.mjs');
    expect(dockerfile).toContain('bash=5.2.15-2+b13');
    expect(dockerfile).toContain('ca-certificates=20250419~deb12u1');
    expect(dockerfile).toContain('git=1:2.39.5-0+deb12u3');
    expect(dockerfile).toContain('ripgrep=13.0.0-4+b2');
    expect(dockerfile).toContain('USER 10001:10001');
  });
});
