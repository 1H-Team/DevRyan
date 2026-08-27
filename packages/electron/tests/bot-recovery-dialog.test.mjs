import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, mock, test } from 'bun:test';

import { createBotRecoveryDialog } from '../bot-recovery-dialog.mjs';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

const createTemporaryDirectory = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-recovery-dialog-'));
  temporaryDirectories.push(directory);
  return directory;
};

const exportRequest = () => ({
  passphrase: 'correct horse battery staple',
  includeLibraryObjects: true,
  includeWorkspaceObjects: true,
  includeConnectorVault: false,
  confirmConnectorVault: false,
  includeEnvironmentSecrets: false,
  confirmEnvironmentSecrets: false,
  includeBrowserProfiles: false,
  confirmBrowserProfiles: false,
});

describe('Electron-owned Bot recovery dialogs', () => {
  test('streams an encrypted export through a private sibling file and atomically renames it', async () => {
    const directory = await createTemporaryDirectory();
    const destination = path.join(directory, 'DevRyan-Bot-Recovery.drbr');
    const encryptedBundle = Buffer.from('DEVRYAN-BOT-RECOVERY\nencrypted-only');
    const fetch = mock(async (_url, init) => {
      expect(JSON.parse(init.body)).toEqual(exportRequest());
      return new Response(encryptedBundle, {
        status: 200,
        headers: { 'content-length': String(encryptedBundle.byteLength) },
      });
    });
    const runtime = createBotRecoveryDialog({
      dialog: {
        showSaveDialog: async () => ({ canceled: false, filePath: destination }),
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      },
      randomUUID: () => 'temporary-id',
      now: () => new Date('2026-08-23T12:00:00.000Z'),
    });

    const result = await runtime.exportBundle({
      origin: 'http://127.0.0.1:3101',
      session: { fetch },
      botId: BOT_ID,
      request: exportRequest(),
    });

    expect(result).toEqual({ cancelled: false, fileName: path.basename(destination) });
    expect(await fs.readFile(destination)).toEqual(encryptedBundle);
    expect((await fs.stat(destination)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(directory)).toEqual([path.basename(destination)]);
    expect(fetch.mock.calls[0][0]).toBe(
      `http://127.0.0.1:3101/api/bots/${BOT_ID}/recovery/export`,
    );
  });

  test('cancels before contacting the authenticated recovery endpoint', async () => {
    const fetch = mock(async () => new Response(null, { status: 500 }));
    const runtime = createBotRecoveryDialog({
      dialog: {
        showSaveDialog: async () => ({ canceled: true }),
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      },
    });

    await expect(runtime.exportBundle({
      origin: 'http://127.0.0.1:3101',
      session: { fetch },
      botId: BOT_ID,
      request: exportRequest(),
    })).resolves.toMatchObject({ cancelled: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('opens encrypted bytes in main memory and returns only restore metadata to the renderer', async () => {
    const directory = await createTemporaryDirectory();
    const bundlePath = path.join(directory, 'recovery.drbr');
    const encryptedBundle = Buffer.from('DEVRYAN-BOT-RECOVERY\nauthenticated-ciphertext');
    await fs.writeFile(bundlePath, encryptedBundle, { mode: 0o600 });
    let sentBundle;
    const fetch = mock(async (url, init) => {
      expect(url).toBe('http://127.0.0.1:3101/api/bots/recovery/restore');
      expect(init.headers['X-DevRyan-Recovery-Passphrase']).toBe('correct horse battery staple');
      expect(init.headers['X-DevRyan-Recovery-Mode']).toBe('empty');
      sentBundle = Buffer.from(init.body);
      return Response.json({
        restored: true,
        bot: { id: BOT_ID, name: 'Release Sentinel' },
        mode: 'empty',
        result: { objectCount: 2 },
      });
    });
    const runtime = createBotRecoveryDialog({
      dialog: {
        showSaveDialog: async () => ({ canceled: true }),
        showOpenDialog: async () => ({ canceled: false, filePaths: [bundlePath] }),
      },
    });

    const result = await runtime.restoreBundle({
      origin: 'http://127.0.0.1:3101',
      session: { fetch },
      passphrase: 'correct horse battery staple',
      mode: 'empty',
    });

    expect(sentBundle).toEqual(encryptedBundle);
    expect(result).toEqual({
      cancelled: false,
      restored: true,
      bot: { id: BOT_ID, name: 'Release Sentinel' },
      mode: 'empty',
      result: { objectCount: 2 },
    });
    expect(result).not.toHaveProperty('bundle');
    expect(JSON.stringify(result)).not.toContain(encryptedBundle.toString('utf8'));
  });

  test('rejects oversized or symbolic-link restore targets before reading them', async () => {
    const directory = await createTemporaryDirectory();
    const realPath = path.join(directory, 'real.drbr');
    const linkPath = path.join(directory, 'linked.drbr');
    await fs.writeFile(realPath, 'encrypted');
    await fs.symlink(realPath, linkPath);
    const fetch = mock(async () => Response.json({ restored: true }));
    const runtime = createBotRecoveryDialog({
      dialog: {
        showSaveDialog: async () => ({ canceled: true }),
        showOpenDialog: async () => ({ canceled: false, filePaths: [linkPath] }),
      },
      maximumBundleBytes: 1024,
    });

    await expect(runtime.restoreBundle({
      origin: 'http://127.0.0.1:3101',
      session: { fetch },
      passphrase: 'correct horse battery staple',
      mode: 'merge',
    })).rejects.toMatchObject({ code: 'bot_recovery_native_invalid' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
