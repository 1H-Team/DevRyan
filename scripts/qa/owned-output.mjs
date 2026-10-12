import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Refuse aliases before creating a missing directory, then verify the created parent too. */
export async function prepareOwnedQaDirectory(directory, repository) {
  assert.ok(path.isAbsolute(directory) && path.normalize(directory) === directory
    && directory.startsWith(repository + path.sep), 'Canonical repository-owned QA output required');
  let ancestor = directory;
  for (;;) {
    try { await fs.lstat(ancestor); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; ancestor = path.dirname(ancestor); }
  }
  assert.equal(await fs.realpath(ancestor), ancestor, 'QA output ancestor cannot be a symlink');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  assert.equal(await fs.realpath(directory), directory, 'QA output parent escaped its repository');
}
