import { describe, expect, it, vi } from 'vitest';

import { createBotDockerProvider } from './docker-provider.js';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const RUN_ID = 'a0000000-0000-4000-8000-000000000001';
const CHANNEL_ID = 'c0000000-0000-4000-8000-000000000001';
const REVISION_ID = 'd0000000-0000-4000-8000-000000000001';
const OWNER_ID = 'e0000000-0000-4000-8000-000000000001';
const TOKEN = 't'.repeat(43);
const HASH = 'a'.repeat(64);
const PROXY_PATH = `/v1/runtime/${'p'.repeat(43)}`;

const ensureResult = (kind) => ({
  kind,
  name: `devryan-bot-${kind}-abc123`,
  state: 'running',
  endpoint: {
    host: '127.0.0.1',
    port: kind === 'reasoning' ? 55101 : 55102,
    ...(kind === 'reasoning' ? { path: PROXY_PATH } : {}),
  },
  image: `sha256:${'b'.repeat(64)}`,
  replaced: false,
});

const createHost = () => ({
  owner: 'electron',
  ensureReasoning: vi.fn(async () => ensureResult('reasoning')),
  ensureComputer: vi.fn(async () => ensureResult('computer')),
  inspect: vi.fn(async (target) => ({
    kind: target.kind,
    name: `devryan-bot-${target.kind}-abc123`,
    state: 'running',
    endpoint: {
      host: '127.0.0.1',
      port: 55101,
      ...(target.kind === 'reasoning' ? { path: PROXY_PATH } : {}),
    },
    image: `sha256:${'b'.repeat(64)}`,
  })),
  stop: vi.fn(async (target) => ({
    name: `devryan-bot-${target.kind}-abc123`,
    state: 'stopped',
  })),
  reset: vi.fn(async (target) => ({
    name: `devryan-bot-${target.kind}-abc123`,
    state: 'reset',
    removed: target.kind === 'reasoning' ? ['workspace'] : ['profile'],
  })),
  writeWorkspace: vi.fn(async (input) => ({
    written: true,
    path: input.path,
    bytes: Buffer.byteLength(input.content, 'utf8'),
    sha256: 'a'.repeat(64),
  })),
  importSharedFile: vi.fn(async (input) => ({
    written: true,
    path: input.resourcePath
      ? `/workspace/Resources/${input.resourcePath}`
      : `/workspace/Shared/${input.channelId}/${input.messageId}/${input.filename}`,
    bytes: input.expectedSize,
    sha256: input.sha256,
  })),
});

describe('typed Electron Bot Docker provider', () => {
  it('derives reasoning scope and forwards only the fixed ensure contract', async () => {
    const botHost = createHost();
    const provider = createBotDockerProvider({ botHost });
    const result = await provider.ensureReasoning({
      botId: BOT_ID,
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      revisionId: REVISION_ID,
      runtimeToken: TOKEN,
      compiledHash: HASH,
      gatewayUrl: 'http://host.docker.internal:55100',
      egressHosts: ['api.openai.com:443'],
      environmentSecretCount: 0,
      chatgptImageGeneration: true,
    });
    expect(result.endpoint.baseUrl).toBe(`http://127.0.0.1:55101${PROXY_PATH}`);
    expect(botHost.ensureReasoning).toHaveBeenCalledWith(Object.freeze({
      botId: BOT_ID,
      scopeKey: `channel:${CHANNEL_ID}`,
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      revisionId: REVISION_ID,
      runtimeToken: TOKEN,
      compiledHash: HASH,
      gatewayUrl: 'http://host.docker.internal:55100',
      egressHosts: ['api.openai.com:443'],
      environmentSecretCount: 0,
      chatgptImageGeneration: true,
    }));
  });

  it('derives one shared computer scope per Bot without accepting raw Docker options', async () => {
    const botHost = createHost();
    const provider = createBotDockerProvider({ botHost });
    // Legacy records may still say 'personalized'; every owner still lands on
    // the Bot's single shared computer.
    await provider.ensureComputer({
      botId: BOT_ID,
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      revisionId: REVISION_ID,
      runtimeToken: TOKEN,
      tenancy: 'personalized',
      ownerUserId: OWNER_ID,
      gatewayUrl: 'http://host.docker.internal:55100',
      browserNetworkMode: 'public_only',
      browserEgressHosts: [],
      isolationTier: 'standard',
    });
    expect(botHost.ensureComputer).toHaveBeenCalledWith(expect.objectContaining({
      scopeKey: `bot:${BOT_ID}`,
      scopeMode: 'team',
    }));
    await expect(provider.ensureComputer({
      botId: BOT_ID,
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      revisionId: REVISION_ID,
      runtimeToken: TOKEN,
      tenancy: 'team',
      ownerUserId: OWNER_ID,
      gatewayUrl: 'http://host.docker.internal:55100',
      browserNetworkMode: 'public_only',
      browserEgressHosts: [],
      isolationTier: 'standard',
      command: ['docker', 'run', '--privileged'],
    })).rejects.toMatchObject({ code: 'bot_runtime_request_invalid' });
    expect(botHost.ensureComputer).toHaveBeenCalledTimes(1);
  });

  it('supports only typed inspect/stop targets and rejects non-loopback host responses', async () => {
    const botHost = createHost();
    const provider = createBotDockerProvider({ botHost });
    await expect(provider.inspectReasoning({ botId: BOT_ID, channelId: CHANNEL_ID }))
      .resolves.toMatchObject({
        state: 'running',
        endpoint: { baseUrl: `http://127.0.0.1:55101${PROXY_PATH}` },
      });
    await expect(provider.stopComputer({ botId: BOT_ID, tenancy: 'team', ownerUserId: OWNER_ID }))
      .resolves.toMatchObject({ state: 'stopped' });

    botHost.inspect.mockResolvedValueOnce({
      kind: 'reasoning',
      name: 'devryan-bot-reasoning-abc123',
      state: 'running',
      endpoint: { host: '0.0.0.0', port: 55101, path: PROXY_PATH },
      image: 'sha256:unsafe',
    });
    await expect(provider.inspectReasoning({ botId: BOT_ID, channelId: CHANNEL_ID }))
      .rejects.toMatchObject({ code: 'bot_runtime_endpoint_invalid' });

    botHost.inspect.mockResolvedValueOnce({
      kind: 'computer',
      name: 'devryan-bot-computer-abc123',
      state: 'absent',
    });
    await expect(provider.inspectComputer({
      botId: BOT_ID,
      tenancy: 'personalized',
      ownerUserId: OWNER_ID,
    })).resolves.toMatchObject({ state: 'absent', endpoint: null, image: null });
  });

  it('resets only reviewed scope-owned volume roles', async () => {
    const botHost = createHost();
    const provider = createBotDockerProvider({ botHost });

    await expect(provider.resetReasoning({ botId: BOT_ID, channelId: CHANNEL_ID }, 'workspace'))
      .resolves.toMatchObject({ state: 'reset', removed: ['workspace'] });
    expect(botHost.reset).toHaveBeenCalledWith({
      kind: 'reasoning',
      botId: BOT_ID,
      scopeKey: `channel:${CHANNEL_ID}`,
      resource: 'workspace',
    });
    await expect(provider.resetComputer({
      botId: BOT_ID,
      tenancy: 'personalized',
      ownerUserId: OWNER_ID,
    }, 'profile')).resolves.toMatchObject({ state: 'reset', removed: ['profile'] });
    await expect(provider.resetComputer({
      botId: BOT_ID,
      tenancy: 'team',
      ownerUserId: OWNER_ID,
    }, 'workspace')).rejects.toMatchObject({ code: 'bot_runtime_request_invalid' });
  });

  it('writes only a bounded top-level file into the derived channel workspace', async () => {
    const botHost = createHost();
    const provider = createBotDockerProvider({ botHost });
    await expect(provider.writeWorkspace({
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      path: 'approval-check.txt',
      content: 'BOT_APPROVAL_OK',
    })).resolves.toMatchObject({ written: true, path: 'approval-check.txt', bytes: 15 });
    expect(botHost.writeWorkspace).toHaveBeenCalledWith({
      botId: BOT_ID,
      scopeKey: `channel:${CHANNEL_ID}`,
      path: 'approval-check.txt',
      content: 'BOT_APPROVAL_OK',
    });
    await expect(provider.writeWorkspace({
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      path: '../outside',
      content: 'blocked',
    })).rejects.toMatchObject({ code: 'bot_runtime_request_invalid' });
    expect(botHost.writeWorkspace).toHaveBeenCalledTimes(1);
  });

  it('imports a bounded nested file into the Bot computer Resources folder', async () => {
    const botHost = createHost();
    const provider = createBotDockerProvider({ botHost });
    const bytes = Buffer.from('handbook', 'utf8');
    await expect(provider.importSharedFile({
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      messageId: RUN_ID,
      filename: 'start.md',
      resourcePath: 'manuals/start.md',
      bytes,
    })).resolves.toMatchObject({
      written: true,
      path: '/workspace/Resources/manuals/start.md',
      bytes: 8,
    });
    expect(botHost.importSharedFile).toHaveBeenCalledWith(expect.objectContaining({
      botId: BOT_ID,
      scopeKey: `bot:${BOT_ID}`,
      resourcePath: 'manuals/start.md',
      contentBase64: bytes.toString('base64'),
      expectedSize: bytes.byteLength,
    }));
    await expect(provider.importSharedFile({
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      messageId: RUN_ID,
      filename: 'secret',
      resourcePath: '../secret',
      bytes,
    })).rejects.toMatchObject({ code: 'bot_runtime_request_invalid' });
    expect(botHost.importSharedFile).toHaveBeenCalledTimes(1);
  });

  it('fails closed outside Electron or when any fixed callback is absent', async () => {
    for (const botHost of [
      { owner: 'unsupported' },
      { ...createHost(), stop: undefined },
    ]) {
      const provider = createBotDockerProvider({ botHost });
      expect(provider.available).toBe(false);
      await expect(provider.inspectReasoning({ botId: BOT_ID, channelId: CHANNEL_ID }))
        .rejects.toMatchObject({ code: 'bot_runtime_unsupported_host', statusCode: 503 });
    }
  });
});
