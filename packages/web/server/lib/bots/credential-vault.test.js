import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createBotCredentialVault } from './credential-vault.js';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const CREDENTIAL_ID = 'c0000000-0000-4000-8000-000000000001';
const CREATOR_ID = 'a0000000-0000-4000-8000-000000000001';
const OWNER_ID = 'a0000000-0000-4000-8000-000000000002';
const KEY = Buffer.alloc(32, 0x67);
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

const createTemporaryDirectory = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-bot-vault-'));
  temporaryDirectories.push(directory);
  return directory;
};

const createClock = (initial = '2026-08-22T10:00:00.000Z') => {
  let value = new Date(initial);
  return {
    now: () => new Date(value),
    set: (next) => {
      value = new Date(next);
    },
  };
};

const createVault = async (dataDirectory, overrides = {}) => {
  const clock = overrides.clock || createClock();
  const vault = await createBotCredentialVault({
    dataDirectory,
    getBotEncryptionKey: overrides.getBotEncryptionKey || (() => Buffer.from(KEY)),
    now: clock.now,
  });
  return { vault, clock };
};

const teamCredential = (overrides = {}) => ({
  id: CREDENTIAL_ID,
  botId: BOT_ID,
  provider: 'github',
  kind: 'oauth',
  credentialScope: 'team',
  ownerUserId: null,
  createdBy: CREATOR_ID,
  secret: {
    accessToken: 'access-token-plaintext',
    refreshToken: 'refresh-token-plaintext',
  },
  metadata: {
    label: 'Operations GitHub',
    accountHint: 'ops@example.test',
    accessToken: 'metadata-token-must-be-redacted',
    nested: { password: 'metadata-password-must-be-redacted' },
  },
  ...overrides,
});

describe('Production Bots local credential vault', () => {
  it('creates and reads a credential while retaining only ciphertext in runtime state and on disk', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const { vault } = await createVault(dataDirectory);

    const created = await vault.create(teamCredential());

    expect(created).toEqual({
      id: CREDENTIAL_ID,
      botId: BOT_ID,
      provider: 'github',
      kind: 'oauth',
      credentialScope: 'team',
      ownerUserId: null,
      createdBy: CREATOR_ID,
      status: 'active',
      localVaultReference: `bot-credential:${CREDENTIAL_ID}`,
      metadata: {
        label: 'Operations GitHub',
        accountHint: 'ops@example.test',
        accessToken: '[REDACTED]',
        nested: { password: '[REDACTED]' },
      },
      keyId: 'deployment-v1',
      secretVersion: 1,
      rotationCount: 0,
      createdAt: '2026-08-22T10:00:00.000Z',
      updatedAt: '2026-08-22T10:00:00.000Z',
      rotatedAt: null,
      revokedAt: null,
    });
    expect(created).not.toHaveProperty('secret');
    expect(created).not.toHaveProperty('secretEnvelope');

    const raw = await fs.readFile(vault.paths.vaultPath, 'utf8');
    expect(raw).not.toContain('access-token-plaintext');
    expect(raw).not.toContain('refresh-token-plaintext');
    expect(raw).not.toContain('metadata-token-must-be-redacted');
    expect(raw).not.toContain('metadata-password-must-be-redacted');
    expect((await fs.stat(vault.paths.vaultPath)).mode & 0o777).toBe(0o600);
    expect(vault.paths.vaultPath).toBe(path.join(
      dataDirectory,
      'bots',
      'vault',
      'credentials.v1.json',
    ));

    expect(await vault.read(CREDENTIAL_ID)).toEqual({
      credential: created,
      secret: {
        accessToken: 'access-token-plaintext',
        refreshToken: 'refresh-token-plaintext',
      },
    });
    expect(vault.list()).toEqual([created]);
  });

  it('reloads encrypted credentials without caching plaintext', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const { vault } = await createVault(dataDirectory);
    await vault.create(teamCredential());

    const { vault: reloaded } = await createVault(dataDirectory);
    expect(reloaded.list()).toHaveLength(1);
    expect(await reloaded.read(CREDENTIAL_ID)).toMatchObject({
      secret: { accessToken: 'access-token-plaintext' },
    });
  });

  it('rotates secrets with deterministic version and timestamp metadata', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const { vault, clock } = await createVault(dataDirectory);
    await vault.create(teamCredential());
    clock.set('2026-08-22T11:30:00.000Z');

    const rotated = await vault.rotate(CREDENTIAL_ID, {
      accessToken: 'replacement-access-token',
      refreshToken: 'replacement-refresh-token',
    });

    expect(rotated).toMatchObject({
      secretVersion: 2,
      rotationCount: 1,
      rotatedAt: '2026-08-22T11:30:00.000Z',
      updatedAt: '2026-08-22T11:30:00.000Z',
      status: 'active',
      keyId: 'deployment-v1',
    });
    expect((await vault.read(CREDENTIAL_ID)).secret).toEqual({
      accessToken: 'replacement-access-token',
      refreshToken: 'replacement-refresh-token',
    });
    const raw = await fs.readFile(vault.paths.vaultPath, 'utf8');
    expect(raw).not.toContain('access-token-plaintext');
    expect(raw).not.toContain('replacement-access-token');
  });

  it('revokes a credential, destroys its encrypted payload, and prevents later reads or rotation', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const { vault, clock } = await createVault(dataDirectory);
    await vault.create(teamCredential());
    clock.set('2026-08-22T12:00:00.000Z');

    const revoked = await vault.revoke(CREDENTIAL_ID);

    expect(revoked).toMatchObject({
      status: 'revoked',
      revokedAt: '2026-08-22T12:00:00.000Z',
      updatedAt: '2026-08-22T12:00:00.000Z',
    });
    await expect(vault.read(CREDENTIAL_ID)).rejects.toMatchObject({
      code: 'bot_credential_revoked',
    });
    await expect(vault.rotate(CREDENTIAL_ID, { token: 'nope' })).rejects.toMatchObject({
      code: 'bot_credential_revoked',
    });

    const state = JSON.parse(await fs.readFile(vault.paths.vaultPath, 'utf8'));
    expect(state.credentials[CREDENTIAL_ID].secretEnvelope).toBeNull();
  });

  it('projects only non-secret metadata into the Supabase credential shape', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const { vault } = await createVault(dataDirectory);
    await vault.create(teamCredential());

    const record = vault.toSupabaseRecord(CREDENTIAL_ID);

    expect(record).toEqual({
      id: CREDENTIAL_ID,
      bot_id: BOT_ID,
      provider: 'github',
      kind: 'oauth',
      credential_scope: 'team',
      owner_user_id: null,
      local_vault_reference: `bot-credential:${CREDENTIAL_ID}`,
      metadata: {
        label: 'Operations GitHub',
        accountHint: 'ops@example.test',
        accessToken: '[REDACTED]',
        nested: { password: '[REDACTED]' },
        keyId: 'deployment-v1',
        secretVersion: 1,
        rotationCount: 0,
        rotatedAt: null,
      },
      status: 'active',
      created_by: CREATOR_ID,
      created_at: '2026-08-22T10:00:00.000Z',
      updated_at: '2026-08-22T10:00:00.000Z',
      revoked_at: null,
    });
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain('access-token-plaintext');
    expect(serialized).not.toContain('refresh-token-plaintext');
    expect(serialized).not.toContain('ciphertext');
    expect(serialized).not.toContain('credentials.v1.json');
  });

  it('enforces scope ownership and rejects duplicate identities without echoing secrets', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const { vault } = await createVault(dataDirectory);

    await expect(vault.create(teamCredential({ ownerUserId: OWNER_ID })))
      .rejects.toMatchObject({ code: 'bot_credential_scope_invalid' });
    await expect(vault.create(teamCredential({
      credentialScope: 'user',
      ownerUserId: null,
    }))).rejects.toMatchObject({ code: 'bot_credential_scope_invalid' });

    await vault.create(teamCredential());
    const duplicateError = await vault.create(teamCredential({
      secret: { token: 'duplicate-secret-must-not-leak' },
    })).then(() => null, (error) => error);
    expect(duplicateError).toMatchObject({ code: 'bot_credential_exists' });
    expect(String(duplicateError?.message)).not.toContain('duplicate-secret-must-not-leak');
  });

  it('rolls back a failed rotation to the exact prior secret version and metadata', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const { vault } = await createVault(dataDirectory);
    await vault.create(teamCredential({
      metadata: { label: 'Production', maskedIdentifier: '••••-old' },
      secret: { type: 'api', key: 'old-api-key' },
    }));
    const previous = await vault.read(CREDENTIAL_ID);

    const rotated = await vault.rotate(
      CREDENTIAL_ID,
      { type: 'api', key: 'new-api-key' },
      { label: 'Production', maskedIdentifier: '••••-new' },
    );
    expect(rotated).toMatchObject({
      secretVersion: 2,
      metadata: { maskedIdentifier: '••••-new' },
    });

    await vault.rollbackRotation(CREDENTIAL_ID, rotated.secretVersion, previous);
    const restored = await vault.read(CREDENTIAL_ID);
    expect(restored).toEqual(previous);
    const stored = JSON.parse(await fs.readFile(vault.paths.vaultPath, 'utf8'));
    expect(JSON.stringify(stored)).not.toContain('old-api-key');
    expect(JSON.stringify(stored)).not.toContain('new-api-key');
  });

  it('serializes concurrent rotations through atomic private writes', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const { vault } = await createVault(dataDirectory);
    await vault.create(teamCredential());

    await Promise.all([
      vault.rotate(CREDENTIAL_ID, { token: 'rotation-a' }),
      vault.rotate(CREDENTIAL_ID, { token: 'rotation-b' }),
    ]);

    expect(vault.getMetadata(CREDENTIAL_ID)).toMatchObject({
      secretVersion: 3,
      rotationCount: 2,
    });
    const entries = await fs.readdir(path.dirname(vault.paths.vaultPath));
    expect(entries).toEqual(['credentials.v1.json']);
    expect((await fs.stat(vault.paths.vaultPath)).mode & 0o777).toBe(0o600);
  });

  it('exports encrypted records, restores them atomically, and rejects identity collisions', async () => {
    const sourceDirectory = await createTemporaryDirectory();
    const { vault: source } = await createVault(sourceDirectory);
    await source.create(teamCredential());

    const exported = source.exportForBot(BOT_ID);
    expect(exported.toString('utf8')).toContain('DevRyan.BotCredentialVaultExport');
    expect(exported.toString('utf8')).not.toContain('access-token-plaintext');
    expect(exported.toString('utf8')).not.toContain('refresh-token-plaintext');

    const destinationDirectory = await createTemporaryDirectory();
    const { vault: destination } = await createVault(destinationDirectory);
    await expect(destination.inspectRestoreForBot(BOT_ID, exported, {
      mode: 'empty',
      deploymentKey: KEY,
    })).resolves.toEqual({ credentialIds: [CREDENTIAL_ID] });
    await expect(destination.restoreForBot(BOT_ID, exported, { mode: 'empty' }))
      .resolves.toEqual({ restoredCount: 1 });
    await expect(destination.read(CREDENTIAL_ID)).resolves.toMatchObject({
      secret: { accessToken: 'access-token-plaintext' },
    });

    const beforeCollision = await fs.readFile(destination.paths.vaultPath, 'utf8');
    await expect(destination.restoreForBot(BOT_ID, exported, { mode: 'merge' }))
      .rejects.toMatchObject({ code: 'bot_credential_restore_collision' });
    expect(await fs.readFile(destination.paths.vaultPath, 'utf8')).toBe(beforeCollision);

    const corruptDocument = JSON.parse(exported.toString('utf8'));
    const envelope = corruptDocument.credentials[CREDENTIAL_ID].secretEnvelope;
    envelope.ciphertext = `${envelope.ciphertext[0] === 'A' ? 'B' : 'A'}${envelope.ciphertext.slice(1)}`;
    const corrupt = Buffer.from(JSON.stringify(corruptDocument), 'utf8');
    const emptyDirectory = await createTemporaryDirectory();
    const { vault: empty } = await createVault(emptyDirectory);
    await expect(empty.inspectRestoreForBot(BOT_ID, corrupt, {
      mode: 'empty',
      deploymentKey: KEY,
    })).rejects.toMatchObject({ code: 'bot_credential_restore_integrity_invalid' });
    corrupt.fill(0);
    exported.fill(0);
  });

  it('deletes only the selected Bot credentials in one persisted mutation', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const { vault } = await createVault(dataDirectory);
    const otherBotId = 'b0000000-0000-4000-8000-000000000002';
    const otherCredentialId = 'c0000000-0000-4000-8000-000000000002';
    await vault.create(teamCredential());
    await vault.create(teamCredential({ id: otherCredentialId, botId: otherBotId }));

    await expect(vault.deleteForBot(BOT_ID)).resolves.toEqual({ deletedCount: 1 });
    expect(vault.list()).toEqual([
      expect.objectContaining({ id: otherCredentialId, botId: otherBotId }),
    ]);
    await expect(vault.read(CREDENTIAL_ID)).rejects.toMatchObject({
      code: 'bot_credential_not_found',
    });
    await expect(vault.read(otherCredentialId)).resolves.toMatchObject({
      credential: expect.objectContaining({ botId: otherBotId }),
    });
  });

  it('removes one newly created candidate during assignment rollback', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const { vault } = await createVault(dataDirectory);
    await vault.create(teamCredential());

    await expect(vault.deleteCreated(CREDENTIAL_ID)).resolves.toBe(true);
    await expect(vault.deleteCreated(CREDENTIAL_ID)).resolves.toBe(false);
    await expect(vault.read(CREDENTIAL_ID)).rejects.toMatchObject({
      code: 'bot_credential_not_found',
    });
  });
});
