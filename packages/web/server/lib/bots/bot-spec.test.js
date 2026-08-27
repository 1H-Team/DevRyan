import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { hashCanonicalBotJson } from '@openchamber/bots-runtime';

import { createBotSpecService } from './bot-spec.js';
import { createBotSpecSigner } from './bot-spec-signer.js';
import { validateBotRevisionRuntimeContract } from './config-compiler.js';

const BOT_ID = '11111111-1111-4111-8111-111111111111';
const REVISION_ID = '22222222-2222-4222-8222-222222222222';
const CREDENTIAL_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const IMPORT_REVISION_ID = '55555555-5555-4555-8555-555555555555';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

const contract = () => validateBotRevisionRuntimeContract({
  identity: { title: 'Operations Bot', avatar: '' },
  objectives: ['Keep deployments governed.'],
  tone: 'Calm and direct.',
  operatingInstructions: 'Use approved tools only.',
  prohibitedInstructions: 'Never bypass the gateway.',
  advancedPrompt: '',
  tenancy: 'team',
  standingRole: 'You are a governed operations Bot.',
  models: {
    primary: {
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      credentialId: CREDENTIAL_ID,
      egressHosts: ['api.openai.com:443'],
    },
    fallbacks: [],
  },
  reasoning: { effort: 'high' },
  fileTools: ['read'],
  runtimeTools: [],
  gatewayPluginVersion: 'devryan-bot-tools@1.2.0',
  libraryVersionIds: [],
  memoryPolicy: { shared: true },
  actionPolicy: { defaultEffect: 'deny', defaultRisk: 'sensitive', rules: [] },
  browserPolicy: { allowedOrigins: [], deniedOrigins: [] },
  soul: 'A careful operator.',
  skillBindings: [],
  mcpBindings: [],
});

const harness = async () => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-bot-spec-'));
  temporaryDirectories.push(dataDirectory);
  const key = crypto.randomBytes(32);
  const encryption = { getKey: async () => Buffer.from(key) };
  const bot = {
    id: BOT_ID,
    name: 'Production Operator',
    title: 'Production Operator',
    summary: 'Runs reviewed operations.',
  };
  const revisionContract = contract();
  const revision = {
    id: REVISION_ID,
    bot_id: BOT_ID,
    revision_number: 7,
    contract: revisionContract,
    compiled_hash: hashCanonicalBotJson(revisionContract),
    portable_spec: null,
    spec_hash: null,
    activated_at: '2026-08-27T10:00:00.000Z',
  };
  const rows = new Map([
    ['bots', [bot]],
    ['bot_revisions', [revision]],
    ['bot_credentials', [{
      id: CREDENTIAL_ID,
      bot_id: BOT_ID,
      provider: 'openai',
      kind: 'api-key',
      credential_scope: 'team',
      metadata: { label: 'Production OpenAI' },
      status: 'active',
    }]],
    ['bot_agent_connections', []],
    ['bot_skill_packages', []],
    ['bot_mcp_bindings', []],
    ['bot_library_sources', []],
    ['bot_library_versions', []],
    ['bot_revision_signatures', []],
    ['bot_revision_binding_resolutions', []],
    ['bot_signer_trust', []],
  ]);
  const matches = (row, filters) => Object.entries(filters).every(([field, value]) => row[field] === value);
  const store = {
    get: async (table, filters) => rows.get(table)?.find((row) => matches(row, filters)) || null,
    list: async (table, { filters = {} } = {}) => ({
      items: (rows.get(table) || []).filter((row) => matches(row, filters)),
      nextCursor: null,
    }),
    insert: async (table, row) => {
      rows.get(table).push({ ...row, created_at: '2026-08-27T10:00:00.000Z' });
      return rows.get(table).at(-1);
    },
    attachRevisionSpec: async ({ revisionId, portableSpec, specHash }) => {
      const row = rows.get('bot_revisions').find((entry) => entry.id === revisionId);
      row.portable_spec = structuredClone(portableSpec);
      row.spec_hash = specHash;
      return row;
    },
    updateIfRevision: async (table, filters, changes) => {
      const row = rows.get(table).find((entry) => matches(entry, filters));
      Object.assign(row, changes, { updated_at: '2026-08-27T10:01:00.000Z' });
      return row;
    },
  };
  const management = {
    createImportedDraft: async (_principal, input) => {
      const compiledHash = hashCanonicalBotJson(input.contract);
      return {
        bot: { id: BOT_ID, name: bot.name },
        revision: {
          id: IMPORT_REVISION_ID,
          botId: BOT_ID,
          revisionNumber: 8,
          compiledHash,
          contract: input.contract,
          updatedAt: '2026-08-27T10:00:00.000Z',
        },
      };
    },
    updateImportedDraftBindings: async () => ({ revision: {} }),
  };
  const service = createBotSpecService({
    store,
    authorization: { requireManager: async () => ({ role: 'manager' }) },
    management,
    encryption,
    signer: createBotSpecSigner({ dataDirectory, encryption }),
    isGlobalAdmin: () => true,
    uuid: (() => {
      let counter = 10;
      return () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(counter += 1).padStart(12, '0')}`;
    })(),
  });
  return { service, rows, revision, key };
};

describe('signed Bot specifications', () => {
  it('exports stable reviewable bytes with no local credential identity or secret material', async () => {
    const { service } = await harness();
    const principal = { id: USER_ID, role: 'admin' };
    const first = await service.exportRevision(principal, BOT_ID, REVISION_ID);
    const second = await service.exportRevision(principal, BOT_ID, REVISION_ID);

    expect(second.source).toBe(first.source);
    expect(first.filename).toBe('DevRyan-Bot-production-operator-r7.devryan-bot.json');
    expect(first.source).not.toContain(CREDENTIAL_ID);
    expect(first.source).not.toMatch(/local_vault|secretEnvelope|credentialId/u);
    expect(JSON.parse(first.source)).toMatchObject({
      apiVersion: 'devryan.ai/bot-revision/v1',
      kind: 'BotRevision',
      metadata: { name: 'Production Operator', revision: 7 },
    });
  });

  it('round-trips through an explicit local mapping and never activates the imported revision', async () => {
    const { service } = await harness();
    const principal = { id: USER_ID, role: 'admin' };
    const exported = await service.exportRevision(principal, BOT_ID, REVISION_ID);
    const preview = await service.previewImport(principal, { source: exported.source, botId: BOT_ID });
    expect(preview.signer.status).toBe('unknown');
    expect(preview.requirements).toHaveLength(1);
    expect(preview.requirements[0].candidates[0].id).toBe(CREDENTIAL_ID);

    await expect(service.importDraft(principal, {
      source: exported.source,
      botId: BOT_ID,
      mappings: [],
    })).rejects.toMatchObject({ code: 'bot_spec_signer_acknowledgement_required' });

    const imported = await service.importDraft(principal, {
      source: exported.source,
      botId: BOT_ID,
      acknowledgeUnknownSigner: true,
      mappings: [{
        kind: 'credential',
        logicalKey: preview.requirements[0].logicalKey,
        localResourceId: CREDENTIAL_ID,
      }],
    });
    expect(imported.activated).toBe(false);
    expect(imported.unresolvedBindings).toEqual([]);
    expect(imported.compiledHashMatches).toBe(true);
  });

  it('rejects duplicate keys, content tampering, and signature tampering', async () => {
    const { service } = await harness();
    const principal = { id: USER_ID, role: 'admin' };
    const exported = await service.exportRevision(principal, BOT_ID, REVISION_ID);
    const duplicate = exported.source.replace(
      '"apiVersion": "devryan.ai/bot-revision/v1",',
      '"apiVersion": "devryan.ai/bot-revision/v1",\n  "apiVersion": "devryan.ai/bot-revision/v1",',
    );
    await expect(service.previewImport(principal, { source: duplicate, botId: BOT_ID }))
      .rejects.toMatchObject({ code: 'strict_json_duplicate_key' });

    const tampered = exported.source.replace('A careful operator.', 'A reckless operator.');
    await expect(service.previewImport(principal, { source: tampered, botId: BOT_ID }))
      .rejects.toMatchObject({ code: 'bot_spec_tampered' });

    const parsed = JSON.parse(exported.source);
    parsed.integrity.signature = `${parsed.integrity.signature.slice(0, -2)}AA`;
    await expect(service.previewImport(principal, {
      source: JSON.stringify(parsed),
      botId: BOT_ID,
    })).rejects.toMatchObject({ code: 'bot_spec_signature_invalid' });
  });
});
