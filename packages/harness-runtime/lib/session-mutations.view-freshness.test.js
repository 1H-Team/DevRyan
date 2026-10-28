import { afterEach, expect } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cleanupRoots, fixture, test } from '../test/session-mutations-fixture.js';

afterEach(cleanupRoots);

// A running process serves the copy of the project its call was prepared
// with; viewFreshness says whether a later commit changed project files.
test('a view stays current until a later commit changes project files: a publication, a Revert or a reconciled outside edit', async () => {
  const f = await fixture();
  await f.write('page.txt', 'v0');
  const freshness = (lease) => f.runtime.viewFreshness({ directory: f.directory, token: lease.token });
  const server = await f.begin('server', 'ps', 'cs');
  expect(await freshness(server)).toEqual({ state: 'fresh', behind: 0 });

  // A call that changes nothing publishes nothing that could be stale.
  await f.finish(await f.begin('other', 'pi', 'ci'));
  expect(await freshness(server)).toEqual({ state: 'fresh', behind: 0 });

  const edit = await f.begin('other', 'pe', 'ce');
  await fs.writeFile(path.join(edit.viewDirectory, 'page.txt'), 'v1');
  expect((await f.finish(edit)).files).toEqual([{ path: 'page.txt', status: 'modified' }]);
  expect(await freshness(server)).toEqual({ state: 'stale', behind: 1 });

  // A call prepared now copies v1 and is current until the edit is reverted.
  const second = await f.begin('server', 'ps2', 'cs2');
  expect(await fs.readFile(path.join(second.viewDirectory, 'page.txt'), 'utf8')).toBe('v1');
  expect(await freshness(second)).toEqual({ state: 'fresh', behind: 0 });
  await f.revert('other', 'pe');
  expect(await f.read('page.txt')).toBe('v0');
  expect(await freshness(second)).toEqual({ state: 'stale', behind: 1 });
  expect(await freshness(server)).toEqual({ state: 'stale', behind: 2 });

  // An edit made outside any call counts once the ledger reconciles it, at the
  // next preparation or publication.
  const third = await f.begin('server', 'ps3', 'cs3');
  await f.write('page.txt', 'outside');
  expect(await freshness(third)).toEqual({ state: 'fresh', behind: 0 });
  await f.begin('other', 'po', 'co');
  expect(await freshness(third)).toEqual({ state: 'stale', behind: 1 });
});

test('a read-only call runs in the project itself; a finished or unknown lease has no freshness', async () => {
  const f = await fixture();
  await f.write('page.txt', 'v0');
  const readOnly = await f.begin('reader', 'pr', 'cr', { kind: 'process', preparation: 'read-only' });
  const edit = await f.begin('writer', 'pe', 'ce');
  await fs.writeFile(path.join(edit.viewDirectory, 'page.txt'), 'v1');
  await f.finish(edit);
  const freshness = (token) => f.runtime.viewFreshness({ directory: f.directory, token });
  expect(await freshness(readOnly.token)).toEqual({ state: 'fresh', behind: 0 });
  expect(await freshness(edit.token)).toEqual({ state: 'unknown' });
  expect(await freshness('lease_missing')).toEqual({ state: 'unknown' });
  expect(await freshness('')).toEqual({ state: 'unknown' });
});
