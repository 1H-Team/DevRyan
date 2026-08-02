import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

const statusMock = vi.hoisted(() => vi.fn());

vi.mock('simple-git', () => ({
  default: vi.fn(() => ({ status: statusMock })),
}));

import { getStatus } from './service.js';

const execFileAsync = promisify(execFile);
const tempDirs = [];

afterEach(async () => {
  vi.restoreAllMocks();
  statusMock.mockReset();
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('deleted-directory status handling', () => {
  it('rejects without logging when the directory disappears before status resolves', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'devryan-git-deleted-status-'));
    tempDirs.push(directory);
    await execFileAsync('git', ['init'], { cwd: directory });

    const expected = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    statusMock.mockImplementationOnce(async () => {
      await rm(directory, { recursive: true, force: true });
      throw expected;
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(getStatus(directory)).rejects.toBe(expected);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
