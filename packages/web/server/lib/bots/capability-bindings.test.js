import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { hashCanonicalBotJson } from '@openchamber/bots-runtime';

import { createBotCapabilityBindings } from './capability-bindings.js';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const REVISION_ID = 'c0000000-0000-4000-8000-000000000001';
const USER_ID = 'a0000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = 'a0000000-0000-4000-8000-000000000002';
const OBJECT_ID = 'd0000000-0000-4000-8000-000000000001';
const SKILL_ID = 'e0000000-0000-4000-8000-000000000001';
const MCP_ID = 'f0000000-0000-4000-8000-000000000001';
const CREDENTIAL_ID = '10000000-0000-4000-8000-000000000001';
const NOW = '2026-08-23T14:00:00.000Z';
const NEXT = '2026-08-23T14:01:00.000Z';

const baseContract = () => ({
  identity: { title: 'Research Desk', avatar: 'R' },
  objectives: ['Review requests'],
  tone: 'Direct',
  operatingInstructions: 'Follow policy',
  prohibitedInstructions: 'Never bypass approval',
  advancedPrompt: '',
  tenancy: 'personalized',
  standingRole: 'You are a research Bot.',
  models: {
    primary: {
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      credentialId: '20000000-0000-4000-8000-000000000001',
      egressHosts: ['api.openai.com:443'],
    },
    fallbacks: [],
  },
  reasoning: { effort: 'medium' },
  fileTools: ['read'],
  gatewayPluginVersion: 'devryan-bot-tools@1.0.0',
  libraryVersionIds: [],
  skillBindings: [],
  mcpBindings: [],
  memoryPolicy: { shared: true, userPrivate: true },
  actionPolicy: { defaultEffect: 'deny', defaultRisk: 'sensitive', rules: [] },
  browserPolicy: { allowedOrigins: [], deniedOrigins: [] },
});

const matches = (row, filters = {}) => Object.entries(filters).every(([key, value]) => row[key] === value);

const repository = (initial = []) => {
  const rows = [...initial];
  return {
    rows,
    get: vi.fn(async (filters) => rows.find((row) => matches(row, filters)) || null),
    list: vi.fn(async ({ filters = {} } = {}) => ({
      items: rows.filter((row) => matches(row, filters)),
      nextCursor: null,
    })),
    insert: vi.fn(async (row) => {
      const stored = { ...structuredClone(row), created_at: NOW };
      rows.push(stored);
      return stored;
    }),
  };
};

const scanFor = (content = '# Safe skill\n') => {
  const bytes = Buffer.from(content, 'utf8');
  return {
    rootKind: 'directory',
    totalBytes: bytes.byteLength,
    findings: [],
    files: [{
      relativePath: 'SKILL.md',
      contentType: 'text/markdown',
      size: bytes.byteLength,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      textBytes: bytes.byteLength,
      text: content,
      bytes,
    }],
  };
};

const createHarness = ({
  canManage = true,
  tenancy = 'personalized',
  scan = scanFor(),
  revisionUpdate = null,
  uuidValues = [SKILL_ID, MCP_ID, CREDENTIAL_ID],
  resolveDirectoryResult = '/workspace',
  mcpServers = [{
    name: 'Inventory',
    type: 'local',
    command: ['/usr/bin/env', 'node', 'server.mjs'],
    environment: { INVENTORY_TOKEN: 'secret-value' },
    enabled: true,
    scope: 'project',
  }],
  mcpManifest = [{
    name: 'lookup',
    description: 'Look up a record',
    inputSchema: { type: 'object' },
    operationKind: 'read',
  }, {
    name: 'change',
    description: 'Change a record',
    inputSchema: { type: 'object' },
    operationKind: 'write',
  }],
  resolveMcpOAuthCredential = () => null,
  auditImplementation = async () => undefined,
} = {}) => {
  const bot = {
    id: BOT_ID,
    name: 'Research Desk',
    lifecycle: 'active',
    tenancy,
    active_revision_id: null,
    created_at: NOW,
    updated_at: NOW,
    retired_at: null,
  };
  const revision = {
    id: REVISION_ID,
    bot_id: BOT_ID,
    revision_number: 2,
    contract: { ...baseContract(), tenancy },
    compiled_hash: 'a'.repeat(64),
    created_by: USER_ID,
    created_at: NOW,
    updated_at: NOW,
    activated_at: null,
    retired_at: null,
  };
  const bots = repository([bot]);
  const revisions = repository([revision]);
  revisions.updateIfRevision = vi.fn(revisionUpdate || (async (keys, changes, expectedUpdatedAt) => {
    if (expectedUpdatedAt !== revision.updated_at || !matches(revision, keys)) {
      throw Object.assign(new Error('changed'), { code: 'bot_revision_conflict', statusCode: 409 });
    }
    Object.assign(revision, structuredClone(changes), { updated_at: NEXT });
    return structuredClone(revision);
  }));
  const skillPackages = repository();
  const mcpBindings = repository();
  const credentials = repository();
  credentials.updateIfRevision = vi.fn();
  const deleted = [];
  const storageDelete = vi.fn(async () => undefined);
  const storedPackageBytes = [];
  const blobStore = {
    createLibraryObject: vi.fn(async ({ bytes }) => {
      storedPackageBytes.push(Buffer.from(bytes));
      return {
        id: OBJECT_ID,
        bot_id: BOT_ID,
        storage_bucket: 'devryan-bot-objects',
        storage_object_name: 'objects/skill.bin',
      };
    }),
    downloadAuthorized: vi.fn(),
  };
  const vault = {
    create: vi.fn(async (input) => ({
      id: input.id,
      botId: input.botId,
      provider: input.provider,
      kind: input.kind,
      credentialScope: input.credentialScope,
      ownerUserId: input.ownerUserId,
      localVaultReference: `bot-credential:${input.id}`,
      metadata: input.metadata,
      status: 'active',
      createdBy: input.createdBy,
      revokedAt: null,
    })),
    deleteCreated: vi.fn(async () => undefined),
  };
  const mcpHost = {
    preflight: vi.fn(async () => ({
      manifest: mcpManifest,
      manifestDigest: hashCanonicalBotJson(mcpManifest),
    })),
    checkBinding: vi.fn(async () => ({ ready: true })),
    describeBinding: vi.fn(async ({ bindingId }) => {
      const binding = mcpBindings.rows.find((row) => row.id === bindingId);
      return {
        bindingId,
        serverName: binding?.server_name || 'Inventory',
        descriptorDigest: binding?.descriptor_digest || '1'.repeat(64),
        manifestDigest: binding?.manifest_digest || hashCanonicalBotJson(mcpManifest),
        tools: structuredClone(mcpManifest),
      };
    }),
    closeBinding: vi.fn(async () => undefined),
  };
  const uuids = [...uuidValues];
  const store = {
    repositories: {
      bots,
      bot_revisions: revisions,
      bot_skill_packages: skillPackages,
      bot_mcp_bindings: mcpBindings,
      bot_credentials: credentials,
    },
    storage: { delete: storageDelete },
    deleteCreated: vi.fn(async (table, keys) => {
      deleted.push([table, keys]);
      const target = table === 'bot_skill_packages'
        ? skillPackages
        : table === 'bot_mcp_bindings'
          ? mcpBindings
          : table === 'bot_credentials'
            ? credentials
            : null;
      if (target) {
        const index = target.rows.findIndex((row) => matches(row, keys));
        if (index >= 0) target.rows.splice(index, 1);
      }
    }),
  };
  const authorization = {
    requireManager: vi.fn(async () => {
      if (!canManage) throw Object.assign(new Error('Manager required'), { code: 'bot_manager_required', statusCode: 403 });
      return { bot };
    }),
    requireActiveMembership: vi.fn(async () => ({ bot })),
  };
  const audit = vi.fn(auditImplementation);
  const discoverSkills = vi.fn(() => [{
    name: 'safe-skill',
    description: 'Safely review the queue',
    scope: 'project',
    path: '/workspace/.opencode/skills/safe-skill/SKILL.md',
  }]);
  const listMcpConfigs = vi.fn(() => structuredClone(mcpServers));
  const resolveDirectory = vi.fn(async () => resolveDirectoryResult);
  const service = createBotCapabilityBindings({
    store,
    authorization,
    blobStore,
    encryption: { getKey: async () => Buffer.alloc(32, 7) },
    scanner: { scan: vi.fn(async () => scan) },
    discoverSkills,
    listMcpConfigs,
    resolveMcpOAuthCredential,
    resolveDirectory,
    mcpHost,
    getCredentialVault: () => vault,
    compileRevision: vi.fn(async () => ({ directory: '/private/runtime' })),
    audit,
    uuid: vi.fn(() => uuids.shift()),
  });
  return {
    audit,
    authorization,
    blobStore,
    bot,
    credentials,
    deleted,
    discoverSkills,
    listMcpConfigs,
    mcpBindings,
    mcpHost,
    revision,
    resolveDirectory,
    revisions,
    service,
    skillPackages,
    storageDelete,
    storedPackageBytes,
    vault,
  };
};

describe('Bot Draft capability bindings', () => {
  it('snapshots a safe installed skill and updates only the expected Draft revision', async () => {
    const harness = createHarness();
    const result = await harness.service.attachSkill(
      { id: USER_ID },
      BOT_ID,
      REVISION_ID,
      { skillName: 'safe-skill', directory: '/workspace', expectedUpdatedAt: NOW },
    );

    expect(result.revision.updatedAt).toBe(NEXT);
    expect(result.revision.contract.skillBindings).toEqual([{
      id: SKILL_ID,
      digest: harness.skillPackages.rows[0].package_digest,
    }]);
    expect(harness.revisions.updateIfRevision).toHaveBeenCalledWith(
      { id: REVISION_ID, bot_id: BOT_ID },
      expect.objectContaining({ contract: expect.objectContaining({ mcpBindings: [] }) }),
      NOW,
    );
    const stored = JSON.parse(harness.storedPackageBytes[0].toString('utf8'));
    expect(stored.files).toEqual([expect.objectContaining({ path: 'SKILL.md' })]);
    expect(JSON.stringify(stored)).not.toContain('/workspace');
    expect(harness.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'bot.skill.attach' }));
  });

  it('rejects unsafe skill findings before any immutable or encrypted object is created', async () => {
    const unsafeScan = scanFor();
    unsafeScan.findings.push({
      code: 'secret_file_rejected',
      relativePath: '.env',
      message: 'Credential-like file rejected',
      severity: 'error',
    });
    const harness = createHarness({ scan: unsafeScan });

    await expect(harness.service.attachSkill(
      { id: USER_ID },
      BOT_ID,
      REVISION_ID,
      { skillName: 'safe-skill', expectedUpdatedAt: NOW },
    )).rejects.toMatchObject({ code: 'bot_skill_package_unsafe', statusCode: 400 });
    expect(harness.blobStore.createLibraryObject).not.toHaveBeenCalled();
    expect(harness.skillPackages.rows).toHaveLength(0);
  });

  it('rejects an oversized supporting file before creating a package object', async () => {
    const oversizedScan = scanFor('x'.repeat((256 * 1024) + 1));
    const harness = createHarness({ scan: oversizedScan });

    await expect(harness.service.attachSkill(
      { id: USER_ID },
      BOT_ID,
      REVISION_ID,
      { skillName: 'safe-skill', expectedUpdatedAt: NOW },
    )).rejects.toMatchObject({ code: 'bot_skill_package_too_large', statusCode: 413 });
    expect(harness.blobStore.createLibraryObject).not.toHaveBeenCalled();
    expect(harness.skillPackages.rows).toHaveLength(0);
  });

  it('allows assigned members to inspect safe summaries but requires a Manager to mutate', async () => {
    const harness = createHarness({ canManage: false });
    await expect(harness.service.list({ id: OTHER_USER_ID }, BOT_ID, REVISION_ID))
      .resolves.toMatchObject({ canManage: false, skills: [], mcp: [] });
    await expect(harness.service.attachSkill(
      { id: OTHER_USER_ID },
      BOT_ID,
      REVISION_ID,
      { skillName: 'safe-skill', expectedUpdatedAt: NOW },
    )).rejects.toMatchObject({ code: 'bot_manager_required', statusCode: 403 });
  });

  it('rolls back candidate Skill rows and encrypted objects on an optimistic conflict', async () => {
    const conflict = Object.assign(new Error('changed'), { code: 'bot_revision_conflict', statusCode: 409 });
    const harness = createHarness({ revisionUpdate: vi.fn(async () => { throw conflict; }) });
    await expect(harness.service.attachSkill(
      { id: USER_ID },
      BOT_ID,
      REVISION_ID,
      { skillName: 'safe-skill', expectedUpdatedAt: NOW },
    )).rejects.toBe(conflict);
    expect(harness.deleted).toEqual(expect.arrayContaining([
      ['bot_skill_packages', { id: SKILL_ID }],
      ['bot_objects', { id: OBJECT_ID }],
    ]));
    expect(harness.storageDelete).toHaveBeenCalledWith(
      'devryan-bot-objects',
      ['objects/skill.bin'],
    );
  });

  it('does not delete a committed Skill snapshot when downstream audit delivery fails', async () => {
    const auditError = new Error('audit unavailable');
    const harness = createHarness({ auditImplementation: async () => { throw auditError; } });

    await expect(harness.service.attachSkill(
      { id: USER_ID },
      BOT_ID,
      REVISION_ID,
      { skillName: 'safe-skill', expectedUpdatedAt: NOW },
    )).rejects.toBe(auditError);
    expect(harness.revision.contract.skillBindings).toHaveLength(1);
    expect(harness.skillPackages.rows).toHaveLength(1);
    expect(harness.storageDelete).not.toHaveBeenCalled();
  });

  it('removes MCP assignment before discovery, preflight, or credential import', async () => {
    const harness = createHarness({ tenancy: 'team', uuidValues: [MCP_ID, CREDENTIAL_ID] });
    await expect(harness.service.attachMcp(
      { id: USER_ID },
      BOT_ID,
      REVISION_ID,
      {
        serverName: 'Inventory',
        directory: '/workspace',
        expectedUpdatedAt: NOW,
        confirmSharedCredential: false,
      },
    )).rejects.toMatchObject({ code: 'bot_mcp_assignments_removed', statusCode: 410 });
    expect(harness.mcpHost.preflight).not.toHaveBeenCalled();
    expect(harness.mcpBindings.rows).toHaveLength(0);
    expect(harness.vault.create).not.toHaveBeenCalled();
    await expect(harness.service.list({ id: USER_ID }, BOT_ID, REVISION_ID))
      .resolves.toMatchObject({ availableMcp: [] });
    harness.revision.contract.mcpBindings = [{
      id: MCP_ID,
      descriptorDigest: 'c'.repeat(64),
      manifestDigest: 'd'.repeat(64),
    }];
    await expect(harness.service.runtimeCatalog({ revisionId: REVISION_ID })).resolves.toEqual({
      mcpServers: [],
      invocation: null,
    });
    expect(harness.mcpHost.describeBinding).not.toHaveBeenCalled();
  });

  it('lists only safe Manager candidates and translates the selected project directory', async () => {
    const harness = createHarness();
    const result = await harness.service.list(
      { id: USER_ID },
      BOT_ID,
      REVISION_ID,
      { directory: '/workspace' },
    );

    expect(harness.resolveDirectory).toHaveBeenCalledWith({ id: USER_ID }, '/workspace');
    expect(result.availableSkills).toEqual([{
      name: 'safe-skill',
      description: 'Safely review the queue',
      scope: 'project',
    }]);
    expect(result.availableMcp).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('/workspace/.opencode');
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });

  it('rejects an unassigned project directory before discovering host capabilities', async () => {
    const harness = createHarness({ resolveDirectoryResult: null });

    await expect(harness.service.attachSkill(
      { id: USER_ID },
      BOT_ID,
      REVISION_ID,
      { skillName: 'safe-skill', directory: '/outside', expectedUpdatedAt: NOW },
    )).rejects.toMatchObject({ code: 'bot_capability_directory_forbidden', statusCode: 403 });
    expect(harness.discoverSkills).not.toHaveBeenCalled();
  });
});
