import { expect, test, vi } from 'vitest';
import { resolveControllerGitCommand } from './execution-helper-command.js';

test('Apple Git discovery resolves the executable outside the confined helper', async () => {
  const run = vi.fn(async () => ({ stdout: '/Applications/Xcode.app/Contents/Developer/usr/bin/git\n' }));
  expect(await resolveControllerGitCommand('/usr/bin/git', { platform: 'darwin', run }))
    .toBe('/Applications/Xcode.app/Contents/Developer/usr/bin/git');
  expect(run).toHaveBeenCalledWith('/usr/bin/xcrun', ['--find', 'git'], { timeout: 10_000, maxBuffer: 4096 });
  for (const [platform, command] of [['linux', '/usr/bin/git'], ['win32', 'C:\\Git\\git.exe'], ['darwin', '/opt/homebrew/bin/git']])
    expect(await resolveControllerGitCommand(command, { platform, run })).toBe(command);
  expect(run).toHaveBeenCalledTimes(1);
});

test('unavailable or malformed Apple Git selection fails closed without returning to the shim', async () => {
  for (const stdout of ['', 'git', '/usr/bin/git', '/tmp/not-git', '/tmp/../usr/bin/git', '/tmp/git\n/other/git'])
    await expect(resolveControllerGitCommand('/usr/bin/git', { platform: 'darwin', run: async () => ({ stdout }) }))
      .rejects.toMatchObject({ code: 'mutation_runtime_unsupported' });
  await expect(resolveControllerGitCommand('/usr/bin/git', { platform: 'darwin', run: async () => { throw Error('private discovery output'); } }))
    .rejects.toMatchObject({ message: 'mutation_runtime_unsupported', status: 409 });
});
