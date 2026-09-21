import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, it, expect } from 'vitest';
import { readVersionedFile, writeVersionedFile } from './file-versions.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(content) {
  const root = await mkdtemp(join(tmpdir(), 'devryan-file-version-')); roots.push(root);
  const file = join(root, 'document'); await writeFile(file, content); return file;
}
it('rejects same-length external changes and preserves their bytes', async () => {
  const file = await fixture('old\r\n'); const first = await readVersionedFile(file);
  await writeFile(file, 'new\r\n');
  await expect(writeVersionedFile(file, 'mine\n', first.version)).rejects.toMatchObject({ code: 'FILE_VERSION_CONFLICT' });
  expect(await readFile(file, 'utf8')).toBe('new\r\n');
});
it('accepts one concurrent save against the same version and rejects the stale save', async () => {
  const file = await fixture('a\r\nb\nc'); const first = await readVersionedFile(file);
  const results = await Promise.allSettled([writeVersionedFile(file, 'first\r\nb\nc', first.version), writeVersionedFile(file, 'second', first.version)]);
  expect(results.map((item) => item.status)).toEqual(['fulfilled', 'rejected']);
  expect(await readFile(file, 'utf8')).toBe('first\r\nb\nc');
});
it('does not write a no-op and marks non-text bytes ineligible for editing', async () => {
  const file = await fixture('a\r\nb'); const first = await readVersionedFile(file), before = await stat(file);
  expect(await writeVersionedFile(file, first.bytes.toString(), first.version)).toBe(first.version);
  expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
  await writeFile(file, Buffer.from([0xff, 0, 1])); expect((await readVersionedFile(file)).complete).toBe(false);
});
