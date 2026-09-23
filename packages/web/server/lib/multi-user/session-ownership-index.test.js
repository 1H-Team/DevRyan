import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSessionOwnershipIndex, loadSessionOwnershipRows } from './session-ownership-index.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('session ownership index', () => {
  const ownership = (sessionId, userId = 'user') => ({
    session_id: sessionId, user_id: userId, project_id: 'project', branch_name: 'developer',
  });

  it('loads ownership beyond the server row cap and continues after short pages', async () => {
    const durable = Array.from({ length: 1_205 }, (_, index) => ownership(`session-${String(index).padStart(4, '0')}`));
    const requests = [];
    const rows = await loadSessionOwnershipRows(async (query) => {
      requests.push(query);
      const cursor = query.session_id?.slice(3);
      return durable.filter((row) => !cursor || row.session_id > cursor).slice(0, 137);
    });
    expect(rows).toHaveLength(1_205);
    expect(rows.at(-1).session_id).toBe('session-1204');
    expect(requests).toHaveLength(10);
    expect(requests[0]).toMatchObject({ order: 'session_id.asc', limit: 500 });
    expect(requests.at(-1).session_id).toBe('gt.session-1204');
  });

  it('rejects failed, malformed, or repeated pages instead of accepting a partial snapshot', async () => {
    let calls = 0;
    await expect(loadSessionOwnershipRows(async () => {
      if (++calls === 1) return [ownership('session-one')];
      throw new Error('unavailable');
    })).rejects.toThrow('unavailable');
    await expect(loadSessionOwnershipRows(async () => ({}))).rejects.toThrow('page is invalid');
    await expect(loadSessionOwnershipRows(async () => [ownership('session-one')]))
      .rejects.toThrow('pagination is invalid');
  });

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

  it('preserves concurrent ownership commits and revocations while replacing unchanged cached rows', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-ownership-'));
    temporaryDirectories.push(directory);
    const index = await createSessionOwnershipIndex({ dataDirectory: directory });
    await index.rebuild([
      ownership('unchanged'), ownership('updated'), ownership('deleted'), ownership('revoked'), ownership('stale'),
    ]);
    const refresh = index.beginRefresh();
    await index.set(ownership('created'));
    await index.set(ownership('created-then-deleted'));
    await index.delete('created-then-deleted');
    await index.delete('uncached-deleted');
    await index.set(ownership('updated', 'new-owner'));
    await index.delete('deleted');
    await index.archiveWhere((row) => row.session_id === 'revoked', '2026-09-13T12:00:00.000Z');
    await refresh.rebuild([
      ownership('unchanged', 'durable-owner'), ownership('updated'), ownership('deleted'), ownership('revoked'),
      ownership('created-then-deleted'), ownership('uncached-deleted'),
    ]);
    refresh.dispose();
    expect(index.get('unchanged')?.user_id).toBe('durable-owner');
    expect(index.get('updated')?.user_id).toBe('new-owner');
    expect(index.get('created')).not.toBeNull();
    expect(index.get('created-then-deleted')).toBeNull();
    expect(index.get('uncached-deleted')).toBeNull();
    expect(index.get('deleted')).toBeNull();
    expect(index.get('stale')).toBeNull();
    expect(index.get('revoked')?.archived_at).toBe('2026-09-13T12:00:00.000Z');
  });

  it('keeps a pinned pending row through a rebuild from rows that predate its remote write', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-ownership-'));
    temporaryDirectories.push(directory);
    const index = await createSessionOwnershipIndex({ dataDirectory: directory });
    const unpin = index.pin('child');
    await index.set(ownership('child'));
    await index.set(ownership('unpinned'));
    const pinnedDeleted = index.pin('child-deleted');
    await index.set(ownership('child-deleted'));
    await index.delete('child-deleted');
    const refresh = index.beginRefresh();
    await refresh.rebuild([ownership('root')]);
    refresh.dispose();
    expect(index.get('child')).not.toBeNull();
    expect(index.get('unpinned')).toBeNull();
    expect(index.get('child-deleted')).toBeNull();
    unpin(); pinnedDeleted();
    await index.rebuild([ownership('root')]);
    expect(index.get('child')).toBeNull();
  });

  it('keeps a row committed and unpinned while a stale refresh was in flight', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-ownership-'));
    temporaryDirectories.push(directory);
    const index = await createSessionOwnershipIndex({ dataDirectory: directory });
    const unpin = index.pin('child');
    await index.set(ownership('child'));
    const refresh = index.beginRefresh(); // Remote rows read before the child's write landed.
    unpin();
    await refresh.rebuild([ownership('root')]);
    refresh.dispose();
    expect(index.get('child')).not.toBeNull();
  });

  it('disposes a failed refresh without keeping its mutation overlay in later snapshots', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-ownership-'));
    temporaryDirectories.push(directory);
    const index = await createSessionOwnershipIndex({ dataDirectory: directory });
    await index.set(ownership('session-one'));
    const failedRefresh = index.beginRefresh();
    await index.delete('session-one');
    failedRefresh.dispose();
    const nextRefresh = index.beginRefresh();
    await nextRefresh.rebuild([ownership('session-one', 'durable-owner')]);
    nextRefresh.dispose();
    expect(index.get('session-one')?.user_id).toBe('durable-owner');
  });
});
