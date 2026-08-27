import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { createProfileManager } from './profiles.js';

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, {
    recursive: true,
    force: true,
  })));
});

const fixture = async (scopeMode) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-computer-profile-'));
  directories.push(root);
  const profileDirectory = path.join(root, 'profile');
  const scratchDirectory = path.join(root, 'scratch');
  const manager = createProfileManager({ profileDirectory, scratchDirectory, scopeMode });
  await manager.initialize();
  return { manager, profileDirectory, scratchDirectory };
};

describe('computer profile and scratch ownership', () => {
  test('preserves login profile and Team workspace between leases', async () => {
    const { manager, profileDirectory, scratchDirectory } = await fixture('team');
    await manager.prepareLease({ leaseId: 'run-01' });
    await fs.writeFile(path.join(profileDirectory, 'Cookies'), 'persistent login');
    await fs.writeFile(path.join(scratchDirectory, 'private.txt'), 'one lease');

    const next = await manager.prepareLease({ leaseId: 'run-02' });
    expect(next.scratchCleared).toBe(false);
    expect(await fs.readFile(path.join(profileDirectory, 'Cookies'), 'utf8')).toBe('persistent login');
    expect(await fs.readFile(path.join(scratchDirectory, 'private.txt'), 'utf8')).toBe('one lease');
  });

  test('does not clear personalized scratch on lease rotation', async () => {
    const { manager, scratchDirectory } = await fixture('personalized');
    await manager.prepareLease({ leaseId: 'run-01' });
    await fs.writeFile(path.join(scratchDirectory, 'personal.txt'), 'retained');
    const next = await manager.prepareLease({ leaseId: 'run-02' });
    expect(next.scratchCleared).toBe(false);
    expect(await fs.readFile(path.join(scratchDirectory, 'personal.txt'), 'utf8')).toBe('retained');
  });

  test('flushes Chromium before resetting the persistent profile', async () => {
    const { manager, profileDirectory } = await fixture('team');
    await fs.writeFile(path.join(profileDirectory, 'Cookies'), 'login');
    const order = [];
    await manager.resetProfile({
      closeBrowser: async () => {
        order.push('close');
        expect(await fs.readFile(path.join(profileDirectory, 'Cookies'), 'utf8')).toBe('login');
      },
    });
    order.push('reset');
    expect(order).toEqual(['close', 'reset']);
    expect(await fs.readdir(profileDirectory)).toEqual([]);
  });
});
