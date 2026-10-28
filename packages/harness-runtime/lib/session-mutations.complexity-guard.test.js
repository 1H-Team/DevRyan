import { afterEach, describe, expect } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cleanupRoots, fixture, test, withEnv } from '../test/session-mutations-fixture.js';
import { openChangeStore, changeKey } from './session-changes-store.js';

afterEach(cleanupRoots);

const FILE = 'hot.txt';
// Each version of a line uses a letter the previous one does not, so the diff
// replaces exactly that line's letters: one direct ancestry entry per edit.
const text = (versions = {}) => Array.from({ length: 12 }, (_, line) => `L${line}:${String.fromCharCode(97 + ((versions[line] ?? 0) % 26)).repeat(8)}\n`).join('');
// A guard that warns from 4 entries and switches at 6; maintenance runs only when a test asks.
const LIMITS = { complexity: { warnEntries: 4, ceilingEntries: 6 }, maintenance: { commits: Number.POSITIVE_INFINITY } };

const edit = async (f, sessionID, messageID, after) => {
  const lease = await f.begin(sessionID, messageID, `${messageID}-call`);
  await fs.writeFile(path.join(lease.viewDirectory, FILE), after);
  return f.finish(lease);
};
const document = async (f) => {
  const root = path.join(f.storage, changeKey(await fs.realpath(f.directory)));
  const db = await openChangeStore(root, path.join(root, 'git'));
  for await (const { value } of db.entries('files')) {
    if (value.published?.path !== FILE) continue;
    const revisions = [];
    for await (const revision of db.list(`revisions/${value.id}`)) revisions.push(revision);
    return { doc: value, revisions };
  }
  throw new Error(`no document for ${FILE}`);
};
// Five single-line edits leave the document one entry below the ceiling.
const nearCeiling = async (f) => {
  const versions = {};
  for (let edits = 1; edits <= 5; edits++) {
    versions[0] = edits;
    await edit(f, 's', `p${edits}`, text(versions));
  }
  expect((await document(f)).doc.runsComplexity.entries).toBe(5);
  return versions;
};

describe('document complexity guard', () => {
  for (const order of ['first', 'second']) {
    test(`a publication that crosses the ceiling makes a concurrent one conflict (lease ${order} publishes first)`, async () => {
      const f = await fixture(LIMITS);
      await f.write(FILE, text());
      const versions = await nearCeiling(f);
      // Ancestry compaction finds nothing to reduce and stamps the ledger: the guard is armed.
      await f.runtime.maintainLedger({ directory: f.directory });
      const leases = [await f.begin('a', 'qa', 'qa-call'), await f.begin('b', 'qb', 'qb-call')];
      const texts = [text({ ...versions, 3: 1 }), text({ ...versions, 9: 1 })];
      await Promise.all(leases.map((lease, index) => fs.writeFile(path.join(lease.viewDirectory, FILE), texts[index])));
      const [early, late] = order === 'first' ? [0, 1] : [1, 0];
      // Decided from the stored complexity (5): granular, and now at the ceiling.
      expect((await f.finish(leases[early])).conflicts ?? []).toEqual([]);
      expect((await document(f)).doc.runsComplexity.entries).toBe(6);
      // At the ceiling the later publication is whole content, checked as such: it conflicts.
      expect((await f.finish(leases[late])).conflicts).toEqual([{ path: FILE }]);
      expect(await f.read(FILE)).toBe(texts[early]);
      expect((await document(f)).revisions.some((revision) => revision.binary)).toBe(false);
    });
  }

  test('without the guard the same publications merge', async () => {
    await withEnv({ DEVRYAN_LEDGER_COMPLEXITY_GUARD: '0' }, async () => {
      const f = await fixture(LIMITS);
      await f.write(FILE, text());
      const versions = await nearCeiling(f);
      await f.runtime.maintainLedger({ directory: f.directory });
      const a = await f.begin('a', 'qa', 'qa-call'), b = await f.begin('b', 'qb', 'qb-call');
      await fs.writeFile(path.join(a.viewDirectory, FILE), text({ ...versions, 3: 1 }));
      await fs.writeFile(path.join(b.viewDirectory, FILE), text({ ...versions, 9: 1 }));
      expect((await f.finish(a)).conflicts ?? []).toEqual([]);
      expect((await f.finish(b)).conflicts ?? []).toEqual([]);
      expect(await f.read(FILE)).toBe(text({ ...versions, 3: 1, 9: 1 }));
    });
  });

  test('a switched document stays whole with the guard off, journals the switch, and still reverts', async () => {
    const diagnostics = [];
    const f = await fixture({ ...LIMITS, onDiagnostic: (record) => diagnostics.push(record) });
    await f.write(FILE, text());
    const versions = await nearCeiling(f);
    await f.runtime.maintainLedger({ directory: f.directory });
    expect(diagnostics.filter((record) => record.phase === 'ledger_document_complexity'))
      .toEqual([expect.objectContaining({ state: 'warning', count: 4 })]);
    versions[1] = 1; await edit(f, 's', 'p6', text(versions));
    versions[1] = 2; await edit(f, 's', 'p7', text(versions));
    let { revisions } = await document(f);
    expect(revisions.at(-2).binary).toBe(false);
    expect(revisions.at(-1).binary).toBe(true);
    expect(diagnostics).toContainEqual(expect.objectContaining({ phase: 'ledger_document_complexity', state: 'whole', count: 6 }));
    await withEnv({ DEVRYAN_LEDGER_COMPLEXITY_GUARD: '0' }, async () => {
      versions[2] = 1; await edit(f, 's', 'p8', text(versions));
    });
    ({ revisions } = await document(f));
    expect(revisions.at(-1).binary).toBe(true);
    await f.revert('s', 'p8');
    versions[2] = 0;
    expect(await f.read(FILE)).toBe(text(versions));
    await f.revert('s', 'p7');
    versions[1] = 1;
    expect(await f.read(FILE)).toBe(text(versions));
  });

  test('the guard arms only once ancestry compaction has finished for the ledger', async () => {
    const f = await fixture(LIMITS);
    await f.write(FILE, text());
    const versions = await nearCeiling(f);
    for (let edits = 6; edits <= 8; edits++) { versions[1] = edits; await edit(f, 's', `p${edits}`, text(versions)); }
    let { doc, revisions } = await document(f);
    expect(doc.runsComplexity.entries).toBe(8);
    expect(revisions.some((revision) => revision.binary)).toBe(false);
    await f.runtime.maintainLedger({ directory: f.directory });
    versions[1] = 9; await edit(f, 's', 'p9', text(versions));
    ({ revisions } = await document(f));
    expect(revisions.at(-1).binary).toBe(true);
    expect(await f.read(FILE)).toBe(text(versions));
  });
});
