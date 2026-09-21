import { describe, it, expect } from 'vitest';
import { createGitReadCoordinator, backgroundGitSignal } from './read-coordinator.js';
import { parseNumstat } from './status-details.js';
import { withGitIndexQueue } from './index-queue.js';
import os from 'node:os';

const turn = () => new Promise((resolve) => setImmediate(resolve));
describe('background Git coordination', () => {
  it('coalesces queued reads but never serves a newly arriving request with an already-started snapshot', async () => {
    const coordinate = createGitReadCoordinator({ concurrency: 1 });
    const first = Promise.withResolvers(); let runs = 0;
    const a = coordinate('repo:light', () => { runs++; return first.promise; });
    const b = coordinate('repo:light', () => { throw new Error('coalesced'); });
    await turn();
    const c = coordinate('repo:light', () => ++runs);
    const other = coordinate('other:light', () => 'other');
    expect(runs).toBe(1);
    first.resolve(1);
    expect(await Promise.all([a, b, c, other])).toEqual([1, 1, 2, 'other']);
  });

  it('retains its slot until deadline-owned work settles', async () => {
    const coordinate = createGitReadCoordinator({ concurrency: 1, timeoutMs: 10 });
    const aborted = Promise.withResolvers(), settled = Promise.withResolvers(); let nextStarted = false;
    const first = coordinate('a', async () => {
      backgroundGitSignal().addEventListener('abort', () => aborted.resolve(), { once: true });
      await settled.promise;
    });
    const rejected = expect(first).rejects.toMatchObject({ code: 'GIT_BACKGROUND_TIMEOUT' });
    await aborted.promise;
    const second = coordinate('b', () => { nextStarted = true; });
    await turn(); expect(nextStarted).toBe(false);
    settled.resolve(); await rejected; await second; expect(nextStarted).toBe(true);
  });

  it('serializes and reuses nested index ownership', async () => {
    const release = Promise.withResolvers(), entered = Promise.withResolvers(); const order = [];
    const first = withGitIndexQueue(os.tmpdir(), async () => {
      order.push('first'); entered.resolve(); await release.promise;
      await withGitIndexQueue(os.tmpdir(), () => order.push('nested'));
    });
    await entered.promise;
    const second = withGitIndexQueue(os.tmpdir(), () => order.push('second'));
    await turn(); expect(order).toEqual(['first']);
    release.resolve(); await Promise.all([first, second]); expect(order).toEqual(['first', 'nested', 'second']);
  });

  it('parses numstat paths with spaces, tabs, renames and binary counts', () => {
    expect(parseNumstat('2\t3\ta b\0-\t-\tbinary\0' + '1\t0\t\0old\0new\tname\0')).toEqual({
      'a b': { insertions: 2, deletions: 3 }, binary: { insertions: 0, deletions: 0 },
      'new\tname': { insertions: 1, deletions: 0 },
    });
  });
});

it('kills and reaps a real deadline-owned Git child before admitting another read', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { runGitCommand } = await import('./service.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-git-deadline-'));
  const originalPath = process.env.PATH, originalAgent = process.env.SSH_AUTH_SOCK;
  process.env.SSH_AUTH_SOCK = '/fixture-not-used';
  const pidFile = path.join(root, 'pid');
  const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  await fs.writeFile(path.join(root, 'git'), `#!/bin/sh\necho $$ > ${shellQuote(pidFile)}\nexec ${shellQuote(process.execPath)} -e 'setInterval(() => {}, 1000)'\n`, { mode: 0o755 });
  process.env.PATH = root + path.delimiter + originalPath;
  try {
    const coordinate = createGitReadCoordinator({ concurrency: 1, timeoutMs: 3000 });
    const first = coordinate('repo', () => runGitCommand(root, ['status']));
    const rejected = expect(first).rejects.toMatchObject({ code: 'GIT_BACKGROUND_TIMEOUT' });
    await rejected;
    const pid = Number(await fs.readFile(pidFile, 'utf8'));
    await coordinate('next', () => expect(() => process.kill(pid, 0)).toThrow());
  } finally { process.env.PATH = originalPath; if (originalAgent === undefined) delete process.env.SSH_AUTH_SOCK; else process.env.SSH_AUTH_SOCK = originalAgent; await fs.rm(root, { recursive: true, force: true }); }
}, 10_000);
