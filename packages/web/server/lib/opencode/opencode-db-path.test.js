import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveOpenCodeDbPath } from './opencode-db-path.js';

let directory;
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-db-path-')); });
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
const write = async (name, seconds) => {
  const file = path.join(directory, name);
  await fs.writeFile(file, 'x');
  await fs.utimes(file, seconds, seconds);
};

describe('the OpenCode database the runtime writes', () => {
  it('is the plain name when nothing exists yet', () => {
    expect(resolveOpenCodeDbPath(directory)).toBe(path.join(directory, 'opencode.db'));
  });

  it('is the only one that exists', async () => {
    await write('opencode-devryan.db', 100);
    expect(resolveOpenCodeDbPath(directory)).toBe(path.join(directory, 'opencode-devryan.db'));
  });

  it('is the one modified last, not a stale copy from another runtime', async () => {
    await write('opencode.db', 100);
    await write('opencode-devryan.db', 200);
    expect(resolveOpenCodeDbPath(directory)).toBe(path.join(directory, 'opencode-devryan.db'));
    await write('opencode.db', 300);
    expect(resolveOpenCodeDbPath(directory)).toBe(path.join(directory, 'opencode.db'));
  });

  it('counts a write-ahead log that has not been checkpointed', async () => {
    await write('opencode.db', 200);
    await write('opencode-devryan.db', 100);
    await write('opencode-devryan.db-wal', 300);
    expect(resolveOpenCodeDbPath(directory)).toBe(path.join(directory, 'opencode-devryan.db'));
  });
});
