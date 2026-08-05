import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSessionOwnershipIndex } from './session-ownership-index.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('session ownership index', () => {
  it('persists an enforcement copy with private permissions and reloads it', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-ownership-'));
    temporaryDirectories.push(directory);
    const index = await createSessionOwnershipIndex({ dataDirectory: directory });
    await index.set({
      session_id: 'session-one',
      user_id: 'user-one',
      project_id: 'project-one',
      branch_name: 'developer',
      public_directory: '/projects/project-one/developer',
    });
    await index.drain();

    expect((await fs.stat(index.filePath)).mode & 0o777).toBe(0o600);
    const reloaded = await createSessionOwnershipIndex({ dataDirectory: directory });
    expect(reloaded.get('session-one')).toMatchObject({
      user_id: 'user-one',
      project_id: 'project-one',
      branch_name: 'developer',
    });
  });

  it('rejects incomplete rows and atomically rebuilds from valid durable rows', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-ownership-'));
    temporaryDirectories.push(directory);
    const index = await createSessionOwnershipIndex({ dataDirectory: directory });
    await expect(index.set({ session_id: 'missing-owner' })).rejects.toThrow('invalid');
    await index.rebuild([
      { session_id: 'valid', user_id: 'user', project_id: 'project', branch_name: 'developer' },
      { session_id: 'invalid' },
    ]);

    expect(index.list()).toHaveLength(1);
    expect(index.get('valid')).not.toBeNull();
    await index.set({ session_id: 'other', user_id: 'other-user', project_id: 'project', branch_name: 'developer' });
    await expect(index.archiveWhere(null)).rejects.toThrow('predicate');
    expect(await index.archiveWhere((row) => row.user_id === 'user', '2026-08-02T20:00:00.000Z')).toBe(1);
    expect(index.get('valid')?.archived_at).toBe('2026-08-02T20:00:00.000Z');
    expect(index.get('other')?.archived_at).toBeNull();
  });
});
