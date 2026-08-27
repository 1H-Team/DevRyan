import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { hashCanonicalBotJson } from '@openchamber/bots-runtime';

import { encryptBotJson } from './encryption.js';
import {
  BOT_MCP_DEPLOYMENT_KEY_ID,
  botMcpDescriptorAssociatedData,
  digestBotMcpDescriptor,
} from './mcp-connector.js';
import { BOT_TABLES } from './store.js';
import { createBotPurgeAdapter, createBotRecoveryAdapter } from './recovery-adapter.js';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const USER_ID = 'a0000000-0000-4000-8000-000000000001';
const REVISION_ID = 'c0000000-0000-4000-8000-000000000001';
const NOW = '2026-08-23T10:00:00.000Z';

const recoveryConfiguration = () => ({
  format: 'DevRyan.BotConfiguration',
  version: 1,
  bot: {
    id: BOT_ID,
    name: 'Recovery Bot',
    lifecycle: 'draft',
    tenancy: 'team',
    active_revision_id: null,
    created_by: USER_ID,
    created_at: NOW,
    updated_at: NOW,
    retired_at: null,
  },
  revisions: [{
    id: REVISION_ID,
    bot_id: BOT_ID,
    revision_number: 1,
    contract: {},
    compiled_hash: 'a'.repeat(64),
    created_by: USER_ID,
    created_at: NOW,
    updated_at: NOW,
    activated_at: null,
    retired_at: null,
  }],
  memberships: [{
    bot_id: BOT_ID,
    user_id: USER_ID,
    role: 'manager',
    assigned_by: USER_ID,
    activated_at: NOW,
    revoked_at: null,
    created_at: NOW,
    updated_at: NOW,
  }],
  routines: [],
  evalCases: [],
  librarySources: [],
  libraryVersions: [],
  credentials: [],
  channels: [],
  channelAcl: [],
});

const createHarness = ({ runtimeStatus = null, indexer = null } = {}) => {
  const store = {
    repositories: { bots: { get: vi.fn(async () => ({ id: BOT_ID })) } },
    storage: { delete: vi.fn(async () => undefined) },
    purgeResource: vi.fn(async ({ resourceId }) => ({
      deletedCount: resourceId === 'channels' ? 2 : 1,
      retainedSharedMemoryCount: resourceId === 'channels' ? 3 : 0,
    })),
    purgeBot: vi.fn(async () => ({ deletedCount: 1 })),
  };
  const vault = { deleteForBot: vi.fn(async () => ({ deletedCount: 2 })) };
  const dockerProvider = {
    resetAvailable: true,
    stopReasoning: vi.fn(async () => ({ state: 'stopped' })),
    stopComputer: vi.fn(async () => ({ state: 'stopped' })),
    resetReasoning: vi.fn(async () => ({ state: 'reset' })),
    resetComputer: vi.fn(async () => ({ state: 'reset' })),
  };
  const adapter = createBotPurgeAdapter({
    store,
    authorization: { requireManager: vi.fn(async () => undefined) },
    getCredentialVault: () => vault,
    dockerProvider,
    getIndexer: () => indexer,
    getRuntimeStatus: runtimeStatus ? vi.fn(async () => runtimeStatus) : null,
  });
  const snapshot = {
    botId: BOT_ID,
    actorId: USER_ID,
    storageRows: [
      { storage_bucket: 'devryan-bot-objects', storage_object_name: 'bots/object-one' },
    ],
    reasoningTargets: [{ botId: BOT_ID, channelId: 'c0000000-0000-4000-8000-000000000001' }],
    computerTargets: [{ botId: BOT_ID, tenancy: 'team', ownerUserId: USER_ID }],
    indexIdentities: [],
  };
  return { adapter, dockerProvider, indexer, snapshot, store, vault };
};

describe('Production Bot recovery adapters', () => {
  it('reports Storage, local vault, runtime containers, named volumes, and Supabase separately', async () => {
    const harness = createHarness();

    await harness.adapter.purgeResource('objects', harness.snapshot);
    await harness.adapter.purgeResource('capability_bindings', harness.snapshot);
    await harness.adapter.purgeResource('credentials', harness.snapshot);
    await harness.adapter.stopRuntimeContainers(
      harness.snapshot,
      ['browser_profiles', 'workspaces'],
    );
    await harness.adapter.purgeResource('browser_profiles', harness.snapshot);
    await harness.adapter.purgeResource('workspaces', harness.snapshot);

    expect(harness.store.storage.delete).toHaveBeenCalledTimes(1);
    expect(harness.vault.deleteForBot).toHaveBeenCalledWith(BOT_ID);
    expect(harness.store.purgeResource).toHaveBeenCalledWith({
      botId: BOT_ID,
      resourceId: 'capability_bindings',
      actorId: USER_ID,
    });
    expect(harness.dockerProvider.stopReasoning).toHaveBeenCalledTimes(1);
    expect(harness.dockerProvider.stopComputer).toHaveBeenCalledTimes(1);
    expect(harness.dockerProvider.resetReasoning).toHaveBeenCalledTimes(1);
    expect(harness.dockerProvider.resetComputer.mock.calls.map(([, resource]) => resource))
      .toEqual(['profile', 'scratch', 'shared']);

    const result = await harness.adapter.purgeSupabaseRows(
      harness.snapshot,
      ['capability_bindings', 'objects', 'credentials'],
      { deleteBot: true },
    );
    expect(harness.store.purgeResource.mock.calls.map(([input]) => input.resourceId))
      .toEqual(['capability_bindings', 'capability_bindings', 'objects', 'credentials']);
    expect(harness.store.purgeBot).toHaveBeenCalledWith({ botId: BOT_ID, actorId: USER_ID });
    expect(result.detail).toContain('Bot definition removed');
  });

  it('makes shared-memory retention explicit when channel rows are purged', async () => {
    const harness = createHarness();

    const result = await harness.adapter.purgeResource('channels', harness.snapshot);

    expect(harness.store.purgeResource).toHaveBeenCalledWith({
      botId: BOT_ID,
      resourceId: 'channels',
      actorId: USER_ID,
    });
    expect(result.detail).toBe('2 channels removed; 3 shared memories retained');
  });

  it('treats an already-committed full Supabase delete as retry success', async () => {
    const harness = createHarness();
    harness.store.repositories.bots.get.mockResolvedValue(null);

    const result = await harness.adapter.purgeSupabaseRows(
      harness.snapshot,
      ['objects', 'credentials'],
      { deleteBot: true },
    );

    expect(result.detail).toContain('already removed');
    expect(harness.store.purgeResource).not.toHaveBeenCalled();
    expect(harness.store.purgeBot).not.toHaveBeenCalled();
  });

  it('completes runtime-owned cleanup as a no-op when setup was never completed', async () => {
    const indexer = { delete: vi.fn(async () => undefined) };
    const harness = createHarness({
      runtimeStatus: { state: 'setup_required' },
      indexer,
    });
    harness.snapshot.indexIdentities.push({
      namespace: 'bot:test',
      documentId: 'document-1',
      version: 1,
    });

    const containers = await harness.adapter.stopRuntimeContainers(
      harness.snapshot,
      ['browser_profiles', 'workspaces'],
    );
    const profiles = await harness.adapter.purgeResource('browser_profiles', harness.snapshot);
    const workspaces = await harness.adapter.purgeResource('workspaces', harness.snapshot);
    const indexes = await harness.adapter.purgeResource('indexes', harness.snapshot);

    expect(containers.detail).toContain('not set up');
    expect(profiles.detail).toContain('not set up');
    expect(workspaces.detail).toContain('not set up');
    expect(indexes.detail).toContain('not set up');
    expect(harness.dockerProvider.stopReasoning).not.toHaveBeenCalled();
    expect(harness.dockerProvider.stopComputer).not.toHaveBeenCalled();
    expect(harness.dockerProvider.resetReasoning).not.toHaveBeenCalled();
    expect(harness.dockerProvider.resetComputer).not.toHaveBeenCalled();
    expect(indexer.delete).not.toHaveBeenCalled();
  });

  it('treats an empty local index selection as already clean', async () => {
    const harness = createHarness();

    await expect(harness.adapter.purgeResource('indexes', harness.snapshot))
      .resolves.toEqual({ detail: '0 index records removed' });
  });

  it('keeps non-empty index cleanup retryable when the runtime is not setup-required', async () => {
    const harness = createHarness({ runtimeStatus: { state: 'docker_unavailable' } });
    harness.snapshot.indexIdentities.push({
      namespace: 'bot:test',
      documentId: 'document-1',
      version: 1,
    });

    await expect(harness.adapter.purgeResource('indexes', harness.snapshot))
      .rejects.toMatchObject({ code: 'bot_indexer_unavailable', statusCode: 503 });
  });

  it('surfaces incomplete restore compensation instead of hiding residual state', async () => {
    const repositories = Object.fromEntries(Object.keys(BOT_TABLES).map((tableName) => [
      tableName,
      {
        get: vi.fn(async () => null),
        list: vi.fn(async () => ({ items: [], nextCursor: null })),
      },
    ]));
    const store = {
      repositories,
      storage: {
        upload: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      },
      userProfileExists: vi.fn(async () => true),
      createBot: vi.fn(async () => ({ bot: recoveryConfiguration().bot })),
      insert: vi.fn(async () => {
        throw Object.assign(new Error('membership insert failed'), {
          code: 'bot_membership_restore_failed',
        });
      }),
      rollbackRestoredBot: vi.fn(async () => {
        throw Object.assign(new Error('rollback failed'), { code: 'bot_control_plane_cleanup_failed' });
      }),
    };
    const key = Buffer.alloc(32, 0x45);
    const adapter = createBotRecoveryAdapter({
      store,
      authorization: { requireManager: vi.fn(async () => undefined) },
      encryption: { getKey: async () => Buffer.from(key) },
    });

    await expect(adapter.restore({
      principal: { id: USER_ID, role: 'admin', scope: 'managed' },
      mode: 'empty',
      manifest: { bot: { id: BOT_ID, name: 'Recovery Bot' } },
      configuration: recoveryConfiguration(),
      objects: [],
      deploymentKey: key,
      connectorVault: null,
      browserProfiles: null,
    })).rejects.toMatchObject({
      code: 'bot_recovery_rollback_partial',
      details: {
        originalCode: 'bot_membership_restore_failed',
        cleanupFailures: [{
          step: 'supabase_rows',
          code: 'bot_control_plane_cleanup_failed',
        }],
      },
    });
    expect(store.rollbackRestoredBot).toHaveBeenCalledWith(BOT_ID);
  });

  it('always exports the encrypted profile avatar and its durable profile pointer', async () => {
    const avatarId = 'f0000000-0000-4000-8000-000000000010';
    const ciphertext = Buffer.from('encrypted-avatar');
    const configuration = recoveryConfiguration();
    const profileBot = {
      ...configuration.bot,
      title: 'Recovery Operations',
      summary: 'Durable profile',
      avatar_object_id: avatarId,
      avatar_fallback: 'R',
    };
    const avatar = {
      id: avatarId,
      bot_id: BOT_ID,
      channel_id: null,
      visibility: 'profile',
      storage_bucket: 'devryan-bot-objects',
      storage_object_name: 'objects/avatar.bin',
      object_key_envelope: { version: 1 },
      ciphertext_hash: crypto.createHash('sha256').update(ciphertext).digest('hex'),
      ciphertext_size: ciphertext.byteLength,
      wrapped_key: { version: 1 },
      content_type: 'image/png',
      provenance: { purpose: 'bot-profile-avatar' },
      created_by: USER_ID,
      created_at: NOW,
      updated_at: NOW,
      expires_at: null,
      deleted_at: null,
    };
    const repositories = Object.fromEntries(Object.keys(BOT_TABLES).map((tableName) => [
      tableName,
      {
        get: vi.fn(async () => tableName === 'bots' ? profileBot : null),
        list: vi.fn(async () => ({
          items: tableName === 'bot_revisions'
            ? configuration.revisions
            : tableName === 'bot_memberships'
              ? configuration.memberships
              : tableName === 'bot_objects'
                ? [avatar]
                : [],
          nextCursor: null,
        })),
      },
    ]));
    const store = {
      repositories,
      storage: { download: vi.fn(async () => Buffer.from(ciphertext)) },
    };
    const adapter = createBotRecoveryAdapter({
      store,
      authorization: { requireManager: vi.fn(async () => undefined) },
      encryption: { getKey: async () => Buffer.alloc(32, 0x45) },
    });

    await expect(adapter.exportConfiguration(
      { id: USER_ID, role: 'developer', scope: 'managed' },
      BOT_ID,
      {
        includeLibraryObjects: false,
        includeWorkspaceObjects: false,
        includeConnectorVault: false,
      },
    )).resolves.toMatchObject({
      configuration: {
        bot: {
          title: 'Recovery Operations',
          summary: 'Durable profile',
          avatar_object_id: avatarId,
        },
      },
      objects: [{ row: { id: avatarId, visibility: 'profile' } }],
    });
  });

  it('validates and restores pinned Skill/MCP rows with their required encrypted objects', async () => {
    const repositories = Object.fromEntries(Object.keys(BOT_TABLES).map((tableName) => [
      tableName,
      {
        get: vi.fn(async () => null),
        list: vi.fn(async () => ({ items: [], nextCursor: null })),
      },
    ]));
    const store = {
      repositories,
      userProfileExists: vi.fn(async () => true),
    };
    const key = Buffer.alloc(32, 0x45);
    const skillId = 'd0000000-0000-4000-8000-000000000001';
    const mcpId = 'e0000000-0000-4000-8000-000000000001';
    const objectId = 'f0000000-0000-4000-8000-000000000001';
    const ciphertext = Buffer.from('encrypted-skill-package');
    const toolManifest = [{
      name: 'lookup',
      description: 'Lookup',
      inputSchema: { type: 'object' },
      operationKind: 'read',
    }];
    const descriptor = {
      version: 1,
      transport: 'streamable_http',
      url: 'https://inventory.example.test/mcp',
      headerKeys: [],
      timeout: 30_000,
      legacySseFallback: true,
    };
    const descriptorDigest = digestBotMcpDescriptor(descriptor);
    const configuration = {
      ...recoveryConfiguration(),
      revisions: [{
        ...recoveryConfiguration().revisions[0],
        contract: {
          skillBindings: [{ id: skillId, digest: '1'.repeat(64) }],
          mcpBindings: [{
            id: mcpId,
            descriptorDigest,
            manifestDigest: hashCanonicalBotJson(toolManifest),
          }],
        },
      }],
      skillPackages: [{
        id: skillId,
        bot_id: BOT_ID,
        skill_name: 'review-queue',
        display_metadata: { name: 'review-queue', fileCount: 1 },
        manifest: { version: 1, files: [{ path: 'SKILL.md', sha256: '3'.repeat(64), size: 12 }] },
        package_object_id: objectId,
        package_digest: '1'.repeat(64),
        created_by: USER_ID,
        created_at: NOW,
      }],
      mcpBindings: [{
        id: mcpId,
        bot_id: BOT_ID,
        server_name: 'Inventory',
        transport: 'streamable_http',
        display_metadata: { credentialRequired: false, toolCount: 1 },
        descriptor_envelope: encryptBotJson({
          key,
          keyId: BOT_MCP_DEPLOYMENT_KEY_ID,
          value: descriptor,
          associatedData: botMcpDescriptorAssociatedData(mcpId),
        }),
        descriptor_digest: descriptorDigest,
        tool_manifest: toolManifest,
        manifest_digest: hashCanonicalBotJson(toolManifest),
        credential_provider: `mcp.${mcpId}`,
        credential_kind: 'mcp-transport',
        created_by: USER_ID,
        created_at: NOW,
      }],
    };
    const objectRow = {
      id: objectId,
      bot_id: BOT_ID,
      channel_id: null,
      visibility: 'library',
      storage_bucket: 'devryan-bot-objects',
      storage_object_name: 'objects/package.bin',
      object_key_envelope: { version: 1 },
      ciphertext_hash: crypto.createHash('sha256').update(ciphertext).digest('hex'),
      ciphertext_size: ciphertext.byteLength,
      wrapped_key: { version: 1 },
      content_type: 'application/json',
      provenance: { kind: 'bot_skill_package' },
      created_by: USER_ID,
      created_at: NOW,
      updated_at: NOW,
      expires_at: null,
      deleted_at: null,
    };
    const adapter = createBotRecoveryAdapter({
      store,
      authorization: { requireManager: vi.fn(async () => undefined) },
      encryption: { getKey: async () => Buffer.from(key) },
    });
    const input = {
      principal: { id: USER_ID, role: 'admin', scope: 'managed' },
      mode: 'empty',
      manifest: { bot: { id: BOT_ID, name: 'Recovery Bot' } },
      configuration,
      objects: [{ row: objectRow, ciphertextBase64: ciphertext.toString('base64') }],
      deploymentKey: key,
      connectorVault: null,
      browserProfiles: null,
    };

    await expect(adapter.inspectRestore(input)).resolves.toMatchObject({
      botId: BOT_ID,
      keyMatches: true,
      objectCount: 1,
    });
    const portable = structuredClone(input);
    portable.configuration.revisions[0].portable_spec = {
      apiVersion: 'devryan.ai/bot-revision/v1',
      kind: 'BotRevision',
    };
    portable.configuration.revisions[0].spec_hash = hashCanonicalBotJson(
      portable.configuration.revisions[0].portable_spec,
    );
    await expect(adapter.inspectRestore(portable)).resolves.toMatchObject({ botId: BOT_ID });

    const partialPortable = structuredClone(portable);
    delete partialPortable.configuration.revisions[0].spec_hash;
    await expect(adapter.inspectRestore(partialPortable))
      .rejects.toMatchObject({ code: 'bot_recovery_corrupt' });

    const tamperedPortable = structuredClone(portable);
    tamperedPortable.configuration.revisions[0].portable_spec.kind = 'TamperedRevision';
    await expect(adapter.inspectRestore(tamperedPortable))
      .rejects.toMatchObject({ code: 'bot_recovery_corrupt' });

    const corrupt = structuredClone(input);
    corrupt.configuration.mcpBindings[0].manifest_digest = '4'.repeat(64);
    corrupt.configuration.revisions[0].contract.mcpBindings[0].manifestDigest = '4'.repeat(64);
    await expect(adapter.inspectRestore(corrupt))
      .rejects.toMatchObject({ code: 'bot_recovery_corrupt' });

    const corruptDescriptor = structuredClone(input);
    const encoded = corruptDescriptor.configuration.mcpBindings[0].descriptor_envelope.ciphertext;
    corruptDescriptor.configuration.mcpBindings[0].descriptor_envelope.ciphertext = `${encoded[0] === 'A' ? 'B' : 'A'}${encoded.slice(1)}`;
    await expect(adapter.inspectRestore(corruptDescriptor))
      .rejects.toMatchObject({ code: 'bot_recovery_integrity_invalid' });
  });
});
