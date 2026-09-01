import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBotModelCredentialBroker } from './model-credential-broker.js';
import { createOpenAiOAuthCoordinator } from '../opencode/openai-oauth-coordinator.js';
import { oauthAccountKey } from './host-oauth-connections.js';

const RUN_ID = 'a0000000-0000-4000-8000-000000000001';
const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const CHANNEL_ID = 'c0000000-0000-4000-8000-000000000001';
const REVISION_ID = 'd0000000-0000-4000-8000-000000000001';
const OWNER_ID = 'e0000000-0000-4000-8000-000000000001';
const PRIMARY_CREDENTIAL = 'f0000000-0000-4000-8000-000000000001';
const FALLBACK_CREDENTIAL = 'f0000000-0000-4000-8000-000000000002';
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

const makeDirectory = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-model-broker-'));
  temporaryDirectories.push(directory);
  return directory;
};

const run = () => ({
  id: RUN_ID,
  botId: BOT_ID,
  channelId: CHANNEL_ID,
  revisionId: REVISION_ID,
  ownerUserId: OWNER_ID,
  updatedAt: '2026-08-22T12:00:00.000Z',
});

const models = () => ({
  primary: {
    providerId: 'openai',
    modelId: 'gpt-5.6-sol',
    credentialId: PRIMARY_CREDENTIAL,
    egressHosts: ['api.openai.com:443'],
    variant: 'high',
  },
  fallbacks: [{
    providerId: 'anthropic',
    modelId: 'claude-opus-4-6',
    credentialId: FALLBACK_CREDENTIAL,
    egressHosts: ['api.anthropic.com:443'],
  }],
});

const createVault = (records = {}) => ({
  read: vi.fn(async (id) => {
    const record = records[id];
    if (!record) throw Object.assign(new Error('missing'), { code: 'bot_credential_not_found' });
    return {
      credential: {
        id,
        botId: BOT_ID,
        provider: id === PRIMARY_CREDENTIAL ? 'openai' : 'anthropic',
        status: 'active',
      },
      secret: structuredClone(record),
    };
  }),
  create: vi.fn(async () => ({})),
  rotate: vi.fn(async (id, secret) => {
    records[id] = structuredClone(secret);
    return {};
  }),
});

const oauthDependencies = () => {
  const oauthCoordinator = createOpenAiOAuthCoordinator({ readAuth: () => ({ type: 'oauth', accountId: 'account-a', access: 'host-access', refresh: 'host-refresh', expires: Date.now() + 3600000 }) });
  oauthCoordinator.markReady();
  return { oauthCoordinator, store: { repositories: { bot_credentials: { get: async () => ({ id: PRIMARY_CREDENTIAL, bot_id: BOT_ID,
    provider: 'openai', kind: 'oauth', credential_scope: 'team', owner_user_id: null, status: 'active',
    metadata: { connectionId: 'host:openai', oauthAccountKey: oauthAccountKey('account-a') } }) } } } };
};

describe('Bot model credential broker', () => {
  it('preflights selection without materializing plaintext auth or mutating the run', async () => {
    const dataDirectory = await makeDirectory();
    const recordSelectedModel = vi.fn(async () => ({}));
    const broker = createBotModelCredentialBroker({
      dataDirectory,
      credentialVault: createVault({
        [PRIMARY_CREDENTIAL]: { type: 'api', key: 'primary-secret' },
      }),
      recordSelectedModel,
    });

    const checked = await broker.preflightRun({
      run: {
        id: RUN_ID,
        botId: BOT_ID,
        channelId: CHANNEL_ID,
        revisionId: REVISION_ID,
        ownerUserId: OWNER_ID,
      },
      models: models(),
      catalog: {
        providers: [{
          id: 'openai',
          models: {
            'gpt-5.6-sol': {
              egressHosts: ['api.openai.com:443'],
              limit: { context: 200_000 },
            },
          },
        }],
      },
    });

    expect(checked.modelSnapshot).toMatchObject({
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      contextLimit: 200_000,
    });
    expect(recordSelectedModel).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(dataDirectory, 'bots', 'runtime', 'auth')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses the same reviewed OAuth authorities when the live catalog omits transport metadata', async () => {
    const dataDirectory = await makeDirectory();
    const broker = createBotModelCredentialBroker({
      ...oauthDependencies(),
      dataDirectory,
      credentialVault: createVault({
        [PRIMARY_CREDENTIAL]: {
          type: 'oauth', access: 'primary-access', refresh: 'primary-refresh',
        },
      }),
      recordSelectedModel: vi.fn(async () => ({})),
    });
    const oauthModels = models();
    oauthModels.primary.egressHosts = ['auth.openai.com:443', 'chatgpt.com:443'];
    const { updatedAt: _updatedAt, ...preflightRun } = run();

    const checked = await broker.preflightRun({
      run: preflightRun,
      models: oauthModels,
      catalog: {
        providers: [{ id: 'openai', models: [{ id: 'gpt-5.6-sol' }] }],
      },
    });

    expect(checked.modelSnapshot.egressHosts).toEqual([
      'auth.openai.com:443',
      'chatgpt.com:443',
    ]);
  });

  it('selects the primary only when catalog, credential, and exact egress hosts pass', async () => {
    const dataDirectory = await makeDirectory();
    const vault = createVault({
      [PRIMARY_CREDENTIAL]: { type: 'api', key: 'primary-key' },
    });
    const recordSelectedModel = vi.fn(async () => ({}));
    const broker = createBotModelCredentialBroker({
      dataDirectory,
      credentialVault: vault,
      recordSelectedModel,
      now: () => new Date('2026-08-22T12:30:00.000Z'),
    });

    const prepared = await broker.prepareRun({
      run: run(),
      models: models(),
      catalog: [{
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        available: true,
        egressHosts: ['https://api.openai.com'],
      }],
    });

    expect(prepared).toMatchObject({
      model: { providerId: 'openai', modelId: 'gpt-5.6-sol', variant: 'high' },
      credentialId: PRIMARY_CREDENTIAL,
      egressHosts: ['api.openai.com:443'],
      modelSnapshot: { candidateIndex: 0, selectedAt: '2026-08-22T12:30:00.000Z' },
    });
    expect(recordSelectedModel).toHaveBeenCalledWith({
      run: run(),
      snapshot: prepared.modelSnapshot,
    });
    const scoped = JSON.parse(await fs.readFile(path.join(prepared.authDirectory, 'auth.json'), 'utf8'));
    expect(scoped).toEqual({
      openai: { type: 'api', key: 'primary-key' },
    });
    expect(JSON.stringify(prepared)).not.toContain('primary-access');
  });

  it('materializes a provisional warm credential without writing an unadmitted run', async () => {
    const dataDirectory = await makeDirectory();
    const recordSelectedModel = vi.fn(async () => ({}));
    const broker = createBotModelCredentialBroker({
      dataDirectory,
      credentialVault: createVault({
        [PRIMARY_CREDENTIAL]: { type: 'api', key: 'primary-key' },
      }),
      recordSelectedModel,
    });

    const prepared = await broker.prepareProvisionalRun({
      run: run(),
      models: models(),
      catalog: [{
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        egressHosts: ['api.openai.com:443'],
      }],
    });

    expect(prepared.provisional).toBe(true);
    expect(recordSelectedModel).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(prepared.authDirectory, 'auth.json'))).resolves.toBeTruthy();
    expect(await broker.discardRun(RUN_ID)).toBe(true);
    await expect(fs.stat(prepared.authDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses ordered fallback and never accepts a caller model override', async () => {
    const dataDirectory = await makeDirectory();
    const vault = createVault({
      [FALLBACK_CREDENTIAL]: { type: 'api', key: 'fallback-secret' },
    });
    const broker = createBotModelCredentialBroker({
      dataDirectory,
      credentialVault: vault,
      recordSelectedModel: vi.fn(async () => ({})),
    });
    const prepared = await broker.prepareRun({
      run: run(),
      models: models(),
      catalog: [{
        providerId: 'anthropic',
        modelId: 'claude-opus-4-6',
        egressHosts: ['api.anthropic.com:443'],
      }],
    });
    expect(prepared.model).toMatchObject({ providerId: 'anthropic', modelId: 'claude-opus-4-6' });
    expect(prepared.modelSnapshot.candidateIndex).toBe(1);

    await expect(broker.prepareRun({
      run: { ...run(), modelOverride: 'attacker/model' },
      models: models(),
      catalog: [],
    })).rejects.toMatchObject({ code: 'bot_model_selection_invalid' });
  });

  it('rejects malformed DNS authorities before falling back', async () => {
    const dataDirectory = await makeDirectory();
    const configuredModels = models();
    configuredModels.primary.egressHosts = ['api..openai.com:443'];
    const broker = createBotModelCredentialBroker({
      dataDirectory,
      credentialVault: createVault({
        [PRIMARY_CREDENTIAL]: { type: 'api', key: 'primary-secret' },
        [FALLBACK_CREDENTIAL]: { type: 'api', key: 'fallback-secret' },
      }),
      recordSelectedModel: vi.fn(async () => ({})),
    });

    const prepared = await broker.prepareRun({
      run: run(),
      models: configuredModels,
      catalog: [
        {
          providerId: 'openai',
          modelId: 'gpt-5.6-sol',
          egressHosts: ['api..openai.com:443'],
        },
        {
          providerId: 'anthropic',
          modelId: 'claude-opus-4-6',
          egressHosts: ['api.anthropic.com:443'],
        },
      ],
    });

    expect(prepared.model).toMatchObject({
      providerId: 'anthropic',
      modelId: 'claude-opus-4-6',
    });
    expect(prepared.modelSnapshot.candidateIndex).toBe(1);
  });

  it('returns the stable unavailable error without writing a run or auth file when every candidate fails', async () => {
    const dataDirectory = await makeDirectory();
    const recordSelectedModel = vi.fn(async () => ({}));
    const broker = createBotModelCredentialBroker({
      dataDirectory,
      credentialVault: createVault(),
      recordSelectedModel,
    });
    await expect(broker.prepareRun({
      run: run(),
      models: models(),
      catalog: [
        { providerId: 'openai', modelId: 'gpt-5.6-sol', egressHosts: ['localhost:443'] },
        { providerId: 'anthropic', modelId: 'claude-opus-4-6', egressHosts: ['api.anthropic.com:443'] },
      ],
    })).rejects.toMatchObject({ code: 'bot_model_unavailable', statusCode: 503 });
    expect(recordSelectedModel).not.toHaveBeenCalled();
    await expect(fs.readdir(path.join(dataDirectory, 'bots', 'runtime', 'auth')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not disguise transient or integrity failures as model fallback misses', async () => {
    const dataDirectory = await makeDirectory();
    const vault = createVault();
    vault.read.mockRejectedValueOnce(Object.assign(new Error('vault transport failed'), {
      code: 'ECONNRESET',
    }));
    const broker = createBotModelCredentialBroker({
      dataDirectory,
      credentialVault: vault,
      recordSelectedModel: vi.fn(async () => ({})),
    });

    await expect(broker.prepareRun({
      run: run(),
      models: models(),
      catalog: [{
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        egressHosts: ['api.openai.com:443'],
      }],
    })).rejects.toMatchObject({ code: 'ECONNRESET' });
  });

  it('uses a bound host login without copying refresh tokens or accepting stale run writeback', async () => {
    const dataDirectory = await makeDirectory();
    const vault = createVault();
    let host = { type: 'oauth', access: 'host-access', refresh: 'host-refresh',
      accountId: 'account-a', expires: Date.now() + 3600000 };
    const coordinator = createOpenAiOAuthCoordinator({ readAuth: () => host });
    coordinator.markReady();
    const credentialRow = {
      id: PRIMARY_CREDENTIAL,
      bot_id: BOT_ID,
      provider: 'openai',
      kind: 'oauth',
      credential_scope: 'user',
      owner_user_id: OWNER_ID,
      status: 'active',
      created_by: OWNER_ID,
      metadata: { label: 'Selected OpenAI account', connectionId: 'host:openai', oauthAccountKey: oauthAccountKey('account-a') },
    };
    const broker = createBotModelCredentialBroker({
      dataDirectory,
      credentialVault: vault,
      store: {
        repositories: {
          bot_credentials: { get: vi.fn(async () => credentialRow) },
        },
      },
      recordSelectedModel: vi.fn(async () => ({})),
      oauthCoordinator: coordinator,
    });
    const prepared = await broker.prepareRun({
      run: run(),
      models: { ...models(), primary: { ...models().primary, egressHosts: ['auth.openai.com:443', 'chatgpt.com:443'] } },
      catalog: [{
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        egressHosts: ['auth.openai.com:443', 'chatgpt.com:443'],
      }],
    });
    expect(vault.create).not.toHaveBeenCalled();
    const newerRunId = 'a0000000-0000-4000-8000-000000000002';
    await broker.prepareRun({ run: { ...run(), id: newerRunId },
      models: { ...models(), primary: { ...models().primary, egressHosts: ['auth.openai.com:443', 'chatgpt.com:443'] } },
      catalog: [{ providerId: 'openai', modelId: 'gpt-5.6-sol' }] });
    expect(await fs.readFile(path.join(prepared.authDirectory, 'auth.json'), 'utf8')).not.toMatch(/host-access|host-refresh/);
    await expect(broker.assertRuntimeReady(RUN_ID)).rejects.toMatchObject({ code: 'bot_oauth_runtime_update_required' });
    const claims = { runId: RUN_ID, botId: BOT_ID, channelId: CHANNEL_ID, revisionId: REVISION_ID, kind: 'reasoning' };
    await broker.runtimeOAuth(claims, 'ready');
    await broker.assertRuntimeReady(RUN_ID);
    host = { ...host, access: 'new-login', refresh: 'new-refresh' };
    expect(await broker.runtimeOAuth(claims, 'access')).toMatchObject({ accessToken: 'new-login' });
    for (const change of [{ botId: OWNER_ID }, { runId: OWNER_ID }, { channelId: OWNER_ID }, { revisionId: OWNER_ID }, { kind: 'computer' }]) {
      await expect(broker.runtimeOAuth({ ...claims, ...change }, 'access')).rejects.toMatchObject({ code: 'bot_oauth_access_denied' });
    }
    host = { ...host, accountId: 'account-b' };
    await expect(broker.assertRuntimeReady(RUN_ID)).rejects.toMatchObject({ code: 'bot_opencode_provider_authentication' });

    await fs.writeFile(path.join(prepared.authDirectory, 'auth.json'), JSON.stringify({
      openai: { type: 'oauth', access: 'refreshed-access', refresh: 'refreshed-token' },
    }), { mode: 0o600 });
    await expect(broker.finalizeRun(newerRunId)).resolves.toEqual({ removed: true, refreshed: false });
    await expect(broker.finalizeRun(RUN_ID)).resolves.toEqual({ removed: true, refreshed: false });
    expect(host.access).toBe('new-login');
    expect(vault.rotate).not.toHaveBeenCalled();
    await expect(broker.runtimeOAuth(claims, 'access')).rejects.toMatchObject({ code: 'bot_oauth_access_denied' });
    await expect(fs.stat(prepared.authDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
