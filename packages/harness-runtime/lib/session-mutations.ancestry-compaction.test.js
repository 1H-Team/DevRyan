import { afterEach, describe, expect, spyOn } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cleanupRoots, fixture, ledgerState, test, withEnv } from '../test/session-mutations-fixture.js';
import { openChangeStore, changeKey } from './session-changes-store.js';
import { decodeMutationRunRows, mutationText } from './session-mutation-text.js';

afterEach(cleanupRoots);

const FENCE = { format: 'ancestry', version: 2 };
const FILE = 'hot.txt';
// Every edit rewrites the same six lines; `header` and `footer` stay.
const version = (number, overrides = {}) => `header\n${Array.from({ length: 6 }, (_, line) => overrides[line] ?? `line ${line} version ${number}\n`)
  .join('')}footer\n`;

const ledgerRoot = async (f) => path.join(f.storage, changeKey(await fs.realpath(f.directory)));
const store = async (f) => { const root = await ledgerRoot(f); return openChangeStore(root, path.join(root, 'git')); };
const documentRecord = async (db) => {
  for await (const { value } of db.entries('files')) if (value.published?.path === FILE) return value;
  throw new Error(`no document for ${FILE}`);
};
const documentID = async (db) => (await documentRecord(db)).id;
const lastRevision = async (db) => {
  let last = null;
  for await (const revision of db.list(`revisions/${await documentID(db)}`)) last = revision;
  return last;
};
const pagesOf = async (db, id) => {
  const pages = [];
  for await (const { value } of db.entries(`runs/${id}`)) pages.push(value);
  return pages;
};
const runsOf = (pages) => decodeMutationRunRows(pages.filter((page, index) => !(index === 0 && page.format === 'ancestry')).flat());
const entries = (runs) => runs.reduce((sum, run) => sum + run.replaces.length, 0);
// A host before direct ancestry reads every runs page as an array of rows.
const formatOneRead = async (db, id) => { for await (const _ of db.list(`runs/${id}`)); };

// Rewrites the document as a host before direct ancestry stored it: every run
// lists its whole closure, in unfenced format 1 rows (one per 32 KiB chunk,
// each repeating the run's metadata).
const plantStoredClosures = async (f) => {
  const db = await store(f), id = await documentID(db);
  const runs = runsOf(await pagesOf(db, id));
  const byId = new Map();
  for (const run of runs) { const same = byId.get(run.id); if (same) same.push(run); else byId.set(run.id, [run]); }
  const closure = (list) => {
    const seen = new Map();
    const visit = (range) => {
      const key = `${range.id}:${range.start}:${range.length}`;
      if (seen.has(key)) return;
      seen.set(key, range);
      for (const run of byId.get(range.id) ?? []) {
        if (run.start >= range.start && run.start < range.start + range.length) for (const ancestor of run.replaces) visit(ancestor);
      }
    };
    for (const range of list) visit(range);
    return [...seen.values()];
  };
  const rows = runs.flatMap(({ text, ...metadata }) => Array.from({ length: Math.ceil(text.length / 32_768) }, (_, chunk) => ({
    ...metadata, replaces: closure(metadata.replaces), start: metadata.start + chunk * 32_768,
    bytes: Buffer.from(text.slice(chunk * 32_768, (chunk + 1) * 32_768), 'latin1').toString('base64') })));
  await db.setList(`runs/${id}`, rows);
  await db.commit();
  return entries(rows);
};

// Maintenance runs only when a test asks: an automatic pass during setup
// would find nothing to reduce yet and stamp the ledger done.
const MANUAL = { maintenance: { commits: Number.POSITIVE_INFINITY } };
// A complexity guard ceiling above the reduced history and below the stored closures.
const GUARD = { complexity: { warnEntries: 1_000, ceilingEntries: 1_500 } };
// Two ledgers given the same history; only `compacted` is maintained.
const twins = async (options) => {
  const ledgers = { compacted: await fixture({ ...MANUAL, ...options }), uncompacted: await fixture({ ...MANUAL, ...options }) };
  const each = (action) => Promise.all(Object.values(ledgers).map(action));
  const edit = (sessionID, messageID, text) => each(async (f) => {
    const lease = await f.begin(sessionID, messageID, `${messageID}-call`);
    await fs.writeFile(path.join(lease.viewDirectory, FILE), text);
    return f.finish(lease);
  });
  await each((f) => f.write(FILE, version(0)));
  for (let number = 1; number <= 30; number++) await edit('s', `p${number}`, version(number));
  return { ledgers, each, edit };
};

describe('stored-closure ancestry compaction', () => {
  test('maintenance reduces stored closures, skips a concurrently edited document, and keeps every outcome', async () => {
    await withEnv({ DEVRYAN_LEDGER_BASELINE_REFS: '0' }, async () => {
      const diagnostics = [];
      const { ledgers, each, edit } = await twins({ ...GUARD, onDiagnostic: (record) => diagnostics.push(record) });
      const { compacted: f, uncompacted: g } = ledgers;
      // Views prepared before compaction publish after it.
      const stale = await each((ledger) => ledger.begin('u', 'r1', 'r1-call'));
      const planted = await each(plantStoredClosures);
      expect(planted[0]).toBe(planted[1]);
      expect(planted[0]).toBeGreaterThan(2_000);

      // A writer lands while the document is reduced outside the lock: its
      // runs must survive, and the pass must not claim completion.
      const access = fs.access.bind(fs);
      let concurrent = null;
      const probe = spyOn(fs, 'access').mockImplementation(async (file, ...rest) => {
        if (!concurrent && String(file).endsWith(path.join('git', 'HEAD'))) {
          concurrent = (async () => {
            const lease = await f.begin('t', 'q1', 'q1-call');
            await fs.writeFile(path.join(lease.viewDirectory, FILE), version(30, { 2: 'line 2 concurrent\n' }));
            return f.finish(lease);
          })();
          await concurrent;
        }
        return access(file, ...rest);
      });
      try { await f.runtime.maintainLedger({ directory: f.directory }); }
      finally { probe.mockRestore(); }
      expect((await concurrent).files).toEqual([{ path: FILE, status: 'modified' }]);
      const lease = await g.begin('t', 'q1', 'q1-call');
      await fs.writeFile(path.join(lease.viewDirectory, FILE), version(30, { 2: 'line 2 concurrent\n' }));
      expect((await g.finish(lease)).files).toEqual([{ path: FILE, status: 'modified' }]);
      const stamp = path.join(await ledgerRoot(f), 'ancestry-compacted');
      await expect(fs.access(stamp)).rejects.toMatchObject({ code: 'ENOENT' });
      // The writer stored closures and its direct run together, fenced: a mixed
      // layout. Over the guard's ceiling, it stayed granular: the guard waits for compaction.
      const mixed = runsOf(await pagesOf(await store(f), await documentID(await store(f))));
      expect(entries(mixed)).toBeGreaterThan(planted[0]);
      expect((await documentRecord(await store(f))).runsComplexity.entries).toBe(entries(mixed));
      expect((await lastRevision(await store(f))).binary).toBe(false);

      const before = await ledgerState(f);
      await f.runtime.maintainLedger({ directory: f.directory });
      await fs.access(stamp);
      const db = await store(f), id = await documentID(db), pages = await pagesOf(db, id);
      expect(pages[0]).toEqual(FENCE);
      await expect(formatOneRead(db, id)).rejects.toMatchObject({ code: 'invalid_change_record' });
      const reduced = runsOf(pages);
      expect(entries(reduced)).toBeLessThan(entries(mixed) / 5);
      // The recorded complexity follows the reduction, so the armed guard does not switch it.
      expect((await documentRecord(db)).runsComplexity.entries).toBe(entries(reduced));
      expect(diagnostics).toContainEqual(expect.objectContaining({ phase: 'ledger_ancestry_compaction', state: 'completed', count: 1 }));
      // Same text, revisions and runs apart from their ancestry lists (and recorded complexity).
      expect(await ledgerState(f)).toEqual(before);
      expect(reduced.map(({ replaces: _replaces, ...run }) => run)).toEqual(mixed.map(({ replaces: _replaces, ...run }) => run));
      const operations = [...new Set(mixed.flatMap((run) => [run.owner, ...run.deletedBy]).filter(Boolean))];
      for (const disabled of [new Set(), ...operations.map((operation) => new Set([operation])),
        new Set(operations.filter((_, index) => index % 2)), new Set(operations.filter((_, index) => index % 3 === 1))]) {
        expect(mutationText(reduced, disabled)).toBe(mutationText(mixed, disabled));
      }
      // Nothing left to reduce: the next pass is a no-op.
      await f.runtime.maintainLedger({ directory: f.directory });
      expect(await pagesOf(await store(f), id)).toEqual(pages);

      // Later edits from stale and current views, then selective reverts,
      // end the same with and without compaction.
      const results = await Promise.all(Object.values(ledgers).map(async (ledger, index) => {
        await fs.writeFile(path.join(stale[index].viewDirectory, FILE), version(0, { 4: 'line 4 stale\n' }).replace('footer', 'footer stale'));
        return ledger.finish(stale[index]);
      }));
      expect(results[0].files).toEqual(results[1].files);
      await edit('s', 'p31', version(31, { 2: 'line 2 concurrent\n' }));
      for (const ledger of Object.values(ledgers)) expect((await lastRevision(await store(ledger))).binary).toBe(false);
      const texts = async () => Promise.all(Object.values(ledgers).map((ledger) => ledger.read(FILE)));
      for (const [sessionID, messageID] of [['s', 'p20'], ['t', 'q1'], ['s', 'p31'], ['u', 'r1'], ['s', 'p30'], ['s', 'p5']]) {
        await each((ledger) => ledger.revert(sessionID, messageID));
        const [left, right] = await texts();
        expect(left).toBe(right);
      }
    });
  }, 300_000);

  test('the kill switch leaves stored closures and writes no stamp', async () => {
    await withEnv({ DEVRYAN_LEDGER_BASELINE_REFS: '0', DEVRYAN_LEDGER_ANCESTRY_COMPACTION: '0' }, async () => {
      const f = await fixture(MANUAL);
      await f.write(FILE, version(0));
      for (let number = 1; number <= 20; number++) {
        const lease = await f.begin('s', `p${number}`, `p${number}-call`);
        await fs.writeFile(path.join(lease.viewDirectory, FILE), version(number));
        await f.finish(lease);
      }
      const planted = await plantStoredClosures(f);
      await f.runtime.maintainLedger({ directory: f.directory });
      const db = await store(f), pages = await pagesOf(db, await documentID(db));
      expect(pages.every(Array.isArray)).toBe(true);
      expect(entries(runsOf(pages))).toBe(planted);
      await expect(fs.access(path.join(await ledgerRoot(f), 'ancestry-compacted'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  }, 120_000);
});
