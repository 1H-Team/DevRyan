import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPushRuntime } from './push-runtime.js';

const temporaryDirectories = [];
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('multi-user push delivery', () => {
  it('hashes stored app-session keys and sends only to the session owner', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-push-'));
    temporaryDirectories.push(directory);
    const subscriptionsPath = path.join(directory, 'push-subscriptions.json');
    const sendNotification = vi.fn(async () => undefined);
    const runtime = createPushRuntime({
      fsPromises: fs,
      path,
      webPush: {
        generateVAPIDKeys: () => ({ publicKey: 'public', privateKey: 'private' }),
        setVapidDetails() {},
        sendNotification,
      },
      PUSH_SUBSCRIPTIONS_FILE_PATH: subscriptionsPath,
      readSettingsFromDiskMigrated: async () => ({
        publicOrigin: 'https://devryan.example.test',
        vapidKeys: { publicKey: 'public', privateKey: 'private' },
      }),
      writeSettingsToDisk: async () => undefined,
    });
    const subscription = (endpoint) => ({ endpoint, p256dh: `p256dh-${endpoint}`, auth: `auth-${endpoint}` });
    await runtime.addOrUpdatePushSubscription('raw-session-one', subscription('https://push.test/one'), 'browser-one');
    await runtime.addOrUpdatePushSubscription('raw-session-two', subscription('https://push.test/two'), 'browser-two');
    runtime.setSessionVisibilityFilter(async (tokenHash, sessionId) => (
      sessionId === 'session-one' && tokenHash === hash('raw-session-one')
    ));

    await runtime.sendPushToAllUiSessions({
      title: 'Ready',
      data: { sessionId: 'session-one' },
    });

    expect(sendNotification).toHaveBeenCalledOnce();
    expect(sendNotification.mock.calls[0][0].endpoint).toBe('https://push.test/one');
    const stored = await fs.readFile(subscriptionsPath, 'utf8');
    expect(stored).not.toContain('raw-session-one');
    expect(stored).not.toContain('raw-session-two');
    expect(stored).toContain(hash('raw-session-one'));
    expect((await fs.stat(subscriptionsPath)).mode & 0o777).toBe(0o600);
  });

  it('suppresses push only for the matching visible app session', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-push-'));
    temporaryDirectories.push(directory);
    const sendNotification = vi.fn(async () => undefined);
    const runtime = createPushRuntime({
      fsPromises: fs,
      path,
      webPush: {
        generateVAPIDKeys: () => ({ publicKey: 'public', privateKey: 'private' }),
        setVapidDetails() {},
        sendNotification,
      },
      PUSH_SUBSCRIPTIONS_FILE_PATH: path.join(directory, 'push-subscriptions.json'),
      readSettingsFromDiskMigrated: async () => ({
        publicOrigin: 'https://devryan.example.test',
        vapidKeys: { publicKey: 'public', privateKey: 'private' },
      }),
      writeSettingsToDisk: async () => undefined,
    });
    const subscription = (endpoint) => ({ endpoint, p256dh: `key-${endpoint}`, auth: `auth-${endpoint}` });
    await runtime.addOrUpdatePushSubscription('visible-session', subscription('https://push.test/visible'));
    await runtime.addOrUpdatePushSubscription('hidden-session', subscription('https://push.test/hidden'));
    runtime.updateUiVisibility('visible-session', true);
    runtime.setSessionVisibilityFilter(async (tokenHash) => (
      [hash('visible-session'), hash('hidden-session')].includes(tokenHash)
    ));

    await runtime.sendPushToAllUiSessions({ data: { sessionId: 'owned-session' } }, { requireNoSse: true });

    expect(sendNotification).toHaveBeenCalledOnce();
    expect(sendNotification.mock.calls[0][0].endpoint).toBe('https://push.test/hidden');
  });

  it('rewrites legacy raw session-token keys during initialization', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-push-'));
    temporaryDirectories.push(directory);
    const subscriptionsPath = path.join(directory, 'push-subscriptions.json');
    await fs.writeFile(subscriptionsPath, JSON.stringify({
      version: 1,
      subscriptionsBySession: {
        'legacy-raw-session-token': [{
          endpoint: 'https://push.test/legacy',
          p256dh: 'legacy-key',
          auth: 'legacy-auth',
        }],
      },
    }));
    const runtime = createPushRuntime({
      fsPromises: fs,
      path,
      webPush: {
        generateVAPIDKeys: () => ({ publicKey: 'public', privateKey: 'private' }),
        setVapidDetails() {},
        sendNotification: vi.fn(async () => undefined),
      },
      PUSH_SUBSCRIPTIONS_FILE_PATH: subscriptionsPath,
      readSettingsFromDiskMigrated: async () => ({
        publicOrigin: 'https://devryan.example.test',
        vapidKeys: { publicKey: 'public', privateKey: 'private' },
      }),
      writeSettingsToDisk: async () => undefined,
    });

    await runtime.ensurePushInitialized();

    const stored = await fs.readFile(subscriptionsPath, 'utf8');
    expect(stored).not.toContain('legacy-raw-session-token');
    expect(stored).toContain(hash('legacy-raw-session-token'));
    expect(JSON.parse(stored).version).toBe(2);
  });
});
