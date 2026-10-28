import { afterEach, describe, expect } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cleanupRoots, fixture, ledgerState, test, withEnv } from '../test/session-mutations-fixture.js';
import { openChangeStore, changeKey } from './session-changes-store.js';

afterEach(cleanupRoots);

const FENCE = { format: 'ancestry', version: 2 };
// Each side of the edit is longer than one 32 KiB row, so fenced runs need
// continuation rows.
const large = `${'α'.repeat(20_000)}\nmiddle\n${'ω'.repeat(20_000)}\n`;

const store = async (f) => {
  const root = path.join(f.storage, changeKey(await fs.realpath(f.directory)));
  return openChangeStore(root, path.join(root, 'git'));
};
const pagesOf = async (db, prefix) => {
  const pages = [];
  for await (const { key, value } of db.entries(prefix)) pages.push({ key: key.slice(key.lastIndexOf('/') + 1), page: value });
  return pages;
};
const documentID = async (db, file) => {
  for await (const { value } of db.entries('files')) if (value.published?.path === file) return value.id;
  throw new Error(`no document for ${file}`);
};
// A host before direct ancestry reads every runs page as an array of rows.
const formatOneRead = async (db, prefix) => { for await (const _ of db.list(prefix)); };

describe('direct ancestry format', () => {
  test('a replacement fences its document; format 1 readers fail closed on it and on its base copy', async () => {
    await withEnv({ DEVRYAN_LAZY_BASE_RUNS: '0' }, async () => {
      const f = await fixture();
      await f.write('large.txt', large);
      const edit = await f.begin('s', 'p1', 'c1');
      await fs.writeFile(path.join(edit.viewDirectory, 'large.txt'), large.replace('middle', 'center'));
      await f.finish(edit);
      const db = await store(f), id = await documentID(db, 'large.txt');
      const pages = await pagesOf(db, `runs/${id}`);
      expect(pages[0]).toEqual({ key: '0000000000.json', page: FENCE });
      expect(pages.slice(1).every(({ page }) => Array.isArray(page))).toBe(true);
      const rows = pages.slice(1).flatMap(({ page }) => page);
      const continuations = rows.filter((row) => row.continues === true);
      expect(continuations.length).toBeGreaterThan(0);
      for (const row of continuations) expect(Object.keys(row).sort()).toEqual(['bytes', 'continues']);
      await expect(formatOneRead(db, `runs/${id}`)).rejects.toMatchObject({ code: 'invalid_change_record' });

      // A view prepared from the fenced document copies its base runs fenced too.
      const next = await f.begin('s', 'p2', 'c2');
      const after = await store(f);
      await expect(formatOneRead(after, `bases/${next.token}/${id}`)).rejects.toMatchObject({ code: 'invalid_change_record' });
      expect((await pagesOf(after, `bases/${next.token}/${id}`))[0]?.page).toEqual(FENCE);
      await fs.writeFile(path.join(next.viewDirectory, 'large.txt'), large.replace('middle', 'centre'));
      await f.finish(next);
      expect(await f.read('large.txt')).toBe(large.replace('middle', 'centre'));
      await f.revert('s', 'p2');
      expect(await f.read('large.txt')).toBe(large.replace('middle', 'center'));
      await f.revert('s', 'p1');
      expect(await f.read('large.txt')).toBe(large);
    });
  });

  test('pure insertions keep format 1 rows, and fenced and unfenced documents coexist', async () => {
    const f = await fixture();
    await f.write('append.txt', 'one\ntwo\n'); await f.write('replace.txt', 'alpha\nbeta\n');
    const edit = await f.begin('s', 'p1', 'c1');
    await fs.writeFile(path.join(edit.viewDirectory, 'append.txt'), 'one\ntwo\nthree\n');
    await fs.writeFile(path.join(edit.viewDirectory, 'replace.txt'), 'alpha\nBETA\n');
    await f.finish(edit);
    const db = await store(f);
    const appendPages = await pagesOf(db, `runs/${await documentID(db, 'append.txt')}`);
    expect(appendPages.length).toBeGreaterThan(0);
    expect(appendPages.every(({ page }) => Array.isArray(page))).toBe(true);
    expect((await pagesOf(db, `runs/${await documentID(db, 'replace.txt')}`))[0]?.page).toEqual(FENCE);
    expect([await f.read('append.txt'), await f.read('replace.txt')]).toEqual(['one\ntwo\nthree\n', 'alpha\nBETA\n']);
    const state = await ledgerState(f);
    expect([state['append.txt'].revisions, state['replace.txt'].revisions]).toEqual([2, 2]);
    await f.revert('s', 'p1');
    expect([await f.read('append.txt'), await f.read('replace.txt')]).toEqual(['one\ntwo\n', 'alpha\nbeta\n']);
  });
});
