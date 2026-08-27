import { describe, expect, it, vi } from 'vitest';

import { encryptBotJson } from './encryption.js';
import { createBotManagement } from './management.js';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const REVISION_ID = 'c0000000-0000-4000-8000-000000000001';
const EVAL_ID = 'd0000000-0000-4000-8000-000000000001';
const RUN_ID = 'e0000000-0000-4000-8000-000000000001';
const USER_ID = 'a0000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = 'a0000000-0000-4000-8000-000000000002';
const NOW = '2026-08-23T00:00:00.000Z';
const KEY = Buffer.alloc(32, 7);

const bot = {
  id: BOT_ID,
  name: 'Research Desk',
  lifecycle: 'active',
  tenancy: 'team',
  active_revision_id: null,
  created_by: USER_ID,
  created_at: NOW,
  updated_at: NOW,
  retired_at: null,
};

const contract = {
  identity: { title: 'Research Desk', avatar: 'R' },
  objectives: ['Review requests'],
  tone: 'Direct',
  operatingInstructions: 'Follow policy',
  prohibitedInstructions: 'Never bypass approval',
  advancedPrompt: '',
  tenancy: 'team',
  standingRole: 'You are a research Bot.',
  models: {
    primary: {
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      credentialId: 'f0000000-0000-4000-8000-000000000001',
      egressHosts: ['api.openai.com:443'],
    },
    fallbacks: [],
  },
  reasoning: { effort: 'medium' },
  fileTools: ['read'],
  gatewayPluginVersion: 'devryan-bot-tools@1.0.0',
  libraryVersionIds: [],
  memoryPolicy: { automaticExtraction: true, retrievalLimit: 12 },
  actionPolicy: { defaultEffect: 'deny', defaultRisk: 'sensitive', rules: [] },
  browserPolicy: { allowedOrigins: [], deniedOrigins: [] },
};

const revision = {
  id: REVISION_ID,
  bot_id: BOT_ID,
  revision_number: 2,
  contract,
  compiled_hash: 'a'.repeat(64),
  created_by: USER_ID,
  created_at: NOW,
  updated_at: NOW,
  activated_at: null,
  retired_at: null,
};

const membership = (userId = USER_ID, role = 'manager') => ({
  bot_id: BOT_ID,
  user_id: userId,
  role,
  assigned_by: USER_ID,
  activated_at: NOW,
  revoked_at: null,
  created_at: NOW,
  updated_at: NOW,
});

const principal = { id: USER_ID, role: 'developer', scope: 'managed' };

const createHarness = ({
  get = vi.fn(async (table) => table === 'bot_revisions' ? revision : null),
  list = vi.fn(async () => ({ items: [], nextCursor: null })),
  insert = vi.fn(),
  updateIfRevision = vi.fn(),
  publishRevision = vi.fn(),
  testRunner = { run: vi.fn(async () => ({ passed: true })) },
  encryption = { getKey: async () => Buffer.from(KEY) },
  authorization: authorizationOverride = null,
  blobStore = null,
  loadModelCatalog,
  resolveCapabilities,
  preflightModel,
  preflightCapabilities,
  credentialVault = null,
  readHostProviderAuth = vi.fn(() => null),
  eventStream = null,
  audit = vi.fn(async () => {}),
} = {}) => {
  const store = {
    available: true,
    get,
    list,
    insert,
    updateIfRevision,
    publishRevision,
    createBot: vi.fn(),
    activateRevision: vi.fn(),
  };
  const authorization = authorizationOverride || {
    requireManager: vi.fn(async () => ({ bot, membership: membership() })),
  };
  return {
    store,
    authorization,
    testRunner,
    credentialVault,
    eventStream,
    audit,
    management: createBotManagement({
      store,
      authorization,
      encryption,
      testRunner,
      blobStore,
      loadModelCatalog,
      resolveCapabilities,
      preflightModel,
      preflightCapabilities,
      getCredentialVault: () => credentialVault,
      readHostProviderAuth,
      eventStream,
      audit,
      uuid: vi.fn(() => RUN_ID),
      now: () => new Date(NOW),
    }),
  };
};

describe('Bot management control plane', () => {
  it('projects Bot creation from the same global-admin and durable-actor rule used by create', async () => {
    const harness = createHarness({
      list: vi.fn(async () => ({ items: [bot], nextCursor: null })),
    });
    const administrator = { id: USER_ID, role: 'admin', scope: 'managed' };

    expect(harness.management.canCreateBot(administrator)).toBe(true);
    expect(harness.management.canCreateBot(principal)).toBe(false);
    expect(harness.management.canCreateBot({
      id: 'local-admin', role: 'admin', scope: 'local-admin',
    })).toBe(false);
    await expect(harness.management.listCatalog(administrator)).resolves.toMatchObject({
      bots: [{ id: BOT_ID }],
      canCreateBot: true,
    });
  });

  it('loads an empty-eval Bot detail without unlocking the credential vault', async () => {
    const getKey = vi.fn(async () => {
      throw Object.assign(new Error('sealed'), { code: 'bot_key_locked' });
    });
    const harness = createHarness({
      get: vi.fn(async (table) => table === 'bots' ? bot : null),
      list: vi.fn(async (table) => ({
        items: table === 'bot_revisions' ? [revision] : [],
        nextCursor: null,
      })),
      encryption: { getKey },
    });

    await expect(harness.management.getDetail(
      { id: USER_ID, role: 'admin', scope: 'managed' },
      BOT_ID,
    )).resolves.toMatchObject({
      bot: { id: BOT_ID },
      revisions: [{ id: REVISION_ID }],
      evalCases: [],
    });
    expect(getKey).not.toHaveBeenCalled();
  });

  it('propagates optimistic Draft revision conflicts as stable 409 errors', async () => {
    const conflict = Object.assign(new Error('changed'), {
      code: 'bot_revision_conflict',
      statusCode: 409,
    });
    const harness = createHarness({
      updateIfRevision: vi.fn(async () => { throw conflict; }),
    });

    await expect(harness.management.updateDraftRevision(principal, BOT_ID, REVISION_ID, {
      contract,
      expectedUpdatedAt: NOW,
    })).rejects.toMatchObject({ code: 'bot_revision_conflict', statusCode: 409 });
    expect(harness.store.updateIfRevision).toHaveBeenCalledWith(
      'bot_revisions',
      { id: REVISION_ID, bot_id: BOT_ID },
      expect.objectContaining({
        contract: expect.objectContaining({
          ...contract,
          // Server-derived: the client cannot set these.
          gatewayPluginVersion: 'devryan-bot-tools@1.2.0',
          operatingInstructions: '',
          prohibitedInstructions: '',
          advancedPrompt: '',
          skillBindings: [],
          mcpBindings: [],
        }),
      }),
      NOW,
    );
  });

  it('enforces structured identity and objective fields at the server boundary', async () => {
    const harness = createHarness();
    await expect(harness.management.updateDraftRevision(principal, BOT_ID, REVISION_ID, {
      contract: { ...contract, identity: { ...contract.identity, title: '' } },
      expectedUpdatedAt: NOW,
    })).rejects.toMatchObject({ code: 'bot_revision_contract_invalid', statusCode: 400 });
    await expect(harness.management.updateDraftRevision(principal, BOT_ID, REVISION_ID, {
      contract: { ...contract, objectives: [] },
      expectedUpdatedAt: NOW,
    })).rejects.toMatchObject({ code: 'bot_revision_contract_invalid', statusCode: 400 });
    expect(harness.store.updateIfRevision).not.toHaveBeenCalled();
  });

  it('keeps capability bindings behind their dedicated Draft mutation service', async () => {
    const pinnedRevision = {
      ...revision,
      contract: {
        ...contract,
        skillBindings: [{ id: '10000000-0000-4000-8000-000000000001', digest: 'a'.repeat(64) }],
        mcpBindings: [],
      },
    };
    const updateIfRevision = vi.fn(async (_table, _keys, changes) => ({
      ...pinnedRevision,
      ...changes,
      updated_at: '2026-08-23T00:01:00.000Z',
    }));
    const harness = createHarness({
      get: vi.fn(async (table) => table === 'bot_revisions' ? pinnedRevision : null),
      updateIfRevision,
    });

    await expect(harness.management.updateDraftRevision(principal, BOT_ID, REVISION_ID, {
      contract: {
        ...contract,
        skillBindings: [{ id: '10000000-0000-4000-8000-000000000002', digest: 'b'.repeat(64) }],
        mcpBindings: [],
      },
      expectedUpdatedAt: NOW,
    })).rejects.toMatchObject({ code: 'bot_capability_binding_mutation_required', statusCode: 409 });
    expect(updateIfRevision).not.toHaveBeenCalled();

    await expect(harness.management.updateDraftRevision(principal, BOT_ID, REVISION_ID, {
      contract,
      expectedUpdatedAt: NOW,
    })).resolves.toMatchObject({
      revision: {
        contract: expect.objectContaining({ skillBindings: pinnedRevision.contract.skillBindings }),
      },
    });
  });

  it('protects the final Manager before persistence and permits revocation after reassignment', async () => {
    const updateIfRevision = vi.fn(async () => ({ ...membership(), revoked_at: NOW }));
    const get = vi.fn(async (table) => table === 'bot_memberships' ? membership() : null);
    const onlyManager = createHarness({
      get,
      list: vi.fn(async () => ({ items: [membership()], nextCursor: null })),
      updateIfRevision,
    });
    await expect(onlyManager.management.revokeMembership(principal, BOT_ID, USER_ID, {
      expectedUpdatedAt: NOW,
    })).rejects.toMatchObject({ code: 'bot_final_manager_required', statusCode: 409 });
    expect(updateIfRevision).not.toHaveBeenCalled();

    const withReplacement = createHarness({
      get,
      list: vi.fn(async () => ({
        items: [membership(), membership(OTHER_USER_ID)],
        nextCursor: null,
      })),
      updateIfRevision,
    });
    await expect(withReplacement.management.revokeMembership(principal, BOT_ID, USER_ID, {
      expectedUpdatedAt: NOW,
    })).resolves.toMatchObject({ membership: { revokedAt: NOW } });
  });

  it('assigns a new membership through explicit table-owned fields', async () => {
    const insert = vi.fn(async (_table, input) => ({
      ...input,
      created_at: NOW,
      updated_at: NOW,
    }));
    const harness = createHarness({
      get: vi.fn(async () => null),
      insert,
    });
    await expect(harness.management.setMembership(principal, BOT_ID, {
      userId: OTHER_USER_ID,
      role: 'operator',
    })).resolves.toMatchObject({ membership: { userId: OTHER_USER_ID, role: 'operator' } });
    expect(insert).toHaveBeenCalledWith('bot_memberships', expect.objectContaining({
      bot_id: BOT_ID,
      user_id: OTHER_USER_ID,
      role: 'operator',
      assigned_by: USER_ID,
    }));
  });

  it('redacts secret-shaped credential metadata before it reaches Supabase', async () => {
    const current = {
      id: RUN_ID,
      bot_id: BOT_ID,
      provider: 'openai',
      kind: 'api_key',
      credential_scope: 'team',
      owner_user_id: null,
      local_vault_reference: `bot-credential:${RUN_ID}`,
      metadata: { label: 'Old label' },
      status: 'active',
      created_by: USER_ID,
      revoked_at: null,
      created_at: NOW,
      updated_at: NOW,
    };
    const updateIfRevision = vi.fn(async (_table, _keys, changes) => ({
      ...current,
      ...changes,
      updated_at: '2026-08-23T00:01:00.000Z',
    }));
    const harness = createHarness({
      get: vi.fn(async (table) => table === 'bot_credentials' ? current : null),
      updateIfRevision,
    });

    const result = await harness.management.saveCredentialMetadata(principal, BOT_ID, {
      id: RUN_ID,
      provider: 'openai',
      kind: 'api_key',
      credentialScope: 'team',
      ownerUserId: null,
      metadata: {
        label: 'Production',
        apiKey: 'must-not-persist',
        maskedIdentifier: 'raw-unmasked-secret',
        rotatedAt: 'not-a-timestamp',
      },
      expectedUpdatedAt: NOW,
    });
    expect(result).toMatchObject({
      credential: { label: 'Production', scope: 'team', maskedIdentifier: null },
    });
    expect(result.credential).not.toHaveProperty('metadata');
    expect(JSON.stringify(result)).not.toContain('apiKey');
    expect(JSON.stringify(result)).not.toContain('raw-unmasked-secret');
    expect(updateIfRevision).toHaveBeenCalledWith(
      'bot_credentials',
      { id: RUN_ID, bot_id: BOT_ID },
      { metadata: { label: 'Production', apiKey: '[REDACTED]' } },
      NOW,
    );
    expect(JSON.stringify(updateIfRevision.mock.calls)).not.toContain('must-not-persist');
    expect(JSON.stringify(updateIfRevision.mock.calls)).not.toContain('raw-unmasked-secret');
  });

  it('rejects legacy metadata-only credential creation', async () => {
    const harness = createHarness({ get: vi.fn(async () => null) });
    await expect(harness.management.saveCredentialMetadata(principal, BOT_ID, {
      provider: 'openai',
      kind: 'api_key',
      credentialScope: 'team',
      ownerUserId: null,
      metadata: { label: 'Missing secret' },
    })).rejects.toMatchObject({ code: 'bot_credential_secret_required', statusCode: 400 });
    expect(harness.store.insert).not.toHaveBeenCalled();
  });

  it('connects only an existing live OAuth provider without copying host secrets', async () => {
    const hostAuth = {
      type: 'oauth',
      access: 'host-access-must-not-leak',
      refresh: 'host-refresh-must-not-leak',
    };
    const insert = vi.fn(async (_table, input) => ({
      ...input,
      created_at: NOW,
      updated_at: NOW,
    }));
    const harness = createHarness({
      insert,
      loadModelCatalog: vi.fn(async () => ({
        providers: [{ id: 'openai', name: 'OpenAI', models: [] }],
      })),
      readHostProviderAuth: vi.fn((providerId) => (
        providerId === 'openai' ? hostAuth : null
      )),
    });

    const options = await harness.management.modelOptions(principal, BOT_ID);
    expect(options.providers[0]).toMatchObject({
      authType: 'oauth',
      connections: [{
        id: 'host:openai',
        label: 'OpenAI account',
        kind: 'oauth',
        status: 'active',
      }],
    });
    expect(JSON.stringify(options)).not.toContain('host-access-must-not-leak');

    const result = await harness.management.createOAuthCredentialConnection(
      principal,
      BOT_ID,
      {
        provider: 'openai',
        connectionId: 'host:openai',
        label: 'My OpenAI account',
        kind: 'oauth',
        credentialScope: 'team',
        ownerUserId: null,
      },
    );
    expect(result).toMatchObject({
      credential: {
        id: RUN_ID,
        provider: 'openai',
        label: 'My OpenAI account',
        kind: 'oauth',
        scope: 'team',
      },
    });
    expect(insert).toHaveBeenCalledWith('bot_credentials', expect.objectContaining({
      provider: 'openai',
      kind: 'oauth',
      metadata: { label: 'My OpenAI account', connectionId: 'host:openai' },
    }));
    expect(JSON.stringify(result)).not.toContain('host-access-must-not-leak');
    expect(JSON.stringify(insert.mock.calls)).not.toContain('host-refresh-must-not-leak');

    await expect(harness.management.createOAuthCredentialConnection(
      principal,
      BOT_ID,
      {
        provider: 'openai',
        connectionId: 'host:different',
        label: 'Wrong account',
        kind: 'oauth',
        credentialScope: 'team',
        ownerUserId: null,
      },
    )).rejects.toMatchObject({ code: 'bot_oauth_connection_unavailable', statusCode: 409 });
  });

  it('creates an encrypted API-key connection as an OpenCode auth record without returning secrets', async () => {
    const apiKey = 'sk-production-12345678';
    const persisted = {
      id: RUN_ID,
      bot_id: BOT_ID,
      provider: 'openai',
      kind: 'api_key',
      credential_scope: 'team',
      owner_user_id: null,
      local_vault_reference: `bot-credential:${RUN_ID}`,
      metadata: {
        label: 'Production OpenAI',
        maskedIdentifier: '••••5678',
        keyId: 'deployment-v1',
        secretVersion: 1,
        rotationCount: 0,
        rotatedAt: null,
      },
      status: 'active',
      created_by: USER_ID,
      revoked_at: null,
    };
    const credentialVault = {
      create: vi.fn(async () => ({ id: RUN_ID })),
      toSupabaseRecord: vi.fn(() => persisted),
      deleteCreated: vi.fn(async () => true),
    };
    const insert = vi.fn(async (_table, input) => ({
      ...input,
      created_at: NOW,
      updated_at: NOW,
    }));
    const harness = createHarness({ credentialVault, insert });

    const created = await harness.management.createCredentialConnection(principal, BOT_ID, {
      provider: 'openai',
      label: 'Production OpenAI',
      kind: 'api_key',
      credentialScope: 'team',
      ownerUserId: null,
      secret: apiKey,
    });

    expect(credentialVault.create).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openai',
      kind: 'api_key',
      metadata: { label: 'Production OpenAI', maskedIdentifier: '••••5678' },
      secret: { type: 'api', key: apiKey },
    }));
    expect(created).toMatchObject({
      credential: {
        id: RUN_ID,
        label: 'Production OpenAI',
        maskedIdentifier: '••••5678',
        version: 1,
      },
    });
    expect(JSON.stringify(insert.mock.calls)).not.toContain(apiKey);
    expect(JSON.stringify(harness.audit.mock.calls)).not.toContain(apiKey);
    expect(JSON.stringify(created)).not.toContain(apiKey);
  });

  it('removes a newly encrypted API key when its metadata row cannot be persisted', async () => {
    const credentialVault = {
      create: vi.fn(async () => ({ id: RUN_ID })),
      toSupabaseRecord: vi.fn(() => ({
        id: RUN_ID,
        bot_id: BOT_ID,
        provider: 'openai',
        kind: 'api_key',
        credential_scope: 'team',
        owner_user_id: null,
        local_vault_reference: `bot-credential:${RUN_ID}`,
        metadata: { label: 'OpenAI', maskedIdentifier: '••••5678' },
        status: 'active',
        created_by: USER_ID,
        revoked_at: null,
      })),
      deleteCreated: vi.fn(async () => true),
    };
    const conflict = Object.assign(new Error('metadata write failed'), {
      code: 'bot_credential_conflict',
      statusCode: 409,
    });
    const harness = createHarness({
      credentialVault,
      insert: vi.fn(async () => { throw conflict; }),
    });

    await expect(harness.management.createCredentialConnection(principal, BOT_ID, {
      provider: 'openai',
      label: 'OpenAI',
      kind: 'api_key',
      credentialScope: 'team',
      ownerUserId: null,
      secret: 'sk-production-12345678',
    })).rejects.toBe(conflict);
    expect(credentialVault.deleteCreated).toHaveBeenCalledWith(RUN_ID);
  });

  it('rolls the encrypted vault back exactly when API-key rotation loses its metadata race', async () => {
    const current = {
      id: RUN_ID,
      bot_id: BOT_ID,
      provider: 'openai',
      kind: 'api_key',
      credential_scope: 'team',
      owner_user_id: null,
      local_vault_reference: `bot-credential:${RUN_ID}`,
      metadata: { label: 'OpenAI', maskedIdentifier: '••••-old', secretVersion: 1 },
      status: 'active',
      created_by: USER_ID,
      created_at: NOW,
      updated_at: NOW,
      revoked_at: null,
    };
    const previous = {
      credential: {
        id: RUN_ID,
        botId: BOT_ID,
        provider: 'openai',
        kind: 'api_key',
        credentialScope: 'team',
        ownerUserId: null,
        status: 'active',
        keyId: 'deployment-v1',
        secretVersion: 1,
        rotationCount: 0,
        metadata: current.metadata,
        updatedAt: NOW,
        rotatedAt: null,
      },
      secret: { type: 'api', key: 'old-key' },
    };
    const credentialVault = {
      read: vi.fn(async () => previous),
      rotate: vi.fn(async () => ({ secretVersion: 2 })),
      toSupabaseRecord: vi.fn(() => ({
        ...current,
        metadata: { label: 'OpenAI', maskedIdentifier: '••••5678', secretVersion: 2 },
      })),
      rollbackRotation: vi.fn(async () => previous.credential),
    };
    const conflict = Object.assign(new Error('changed'), {
      code: 'bot_revision_conflict', statusCode: 409,
    });
    const harness = createHarness({
      credentialVault,
      get: vi.fn(async (table) => table === 'bot_credentials' ? current : revision),
      updateIfRevision: vi.fn(async () => { throw conflict; }),
    });

    await expect(harness.management.rotateCredentialConnection(
      principal,
      BOT_ID,
      RUN_ID,
      { secret: 'sk-replacement-12345678', expectedUpdatedAt: NOW },
    )).rejects.toBe(conflict);
    expect(credentialVault.rotate).toHaveBeenCalledWith(
      RUN_ID,
      { type: 'api', key: 'sk-replacement-12345678' },
      expect.objectContaining({ maskedIdentifier: '••••5678' }),
    );
    expect(credentialVault.rollbackRotation).toHaveBeenCalledWith(RUN_ID, 2, previous);
  });

  it('blocks simulation escape attempts and never grants its runner mutation execution', async () => {
    const envelope = encryptBotJson({
      key: KEY,
      keyId: 'deployment-v1',
      value: { prompt: 'Review the dashboard' },
      associatedData: `devryan:bot-eval-case:${BOT_ID}:${EVAL_ID}`,
    });
    const evalCase = {
      id: EVAL_ID,
      bot_id: BOT_ID,
      name: 'Safe review',
      input_envelope: envelope,
      expected_outcome: { writes: 'simulated' },
      created_by: USER_ID,
      created_at: NOW,
      updated_at: NOW,
      archived_at: null,
    };
    const insert = vi.fn(async () => ({
      id: RUN_ID,
      eval_case_id: EVAL_ID,
      revision_id: REVISION_ID,
      mode: 'simulation',
      state: 'running',
      result: null,
      initiated_by: USER_ID,
      created_at: NOW,
      updated_at: NOW,
      started_at: NOW,
      finished_at: null,
    }));
    const updateIfRevision = vi.fn(async (_table, _keys, changes) => ({
      ...(await insert()),
      ...changes,
      updated_at: NOW,
    }));
    const get = vi.fn(async (table) => {
      if (table === 'bot_revisions') return revision;
      if (table === 'bot_eval_cases') return evalCase;
      return null;
    });
    const testRunner = { run: vi.fn(async () => ({ passed: true, writes: 'simulated' })) };
    const harness = createHarness({ get, insert, updateIfRevision, testRunner });

    await expect(harness.management.runEvalCase(principal, BOT_ID, EVAL_ID, {
      revisionId: REVISION_ID,
      mode: 'simulation',
      confirmed: true,
      confirmation: 'Research Desk',
    })).rejects.toMatchObject({ code: 'bot_simulation_escape_blocked' });
    expect(testRunner.run).not.toHaveBeenCalled();

    await expect(harness.management.runEvalCase(principal, BOT_ID, EVAL_ID, {
      revisionId: REVISION_ID,
      mode: 'simulation',
      confirmed: false,
      confirmation: '',
    })).resolves.toMatchObject({ run: { state: 'completed', mode: 'simulation' } });
    expect(testRunner.run).toHaveBeenCalledWith(expect.objectContaining({
      computerScopeKey: `test:${BOT_ID}:${USER_ID}`,
      writeMode: 'simulated',
      executeMutations: false,
    }));
  });

  it('replaces Bot profile avatars with optimistic concurrency and reports resumable cleanup', async () => {
    const oldObjectId = 'f0000000-0000-4000-8000-000000000010';
    const newObjectId = 'f0000000-0000-4000-8000-000000000011';
    const profileBot = {
      ...bot,
      title: 'Research Desk',
      summary: 'Old summary',
      avatar_object_id: oldObjectId,
      avatar_fallback: 'R',
    };
    const authorization = {
      requireManager: vi.fn(async () => ({ bot: profileBot, membership: membership() })),
    };
    const blobStore = {
      uploadProfileAvatar: vi.fn(async () => ({ id: newObjectId })),
      deleteObject: vi.fn(async () => ({ cleanupRequired: true })),
    };
    const updateIfRevision = vi.fn(async (_table, _keys, changes) => ({
      ...profileBot,
      ...changes,
      updated_at: '2026-08-23T00:01:00.000Z',
    }));
    const harness = createHarness({ authorization, blobStore, updateIfRevision });
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    await expect(harness.management.updateProfile(principal, BOT_ID, {
      name: 'Research Desk',
      title: 'Research Operations',
      summary: 'A concise durable profile.',
      expectedUpdatedAt: NOW,
      avatar: { contentType: 'image/png', bytes, provenance: {} },
    })).resolves.toMatchObject({
      bot: {
        title: 'Research Operations',
        summary: 'A concise durable profile.',
        avatarUrl: expect.stringContaining(`/api/bots/${BOT_ID}/avatar?v=`),
        avatarFallback: 'R',
      },
      avatarCleanupRequired: true,
    });
    expect(updateIfRevision).toHaveBeenCalledWith('bots', { id: BOT_ID }, {
      name: 'Research Desk',
      title: 'Research Operations',
      summary: 'A concise durable profile.',
      avatar_object_id: newObjectId,
    }, NOW);
    expect(blobStore.deleteObject).toHaveBeenCalledWith({
      principal,
      botId: BOT_ID,
      objectId: oldObjectId,
    });
  });

  it('rolls back a newly encrypted avatar when the profile concurrency token loses', async () => {
    const newObjectId = 'f0000000-0000-4000-8000-000000000011';
    const conflict = Object.assign(new Error('changed'), {
      code: 'bot_revision_conflict', statusCode: 409,
    });
    const blobStore = {
      uploadProfileAvatar: vi.fn(async () => ({ id: newObjectId })),
      deleteObject: vi.fn(async () => ({ cleanupRequired: false })),
    };
    const harness = createHarness({
      blobStore,
      updateIfRevision: vi.fn(async () => { throw conflict; }),
    });

    await expect(harness.management.updateProfile(principal, BOT_ID, {
      name: 'Research Desk',
      title: 'Research Desk',
      summary: '',
      expectedUpdatedAt: NOW,
      avatar: {
        contentType: 'image/png',
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        provenance: {},
      },
    })).rejects.toMatchObject({ code: 'bot_revision_conflict', statusCode: 409 });
    expect(blobStore.deleteObject).toHaveBeenCalledWith({
      principal,
      botId: BOT_ID,
      objectId: newObjectId,
    });
  });

  it('allows authenticated members to read same-Bot avatars but keeps profile and catalog edits Manager-only', async () => {
    const avatarObjectId = 'f0000000-0000-4000-8000-000000000010';
    const member = membership(USER_ID, 'member');
    const profileBot = { ...bot, avatar_object_id: avatarObjectId };
    const forbidden = Object.assign(new Error('manager required'), {
      code: 'bot_manager_required', statusCode: 403,
    });
    const authorization = {
      requireManager: vi.fn(async () => { throw forbidden; }),
    };
    const blobStore = {
      download: vi.fn(async () => ({
        object: { visibility: 'profile', content_type: 'image/png' },
        bytes: Buffer.from('avatar'),
      })),
    };
    const get = vi.fn(async (table) => {
      if (table === 'bots') return profileBot;
      if (table === 'bot_memberships') return member;
      return null;
    });
    const harness = createHarness({ authorization, blobStore, get });

    await expect(harness.management.downloadAvatar(principal, BOT_ID)).resolves.toMatchObject({
      object: { visibility: 'profile' }, bytes: Buffer.from('avatar'),
    });
    expect(blobStore.download).toHaveBeenCalledWith({
      principal, botId: BOT_ID, objectId: avatarObjectId,
    });
    await expect(harness.management.modelOptions(principal, BOT_ID))
      .rejects.toMatchObject({ code: 'bot_manager_required', statusCode: 403 });
    await expect(harness.management.updateProfile(principal, BOT_ID, {
      name: 'Research Desk', title: 'Research Desk', summary: '', expectedUpdatedAt: NOW,
    })).rejects.toMatchObject({ code: 'bot_manager_required', statusCode: 403 });
  });

  it('returns a secret-free Manager-only model catalog and migrates supported legacy thinking', async () => {
    const catalog = {
      providers: [{
        id: 'openai',
        name: 'OpenAI',
        apiKey: 'must-not-leak',
        models: [{
          id: 'gpt-5.6-sol',
          name: 'GPT',
          variants: { medium: { name: 'Medium' } },
          limit: { context: 128_000 },
          egressHosts: ['api.openai.com:443'],
          authorization: { token: 'must-not-leak' },
        }],
      }],
    };
    const updateIfRevision = vi.fn(async (_table, _keys, changes) => ({
      ...revision,
      ...changes,
    }));
    const harness = createHarness({
      loadModelCatalog: vi.fn(async () => catalog),
      updateIfRevision,
    });

    const options = await harness.management.modelOptions(principal, BOT_ID);
    expect(options).toEqual({
      available: true,
      providers: [{
        id: 'openai', name: 'OpenAI', available: true, authType: null, connections: [], models: [{
          id: 'gpt-5.6-sol', name: 'GPT', providerId: 'openai', available: true,
          variants: [{ id: 'medium', name: 'Medium', available: true }],
          contextLimit: 128_000,
          reviewedEgressHosts: ['api.openai.com:443'],
          egressReviewed: true,
        }],
      }],
    });
    expect(JSON.stringify(options)).not.toContain('must-not-leak');

    await harness.management.updateDraftRevision(principal, BOT_ID, REVISION_ID, {
      contract,
      expectedUpdatedAt: NOW,
    });
    const savedContract = updateIfRevision.mock.calls[0][2].contract;
    expect(savedContract.models.primary.variant).toBe('medium');
    expect(savedContract.reasoning).toEqual({});
  });

  it('collapses a submitted tenancy onto the one shared computer', async () => {
    const updateIfRevision = vi.fn(async () => revision);
    const harness = createHarness({ updateIfRevision });
    await harness.management.updateDraftRevision(principal, BOT_ID, REVISION_ID, {
      contract: { ...contract, tenancy: 'personalized' },
      expectedUpdatedAt: NOW,
    });
    expect(updateIfRevision.mock.calls[0][2].contract.tenancy).toBe('team');
  });

  it('derives the gateway plugin version and pinned Library versions itself', async () => {
    const updateIfRevision = vi.fn(async () => revision);
    const harness = createHarness({
      updateIfRevision,
      list: vi.fn(async (table) => (table === 'bot_library_sources'
        ? { items: [
          { id: 'source-1', current_published_version_id: 'f0000000-0000-4000-8000-00000000000b' },
          { id: 'source-2', current_published_version_id: null },
        ] }
        : { items: [] })),
    });
    await harness.management.updateDraftRevision(principal, BOT_ID, REVISION_ID, {
      contract: {
        ...contract,
        gatewayPluginVersion: 'devryan-bot-tools@0.0.1',
        libraryVersionIds: ['f0000000-0000-4000-8000-00000000000c'],
      },
      expectedUpdatedAt: NOW,
    });
    const saved = updateIfRevision.mock.calls[0][2].contract;
    expect(saved.gatewayPluginVersion).toBe('devryan-bot-tools@1.2.0');
    expect(saved.libraryVersionIds).toEqual(['f0000000-0000-4000-8000-00000000000b']);
  });

  it('seeds a soul once and never overwrites an edited one', async () => {
    const updateIfRevision = vi.fn(async () => revision);
    const harness = createHarness({ updateIfRevision });
    await harness.management.updateDraftRevision(principal, BOT_ID, REVISION_ID, {
      contract,
      expectedUpdatedAt: NOW,
    });
    const seeded = updateIfRevision.mock.calls[0][2].contract.soul;
    expect(seeded).toContain('## Core Identity');
    expect(seeded).toContain('## Voice & Tone');

    const edited = createHarness({
      updateIfRevision: vi.fn(async () => revision),
      get: vi.fn(async (table) => (table === 'bot_revisions'
        ? { ...revision, contract: { ...contract, soul: '# Soul\n\nAlready mine.' } }
        : null)),
    });
    await edited.management.updateDraftRevision(principal, BOT_ID, REVISION_ID, {
      contract,
      expectedUpdatedAt: NOW,
    });
    expect(edited.store.updateIfRevision.mock.calls[0][2].contract.soul)
      .toBe('# Soul\n\nAlready mine.');
  });

  it('saves blocked Drafts without invoking publish and returns structured gate details', async () => {
    const saved = { ...revision, updated_at: '2026-08-23T00:01:00.000Z' };
    const harness = createHarness({
      updateIfRevision: vi.fn(async () => saved),
      get: vi.fn(async (table) => table === 'bot_revisions' ? saved : null),
    });

    await expect(harness.management.publishRevision(principal, BOT_ID, REVISION_ID, {
      contract,
      expectedUpdatedAt: NOW,
    })).rejects.toMatchObject({
      code: 'bot_activation_blocked',
      statusCode: 409,
      details: {
        gates: expect.arrayContaining([expect.objectContaining({ id: 'images', status: 'fail' })]),
        revision: { id: REVISION_ID, updatedAt: saved.updated_at },
      },
    });
    expect(harness.store.updateIfRevision).toHaveBeenCalled();
    expect(harness.store.publishRevision).not.toHaveBeenCalled();
  });

  it('keeps independent model checks truthful and omits empty optional capability gates', async () => {
    const preflightCapabilities = vi.fn();
    const harness = createHarness({
      resolveCapabilities: vi.fn(async () => ({
        available: false,
        state: 'runtime_degraded',
        code: 'bot_runtime_docker_unavailable',
        runtime: { issues: [{ message: 'The previous Docker probe failed.' }] },
      })),
      preflightModel: vi.fn(async () => ({
        model: { providerId: 'openai', modelId: 'gpt-5.6-sol' },
        egressHosts: ['api.openai.com:443'],
      })),
      preflightCapabilities,
    });

    const health = await harness.management.activationHealth(principal, BOT_ID, REVISION_ID);

    expect(health.ready).toBe(false);
    expect(health.gates.map((gate) => gate.id)).toEqual([
      'schema', 'images', 'models', 'egress', 'tools', 'policy',
    ]);
    expect(health.gates.find((gate) => gate.id === 'images')).toMatchObject({
      status: 'fail',
      detail: 'The previous Docker probe failed.',
    });
    expect(health.gates.find((gate) => gate.id === 'models')).toMatchObject({ status: 'pass' });
    expect(health.gates.find((gate) => gate.id === 'egress')).toMatchObject({ status: 'pass' });
    expect(preflightCapabilities).not.toHaveBeenCalled();
  });

  it('accepts Allow, Prompt, and Deny defaults with an empty browser allowlist', async () => {
    for (const defaultEffect of ['allow', 'prompt', 'deny']) {
      const policyContract = {
        ...contract,
        runtimeTools: ['bash', 'terminal', 'git', 'task'],
        actionPolicy: { defaultEffect, defaultRisk: 'low', rules: [] },
        browserPolicy: { allowedOrigins: [], deniedOrigins: [] },
      };
      const harness = createHarness({
        get: vi.fn(async (table) => table === 'bot_revisions'
          ? { ...revision, contract: policyContract }
          : null),
        resolveCapabilities: vi.fn(async () => ({ available: true, state: 'healthy' })),
        preflightModel: vi.fn(async () => ({
          model: { providerId: 'openai', modelId: 'gpt-5.6-sol' },
          egressHosts: ['api.openai.com:443'],
        })),
      });

      const health = await harness.management.activationHealth(principal, BOT_ID, REVISION_ID);
      expect(health.ready).toBe(true);
      expect(health.gates.find((gate) => gate.id === 'policy')).toMatchObject({
        status: 'pass',
        detail: expect.stringContaining(`${defaultEffect} is the ordinary-action default`),
      });
    }
  });

  it('blocks new AG-UI activations while retaining the legacy adapter for deployed runs', async () => {
    const { models, ...legacyFields } = contract;
    void models;
    const agUiContract = {
      ...legacyFields,
      contractVersion: 3,
      agent: {
        kind: 'ag_ui',
        connectionRef: 'f0000000-0000-4000-8000-000000000040',
        connectionDigest: 'a'.repeat(64),
      },
      computerPolicy: { isolationTier: 'standard' },
      browserPolicy: {
        allowedOrigins: [],
        deniedOrigins: [],
        networkAccess: { mode: 'public_only', hosts: [] },
      },
    };
    const harness = createHarness({
      get: vi.fn(async (table) => table === 'bot_revisions'
        ? { ...revision, contract: agUiContract }
        : null),
      resolveCapabilities: vi.fn(async () => ({ available: true, state: 'healthy' })),
    });

    const health = await harness.management.activationHealth(principal, BOT_ID, REVISION_ID);

    expect(health.ready).toBe(false);
    expect(health.gates.find((gate) => gate.id === 'agent')).toEqual(expect.objectContaining({
      status: 'fail',
      detail: 'New Bot configurations always run through OpenCode.',
    }));
  });

  it('blocks failed Skills while ignoring retained legacy MCP assignments', async () => {
    const configuredContract = {
      ...contract,
      skillBindings: [{
        id: 'f0000000-0000-4000-8000-000000000021',
        digest: 'b'.repeat(64),
      }],
      mcpBindings: [{
        id: 'f0000000-0000-4000-8000-000000000022',
        descriptorDigest: 'c'.repeat(64),
        manifestDigest: 'd'.repeat(64),
      }],
    };
    const configuredRevision = { ...revision, contract: configuredContract };
    const harness = createHarness({
      get: vi.fn(async (table) => table === 'bot_revisions' ? configuredRevision : null),
      resolveCapabilities: vi.fn(async () => ({ available: true, state: 'healthy' })),
      preflightModel: vi.fn(async () => ({
        model: { providerId: 'openai', modelId: 'gpt-5.6-sol' },
        egressHosts: ['api.openai.com:443'],
      })),
      preflightCapabilities: vi.fn(async () => ({
        skills: { count: 1, materialized: false, error: 'Skill digest changed.' },
        mcp: [],
        mcpReady: true,
        mcpError: null,
      })),
    });

    const health = await harness.management.activationHealth(principal, BOT_ID, REVISION_ID);

    expect(health.ready).toBe(false);
    expect(health.gates.find((gate) => gate.id === 'skills')).toMatchObject({
      status: 'fail', detail: 'Skill digest changed.',
    });
    expect(health.gates.find((gate) => gate.id === 'mcp')).toBeUndefined();
  });

  it('retains setup-only profile and avatar values when publication readiness is blocked', async () => {
    const saved = { ...revision, updated_at: '2026-08-23T00:01:00.000Z' };
    const avatarId = 'f0000000-0000-4000-8000-000000000013';
    const profileAt = '2026-08-23T00:01:30.000Z';
    const updateIfRevision = vi.fn(async (table, _keys, changes) => (
      table === 'bot_revisions'
        ? { ...saved, ...changes }
        : { ...bot, ...changes, updated_at: profileAt }
    ));
    const blobStore = {
      uploadProfileAvatar: vi.fn(async () => ({ id: avatarId })),
      deleteObject: vi.fn(async () => ({ cleanupRequired: false })),
    };
    const harness = createHarness({
      updateIfRevision,
      get: vi.fn(async (table) => table === 'bot_revisions' ? saved : null),
      blobStore,
    });

    await expect(harness.management.publishRevision(principal, BOT_ID, REVISION_ID, {
      contract,
      expectedUpdatedAt: NOW,
      profile: {
        name: 'Setup Name',
        title: 'Setup Title',
        summary: 'Still needs a runtime.',
        expectedUpdatedAt: NOW,
        avatar: { contentType: 'image/png', bytes: Buffer.from('setup-avatar') },
      },
    })).rejects.toMatchObject({
      code: 'bot_activation_blocked',
      details: {
        profileRetained: true,
        bot: { name: 'Setup Name', title: 'Setup Title' },
      },
    });
    expect(updateIfRevision).toHaveBeenCalledWith(
      'bots',
      { id: BOT_ID },
      expect.objectContaining({
        name: 'Setup Name',
        avatar_object_id: avatarId,
      }),
      NOW,
    );
    expect(harness.store.publishRevision).not.toHaveBeenCalled();
    expect(blobStore.deleteObject).not.toHaveBeenCalled();
  });

  it('reports recovery-required when a failed setup profile save cannot clean its uploaded avatar', async () => {
    const saved = { ...revision, updated_at: '2026-08-23T00:01:00.000Z' };
    const profileConflict = Object.assign(new Error('profile changed'), {
      code: 'bot_revision_conflict',
      statusCode: 409,
    });
    const updateIfRevision = vi.fn(async (table) => {
      if (table === 'bot_revisions') return saved;
      throw profileConflict;
    });
    const blobStore = {
      uploadProfileAvatar: vi.fn(async () => ({
        id: 'f0000000-0000-4000-8000-000000000014',
      })),
      deleteObject: vi.fn(async () => {
        throw Object.assign(new Error('storage unavailable'), { code: 'storage_unavailable' });
      }),
    };
    const harness = createHarness({ updateIfRevision, blobStore });

    await expect(harness.management.publishRevision(principal, BOT_ID, REVISION_ID, {
      contract,
      expectedUpdatedAt: NOW,
      profile: {
        name: 'Setup Name',
        title: 'Setup Title',
        summary: '',
        expectedUpdatedAt: NOW,
        avatar: { contentType: 'image/png', bytes: Buffer.from('candidate') },
      },
    })).rejects.toMatchObject({
      code: 'bot_publish_avatar_cleanup_failed',
      statusCode: 500,
      details: {
        operationCode: 'bot_revision_conflict',
        cleanupCode: 'storage_unavailable',
      },
    });
    expect(blobStore.deleteObject).toHaveBeenCalledTimes(1);
    expect(harness.store.publishRevision).not.toHaveBeenCalled();
  });

  it('publishes only the exact saved Draft after all activation gates pass', async () => {
    const saved = {
      ...revision,
      contract: { ...contract, reasoning: {} },
      compiled_hash: 'b'.repeat(64),
      updated_at: '2026-08-23T00:01:00.000Z',
    };
    let published = false;
    const publishedRevision = () => ({
      ...saved,
      activated_at: published ? '2026-08-23T00:02:00.000Z' : null,
    });
    const publishRevision = vi.fn(async () => {
      published = true;
      return {
        ...bot,
        title: 'Research Desk', summary: '', avatar_object_id: null, avatar_fallback: 'R',
        lifecycle: 'active', active_revision_id: REVISION_ID,
        updated_at: '2026-08-23T00:02:00.000Z',
      };
    });
    const eventStream = {
      publish: vi.fn(() => { throw new Error('subscriber disconnected'); }),
    };
    const harness = createHarness({
      get: vi.fn(async (table) => table === 'bot_revisions' ? publishedRevision() : null),
      list: vi.fn(async (table) => ({
        items: table === 'bot_memberships' ? [membership()] : [],
        nextCursor: null,
      })),
      updateIfRevision: vi.fn(async () => saved),
      publishRevision,
      eventStream,
      resolveCapabilities: vi.fn(async () => ({ available: true, state: 'healthy' })),
      preflightModel: vi.fn(async () => ({
        model: { providerId: 'openai', modelId: 'gpt-5.6-sol' },
        egressHosts: ['api.openai.com:443'],
      })),
      preflightCapabilities: vi.fn(async () => ({
        skills: { count: 0, materialized: true, error: null },
        mcp: [], mcpReady: true, mcpError: null,
      })),
    });

    const result = await harness.management.publishRevision(principal, BOT_ID, REVISION_ID, {
      contract: saved.contract,
      expectedUpdatedAt: NOW,
    });
    expect(result).toMatchObject({
      bot: { activeRevisionId: REVISION_ID },
      revision: { id: REVISION_ID, activatedAt: '2026-08-23T00:02:00.000Z' },
      health: { ready: true },
      futureRunsOnly: true,
    });
    expect(result.health.gates.map((gate) => gate.id)).not.toContain('evals');
    expect(eventStream.publish).toHaveBeenCalledTimes(3);
    expect(eventStream.publish.mock.calls.map(([event]) => event.kind)).toEqual([
      'bot.activated',
      'revision.activated',
      'membership.assigned',
    ]);
    expect(publishRevision).toHaveBeenCalledWith({
      botId: BOT_ID,
      revisionId: REVISION_ID,
      expectedUpdatedAt: saved.updated_at,
      compiledHash: saved.compiled_hash,
      actorId: USER_ID,
    });
  });

  it('publishes an optimistic profile with the revision and notifies only active members after commit', async () => {
    const savedAt = '2026-08-23T00:01:00.000Z';
    const profileAt = '2026-08-23T00:01:30.000Z';
    const publishedAt = '2026-08-23T00:02:00.000Z';
    const avatarId = 'f0000000-0000-4000-8000-000000000012';
    const saved = { ...revision, updated_at: savedAt };
    let published = false;
    const eventStream = { publish: vi.fn(async () => ({ delivered: 1 })) };
    const updateIfRevision = vi.fn(async (table, _keys, changes) => {
      if (table === 'bot_revisions') return { ...saved, ...changes };
      return { ...bot, ...changes, updated_at: profileAt };
    });
    const publishedBot = {
      ...bot,
      name: 'Research Operations',
      title: 'Research Operations',
      summary: 'Coordinates reviewed research.',
      avatar_object_id: avatarId,
      active_revision_id: REVISION_ID,
      updated_at: publishedAt,
    };
    const harness = createHarness({
      blobStore: {
        uploadProfileAvatar: vi.fn(async () => ({ id: avatarId })),
        deleteObject: vi.fn(async () => ({ cleanupRequired: false })),
      },
      get: vi.fn(async (table) => {
        if (table === 'bot_revisions') {
          return { ...saved, activated_at: published ? publishedAt : null };
        }
        return null;
      }),
      list: vi.fn(async (table) => ({
        items: table === 'bot_memberships' ? [membership()] : [],
        nextCursor: null,
      })),
      updateIfRevision,
      publishRevision: vi.fn(async () => {
        published = true;
        return publishedBot;
      }),
      eventStream,
      resolveCapabilities: vi.fn(async () => ({ available: true, state: 'healthy' })),
      preflightModel: vi.fn(async () => ({
        model: { providerId: 'openai', modelId: 'gpt-5.6-sol' },
        egressHosts: ['api.openai.com:443'],
      })),
      preflightCapabilities: vi.fn(async () => ({
        skills: { count: 0, materialized: true, error: null },
        mcp: [], mcpReady: true, mcpError: null,
      })),
    });

    const result = await harness.management.publishRevision(principal, BOT_ID, REVISION_ID, {
      contract,
      expectedUpdatedAt: NOW,
      profile: {
        name: 'Research Operations',
        title: 'Research Operations',
        summary: 'Coordinates reviewed research.',
        expectedUpdatedAt: NOW,
        avatar: { contentType: 'image/png', bytes: Buffer.from('avatar') },
      },
    });

    expect(result).toMatchObject({
      profileUpdated: true,
      avatarCleanupRequired: false,
      bot: {
        title: 'Research Operations',
        activeRevisionId: REVISION_ID,
        avatarUrl: expect.stringContaining(`/api/bots/${BOT_ID}/avatar?v=`),
      },
    });
    expect(updateIfRevision).toHaveBeenCalledWith(
      'bots',
      { id: BOT_ID },
      {
        name: 'Research Operations',
        title: 'Research Operations',
        summary: 'Coordinates reviewed research.',
        avatar_object_id: avatarId,
      },
      NOW,
    );
    expect(eventStream.publish.mock.calls.map(([input]) => input.kind)).toEqual([
      'bot.activated',
      'revision.activated',
      'membership.assigned',
    ]);
    expect(eventStream.publish.mock.calls[0][0]).toMatchObject({
      audienceUserIds: [USER_ID],
      payload: { bot: { title: 'Research Operations' } },
    });
  });

  it('restores the prior profile when exact revision publication loses a race', async () => {
    const oldAvatarId = 'f0000000-0000-4000-8000-000000000010';
    const newAvatarId = 'f0000000-0000-4000-8000-000000000011';
    const activeBot = {
      ...bot,
      active_revision_id: 'old-active-revision',
      avatar_object_id: oldAvatarId,
    };
    const saved = { ...revision, updated_at: '2026-08-23T00:01:00.000Z' };
    const profileSaved = {
      ...bot,
      name: 'Changed',
      title: 'Changed',
      summary: 'Changed',
      avatar_object_id: newAvatarId,
      updated_at: '2026-08-23T00:01:30.000Z',
    };
    const profileWrites = [];
    const updateIfRevision = vi.fn(async (table, _keys, changes) => {
      if (table === 'bot_revisions') return saved;
      profileWrites.push(changes);
      return profileWrites.length === 1 ? profileSaved : { ...bot, ...changes };
    });
    const conflict = Object.assign(new Error('changed'), {
      code: 'bot_revision_conflict', statusCode: 409,
    });
    const eventStream = { publish: vi.fn() };
    const blobStore = {
      uploadProfileAvatar: vi.fn(async () => ({ id: newAvatarId })),
      deleteObject: vi.fn(async () => ({ cleanupRequired: false })),
    };
    const harness = createHarness({
      authorization: {
        requireManager: vi.fn(async () => ({
          bot: activeBot,
          membership: membership(),
        })),
      },
      get: vi.fn(async (table) => table === 'bot_revisions' ? saved : null),
      list: vi.fn(async () => ({ items: [], nextCursor: null })),
      updateIfRevision,
      publishRevision: vi.fn(async () => { throw conflict; }),
      blobStore,
      eventStream,
      resolveCapabilities: vi.fn(async () => ({ available: true, state: 'healthy' })),
      preflightModel: vi.fn(async () => ({
        model: { providerId: 'openai', modelId: 'gpt-5.6-sol' },
        egressHosts: ['api.openai.com:443'],
      })),
      preflightCapabilities: vi.fn(async () => ({
        skills: { count: 0, materialized: true, error: null },
        mcp: [], mcpReady: true, mcpError: null,
      })),
    });

    await expect(harness.management.publishRevision(principal, BOT_ID, REVISION_ID, {
      contract,
      expectedUpdatedAt: NOW,
      profile: {
        name: 'Changed', title: 'Changed', summary: 'Changed', expectedUpdatedAt: NOW,
        avatar: { contentType: 'image/png', bytes: Buffer.from('new-avatar') },
      },
    })).rejects.toBe(conflict);
    expect(profileWrites).toEqual([
      {
        name: 'Changed',
        title: 'Changed',
        summary: 'Changed',
        avatar_object_id: newAvatarId,
      },
      {
        name: bot.name,
        title: bot.name,
        summary: '',
        avatar_object_id: oldAvatarId,
      },
    ]);
    expect(blobStore.deleteObject).toHaveBeenCalledTimes(1);
    expect(blobStore.deleteObject).toHaveBeenCalledWith({
      principal, botId: BOT_ID, objectId: newAvatarId,
    });
    expect(eventStream.publish).not.toHaveBeenCalled();
  });

  it('reports recovery-required when active publication rollback cannot clean the candidate avatar', async () => {
    const newAvatarId = 'f0000000-0000-4000-8000-000000000015';
    const activeBot = { ...bot, active_revision_id: 'old-active-revision' };
    const saved = { ...revision, updated_at: '2026-08-23T00:01:00.000Z' };
    let profileWriteCount = 0;
    const updateIfRevision = vi.fn(async (table, _keys, changes) => {
      if (table === 'bot_revisions') return saved;
      profileWriteCount += 1;
      return {
        ...activeBot,
        ...changes,
        updated_at: profileWriteCount === 1
          ? '2026-08-23T00:01:30.000Z'
          : '2026-08-23T00:01:45.000Z',
      };
    });
    const publishConflict = Object.assign(new Error('revision changed'), {
      code: 'bot_revision_conflict',
      statusCode: 409,
    });
    const blobStore = {
      uploadProfileAvatar: vi.fn(async () => ({ id: newAvatarId })),
      deleteObject: vi.fn(async () => ({
        cleanupRequired: true,
        errorCode: 'storage_delete_pending',
      })),
    };
    const harness = createHarness({
      authorization: {
        requireManager: vi.fn(async () => ({ bot: activeBot, membership: membership() })),
      },
      get: vi.fn(async (table) => table === 'bot_revisions' ? saved : null),
      list: vi.fn(async () => ({ items: [], nextCursor: null })),
      updateIfRevision,
      publishRevision: vi.fn(async () => { throw publishConflict; }),
      blobStore,
      resolveCapabilities: vi.fn(async () => ({ available: true, state: 'healthy' })),
      preflightModel: vi.fn(async () => ({
        model: { providerId: 'openai', modelId: 'gpt-5.6-sol' },
        egressHosts: ['api.openai.com:443'],
      })),
      preflightCapabilities: vi.fn(async () => ({
        skills: { count: 0, materialized: true, error: null },
        mcp: [], mcpReady: true, mcpError: null,
      })),
    });

    await expect(harness.management.publishRevision(principal, BOT_ID, REVISION_ID, {
      contract,
      expectedUpdatedAt: NOW,
      profile: {
        name: 'Changed',
        title: 'Changed',
        summary: '',
        expectedUpdatedAt: NOW,
        avatar: { contentType: 'image/png', bytes: Buffer.from('candidate') },
      },
    })).rejects.toMatchObject({
      code: 'bot_publish_avatar_cleanup_failed',
      statusCode: 500,
      details: {
        publishCode: 'bot_revision_conflict',
        cleanupCode: 'storage_delete_pending',
      },
    });
    expect(profileWriteCount).toBe(2);
    expect(blobStore.deleteObject).toHaveBeenCalledWith({
      principal, botId: BOT_ID, objectId: newAvatarId,
    });
  });

  it('preserves the publish error code when retained setup profile cleanup remains pending', async () => {
    const oldAvatarId = 'f0000000-0000-4000-8000-000000000016';
    const newAvatarId = 'f0000000-0000-4000-8000-000000000017';
    const setupBot = { ...bot, avatar_object_id: oldAvatarId };
    const saved = { ...revision, updated_at: '2026-08-23T00:01:00.000Z' };
    const updateIfRevision = vi.fn(async (table, _keys, changes) => (
      table === 'bot_revisions'
        ? saved
        : { ...setupBot, ...changes, updated_at: '2026-08-23T00:01:30.000Z' }
    ));
    const publishConflict = Object.assign(new Error('revision changed'), {
      code: 'bot_revision_conflict',
      statusCode: 409,
      details: { revisionId: REVISION_ID },
    });
    const blobStore = {
      uploadProfileAvatar: vi.fn(async () => ({ id: newAvatarId })),
      deleteObject: vi.fn(async () => ({
        cleanupRequired: true,
        errorCode: 'storage_delete_pending',
      })),
    };
    const harness = createHarness({
      authorization: {
        requireManager: vi.fn(async () => ({ bot: setupBot, membership: membership() })),
      },
      get: vi.fn(async (table) => table === 'bot_revisions' ? saved : null),
      list: vi.fn(async () => ({ items: [], nextCursor: null })),
      updateIfRevision,
      publishRevision: vi.fn(async () => { throw publishConflict; }),
      blobStore,
      resolveCapabilities: vi.fn(async () => ({ available: true, state: 'healthy' })),
      preflightModel: vi.fn(async () => ({
        model: { providerId: 'openai', modelId: 'gpt-5.6-sol' },
        egressHosts: ['api.openai.com:443'],
      })),
      preflightCapabilities: vi.fn(async () => ({
        skills: { count: 0, materialized: true, error: null },
        mcp: [], mcpReady: true, mcpError: null,
      })),
    });

    await expect(harness.management.publishRevision(principal, BOT_ID, REVISION_ID, {
      contract,
      expectedUpdatedAt: NOW,
      profile: {
        name: 'Setup Name',
        title: 'Setup Title',
        summary: '',
        expectedUpdatedAt: NOW,
        avatar: { contentType: 'image/png', bytes: Buffer.from('candidate') },
      },
    })).rejects.toMatchObject({
      code: 'bot_revision_conflict',
      statusCode: 409,
      details: {
        revisionId: REVISION_ID,
        profileRetained: true,
        avatarCleanupRequired: true,
        avatarCleanupCode: 'storage_delete_pending',
      },
    });
    expect(blobStore.deleteObject).toHaveBeenCalledWith({
      principal, botId: BOT_ID, objectId: oldAvatarId,
    });
  });

  it('surfaces a concurrent publish race without activating another revision', async () => {
    const saved = { ...revision, updated_at: '2026-08-23T00:01:00.000Z' };
    const conflict = Object.assign(new Error('changed'), {
      code: 'bot_revision_conflict', statusCode: 409,
    });
    const harness = createHarness({
      get: vi.fn(async (table) => table === 'bot_revisions' ? saved : null),
      list: vi.fn(async (table) => ({
        items: table === 'bot_eval_cases' ? [{ archived_at: null }] : [],
        nextCursor: null,
      })),
      updateIfRevision: vi.fn(async () => saved),
      publishRevision: vi.fn(async () => { throw conflict; }),
      resolveCapabilities: vi.fn(async () => ({ available: true, state: 'healthy' })),
      preflightModel: vi.fn(async () => ({
        model: { providerId: 'openai', modelId: 'gpt-5.6-sol' },
        egressHosts: ['api.openai.com:443'],
      })),
      preflightCapabilities: vi.fn(async () => ({
        skills: { count: 0, materialized: true, error: null },
        mcp: [], mcpReady: true, mcpError: null,
      })),
    });

    await expect(harness.management.publishRevision(principal, BOT_ID, REVISION_ID, {
      contract,
      expectedUpdatedAt: NOW,
    })).rejects.toMatchObject({ code: 'bot_revision_conflict', statusCode: 409 });
  });
});
