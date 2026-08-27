import { describe, expect, it, vi } from 'vitest';

import {
  BOT_RECOVERY_IMAGE_SCHEMA_VERSION,
  BOT_RECOVERY_SCHEMA_VERSION,
  createBotRecoveryBundleRuntime,
  createEncryptedBotRecoveryBundle,
  openEncryptedBotRecoveryBundle,
} from './recovery-bundle.js';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const PRINCIPAL = Object.freeze({
  id: 'a0000000-0000-4000-8000-000000000001',
  role: 'admin',
  scope: 'managed',
});
const PASSPHRASE = 'correct horse battery staple';
const DEPLOYMENT_KEY = Buffer.alloc(32, 0x5a);

const configuration = () => ({
  bot: { id: BOT_ID, name: 'Recovery Bot', tenancy: 'team' },
  revisions: [{ id: 'c0000000-0000-4000-8000-000000000001', contract: { standingRole: 'Help' } }],
});

const createRuntimeHarness = ({ inspectRestore, compatibility } = {}) => {
  const adapter = {
    exportConfiguration: vi.fn(async () => ({
      bot: { id: BOT_ID, name: 'Recovery Bot' },
      configuration: configuration(),
      objects: [{ id: 'd0000000-0000-4000-8000-000000000001', ciphertext: 'AA==' }],
    })),
    inspectRestore: inspectRestore || vi.fn(async () => ({ compatible: true })),
    restore: vi.fn(async () => ({ rows: 4, objects: 1 })),
  };
  const credentialVault = {
    exportForBot: vi.fn(async () => Buffer.from('{"version":1,"credentials":{}}')),
  };
  const environmentSecretVault = {
    exportForBot: vi.fn(async () => Buffer.from(JSON.stringify({
      version: 1,
      botId: BOT_ID,
      records: [],
    }))),
  };
  const browserProfiles = {
    exportForBot: vi.fn(async () => Buffer.from('opaque-profile-archive')),
  };
  const audit = vi.fn(async () => {});
  const runtime = createBotRecoveryBundleRuntime({
    adapter,
    encryption: { getKey: async () => Buffer.from(DEPLOYMENT_KEY) },
    credentialVault,
    environmentSecretVault,
    browserProfiles,
    compatibility,
    isGlobalAdmin: (principal) => principal?.role === 'admin',
    audit,
    now: () => new Date('2026-08-23T12:00:00.000Z'),
    uuid: () => 'e0000000-0000-4000-8000-000000000001',
  });
  return {
    runtime,
    adapter,
    credentialVault,
    environmentSecretVault,
    browserProfiles,
    audit,
  };
};

const safeRequest = (overrides = {}) => ({
  passphrase: PASSPHRASE,
  includeLibraryObjects: true,
  includeWorkspaceObjects: true,
  includeConnectorVault: false,
  confirmConnectorVault: false,
  includeEnvironmentSecrets: false,
  confirmEnvironmentSecrets: false,
  includeBrowserProfiles: false,
  confirmBrowserProfiles: false,
  ...overrides,
});

describe('passphrase-encrypted Bot recovery bundles', () => {
  it('round-trips a versioned manifest while keeping every material section encrypted', async () => {
    const bundle = await createEncryptedBotRecoveryBundle({
      passphrase: PASSPHRASE,
      bot: { id: BOT_ID, name: 'Recovery Bot' },
      sections: {
        deployment_key: {
          classification: 'protected',
          mediaType: 'application/octet-stream',
          bytes: DEPLOYMENT_KEY,
        },
        configuration: {
          classification: 'protected',
          mediaType: 'application/json',
          bytes: Buffer.from(JSON.stringify(configuration())),
        },
        selected_objects: {
          classification: 'protected',
          mediaType: 'application/json',
          bytes: Buffer.from('{"objects":[]}'),
        },
      },
      createdAt: '2026-08-23T12:00:00.000Z',
      randomBytes: (size) => Buffer.alloc(size, size === 16 ? 0x11 : 0x22),
    });

    expect(bundle.toString('utf8')).not.toContain('Recovery Bot');
    expect(bundle.toString('utf8')).not.toContain(DEPLOYMENT_KEY.toString('base64'));
    const opened = await openEncryptedBotRecoveryBundle({ passphrase: PASSPHRASE, bundle });
    expect(opened.manifest).toMatchObject({
      schemaVersion: BOT_RECOVERY_SCHEMA_VERSION,
      imageSchemaVersion: BOT_RECOVERY_IMAGE_SCHEMA_VERSION,
      bot: { id: BOT_ID, name: 'Recovery Bot' },
    });
    expect(opened.sections.deployment_key.bytes).toEqual(DEPLOYMENT_KEY);
    expect(JSON.parse(opened.sections.configuration.bytes.toString('utf8'))).toEqual(configuration());
  });

  it('rejects a wrong passphrase, changed ciphertext, and truncation without returning plaintext', async () => {
    const bundle = (await createRuntimeHarness().runtime.exportBundle(
      PRINCIPAL,
      BOT_ID,
      safeRequest(),
    )).bundle;

    await expect(openEncryptedBotRecoveryBundle({ passphrase: 'this passphrase is wrong', bundle }))
      .rejects.toMatchObject({ code: 'bot_recovery_passphrase_or_integrity_invalid' });
    const changed = Buffer.from(bundle);
    changed[changed.length - 1] ^= 0xff;
    await expect(openEncryptedBotRecoveryBundle({ passphrase: PASSPHRASE, bundle: changed }))
      .rejects.toMatchObject({ code: 'bot_recovery_corrupt' });
    await expect(openEncryptedBotRecoveryBundle({
      passphrase: PASSPHRASE,
      bundle: bundle.subarray(0, bundle.length - 9),
    })).rejects.toMatchObject({ code: 'bot_recovery_corrupt' });
  });

  it('keeps every secret section out unless each high-risk checkbox is explicit', async () => {
    const harness = createRuntimeHarness();
    const safe = await harness.runtime.exportBundle(PRINCIPAL, BOT_ID, safeRequest());
    const openedSafe = await openEncryptedBotRecoveryBundle({
      passphrase: PASSPHRASE,
      bundle: safe.bundle,
    });
    expect(Object.keys(openedSafe.sections).sort()).toEqual([
      'configuration',
      'deployment_key',
      'selected_objects',
    ]);
    expect(harness.credentialVault.exportForBot).not.toHaveBeenCalled();
    expect(harness.environmentSecretVault.exportForBot).not.toHaveBeenCalled();
    expect(harness.browserProfiles.exportForBot).not.toHaveBeenCalled();

    await expect(harness.runtime.exportBundle(PRINCIPAL, BOT_ID, safeRequest({
      includeConnectorVault: true,
    }))).rejects.toMatchObject({ code: 'bot_recovery_secret_confirmation_required' });
    await expect(harness.runtime.exportBundle(PRINCIPAL, BOT_ID, safeRequest({
      includeEnvironmentSecrets: true,
    }))).rejects.toMatchObject({ code: 'bot_recovery_secret_confirmation_required' });
    await expect(harness.runtime.exportBundle(PRINCIPAL, BOT_ID, safeRequest({
      includeBrowserProfiles: true,
    }))).rejects.toMatchObject({ code: 'bot_recovery_secret_confirmation_required' });

    const secret = await harness.runtime.exportBundle(PRINCIPAL, BOT_ID, safeRequest({
      includeConnectorVault: true,
      confirmConnectorVault: true,
      includeEnvironmentSecrets: true,
      confirmEnvironmentSecrets: true,
      includeBrowserProfiles: true,
      confirmBrowserProfiles: true,
    }));
    const openedSecret = await openEncryptedBotRecoveryBundle({
      passphrase: PASSPHRASE,
      bundle: secret.bundle,
    });
    expect(openedSecret.sections.connector_vault.classification).toBe('secret');
    expect(openedSecret.sections.environment_secrets.classification).toBe('secret');
    expect(openedSecret.sections.browser_profiles.classification).toBe('secret');

    await expect(harness.runtime.exportBundle(PRINCIPAL, BOT_ID, safeRequest({
      confirmBrowserProfiles: 'yes',
    }))).rejects.toMatchObject({ code: 'bot_recovery_invalid' });
  });

  it('validates compatibility and every collision before the restore adapter mutates state', async () => {
    const collision = Object.assign(new Error('collision'), {
      code: 'bot_recovery_collision',
      statusCode: 409,
    });
    const harness = createRuntimeHarness({ inspectRestore: vi.fn(async () => { throw collision; }) });
    const exported = await harness.runtime.exportBundle(PRINCIPAL, BOT_ID, safeRequest());
    await expect(harness.runtime.restoreBundle(PRINCIPAL, {
      passphrase: PASSPHRASE,
      mode: 'merge',
      bundle: exported.bundle,
    })).rejects.toMatchObject({ code: 'bot_recovery_collision' });
    expect(harness.adapter.restore).not.toHaveBeenCalled();

    const incompatibleSource = createRuntimeHarness({
      compatibility: { schemaVersion: 'future-schema', imageSchemaVersion: 2 },
    });
    const incompatible = await incompatibleSource.runtime.exportBundle(PRINCIPAL, BOT_ID, safeRequest());
    await expect(createRuntimeHarness().runtime.restoreBundle(PRINCIPAL, {
      passphrase: PASSPHRASE,
      mode: 'empty',
      bundle: incompatible.bundle,
    })).rejects.toMatchObject({ code: 'bot_recovery_incompatible' });
  });

  it('keeps pre-capability additive recovery bundles restorable', async () => {
    const legacy = createRuntimeHarness({
      compatibility: { schemaVersion: '20260823100000', imageSchemaVersion: 1 },
    });
    const exported = await legacy.runtime.exportBundle(PRINCIPAL, BOT_ID, safeRequest());
    const current = createRuntimeHarness();

    await expect(current.runtime.restoreBundle(PRINCIPAL, {
      passphrase: PASSPHRASE,
      mode: 'empty',
      bundle: exported.bundle,
    })).resolves.toMatchObject({ restored: true, mode: 'empty' });
  });

  it('restores only after inspection and passes optional secret sections as opaque bytes', async () => {
    const harness = createRuntimeHarness();
    const exported = await harness.runtime.exportBundle(PRINCIPAL, BOT_ID, safeRequest({
      includeConnectorVault: true,
      confirmConnectorVault: true,
      includeEnvironmentSecrets: true,
      confirmEnvironmentSecrets: true,
      includeBrowserProfiles: true,
      confirmBrowserProfiles: true,
    }));
    const restored = await harness.runtime.restoreBundle(PRINCIPAL, {
      passphrase: PASSPHRASE,
      mode: 'empty',
      bundle: exported.bundle,
    });

    expect(restored).toMatchObject({ restored: true, mode: 'empty', result: { rows: 4, objects: 1 } });
    expect(harness.adapter.inspectRestore.mock.invocationCallOrder[0])
      .toBeLessThan(harness.adapter.restore.mock.invocationCallOrder[0]);
    expect(harness.adapter.restore).toHaveBeenCalledWith(expect.objectContaining({
      deploymentKey: expect.any(Buffer),
      connectorVault: expect.any(Buffer),
      environmentSecrets: expect.any(Buffer),
      browserProfiles: expect.any(Buffer),
    }));
  });
});
