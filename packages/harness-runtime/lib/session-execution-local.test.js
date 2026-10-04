import { expect, spyOn, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareSessionExecution, removeExecutionSocketDirectory, sessionExecutionProfile } from './session-execution.js';

test('read denial is bounded, canonical, and only emitted by an accepted platform profile', async () => {
  const directories = { viewDirectory: '/owned/view', scratchDirectory: '/owned/scratch' };
  expect(sessionExecutionProfile(directories)).not.toContain('(deny file-read*');
  for (const deniedReadDirectories of [['relative'], ['/bad\npath'], Array(33).fill('/owned/source'), 'invalid']) {
    expect(() => sessionExecutionProfile({ ...directories, deniedReadDirectories })).toThrow('invalid_execution_path');
  }
  const base = path.resolve(import.meta.dirname, '../../../.cache/v2-validation');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'read-denial-'));
  try {
    const viewDirectory = path.join(root, 'worktree'), source = path.join(root, 'source');
    await fs.mkdir(viewDirectory); await fs.mkdir(source); await fs.symlink(source, path.join(root, 'alias'));
    const request = { launcher: path.join(root, 'launcher'), lease: { viewDirectory }, socketDirectory: null,
      workerBrowsers: false, deniedReadDirectories: [path.join(root, 'alias')] };
    if (process.platform !== 'darwin') {
      await expect(prepareSessionExecution(request)).rejects.toMatchObject({ code: 'mutation_platform_unsupported' });
      return;
    }
    const prepared = await prepareSessionExecution(request);
    const profile = await fs.readFile(prepared.profile, 'utf8');
    expect(profile).toContain(`(deny file-read* (subpath ${JSON.stringify(await fs.realpath(source))}))`);
    expect(profile).not.toContain('/alias');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('explicit no-socket preparation and cleanup stay in the owned execution view', async () => {
  const base = path.resolve(import.meta.dirname, '../../../.cache/v2-validation');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'no-socket-'));
  try {
    const viewDirectory = path.join(root, 'worktree');
    await fs.mkdir(viewDirectory);
    const lease = { viewDirectory, token: 'local-only', scope: { sessionID: 'ses_local' } };
    const prepared = await prepareSessionExecution({ launcher: path.join(root, 'launcher'), lease,
      socketDirectory: null, workerBrowsers: false });
    expect(prepared.socketDirectory).toBeNull();
    expect(prepared.environment.XDG_RUNTIME_DIR).toBeUndefined();
    expect(prepared.environment.PLAYWRIGHT_BROWSERS_PATH).toBeUndefined();
    expect(await fs.readFile(prepared.profile, 'utf8')).not.toContain('/private/tmp/dr-');
    await removeExecutionSocketDirectory(lease, null);
    const remove = fs.rm.bind(fs);
    const guarded = spyOn(fs, 'rm').mockImplementation((target, options) => {
      if (!String(target).startsWith(`${root}${path.sep}`)) throw new Error('Cleanup escaped repository fixture');
      return remove(target, options);
    });
    try {
      // This is the ledger/restart call shape, with no constructor options.
      await removeExecutionSocketDirectory(lease);
      expect(guarded).not.toHaveBeenCalled();
    } finally { guarded.mockRestore(); }
    expect((await fs.stat(viewDirectory)).isDirectory()).toBe(true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
