import { expect, test } from 'bun:test';
import { applyMutationText, decodeMutationRunRows, encodeMutationRunRows, initialMutationRuns, minimizeMutationAncestry, mutationDiff, mutationText,
  visibleMutationRuns } from './session-mutation-text.js';

const sequentialCases = [
  ['ac', ['abc', 'aXbc'], [[0, 'aXc']]],
  ['abc', ['aBc', 'aXBc'], [[0, 'aXbc']]],
  ['abc', ['aBc', 'aBXc'], [[0, 'abXc']]],
  ['ab', ['aB', 'aBX'], [[0, 'abX']]],
  ['ab', ['aB', 'aQ', 'aQX'], [[1, 'aBX'], [0, 'aQX']]],
  ['ab', ['aB', 'aBX', 'aBXY'], [[0, 'abXY']]],
  ['abc', ['ac', 'aXc'], [[0, 'aXbc']]],
  ['ad', ['abd', 'abcd', 'aXbcd'], [[0, 'aXcd'], [1, 'aXbd']]],
  ['abc', ['aBc', 'aQc', 'aXQc'], [[1, 'aXBc'], [0, 'aXQc']]],
  ['abc', ['ac', 'aC'], [[0, 'abC']]],
  ['ac', ['abc', 'aYc', 'aXYc'], [[1, 'aXbc']]],
  ['ac', ['abc', 'aYc', 'aYXc'], [[1, 'abXc']]],
  ['abc', ['ab', 'abX'], [[0, 'abXc']]],
  ['l1\nl2\n', ['l1\nL2\n', 'l1\nL2\nl3\n'], [[0, 'l1\nl2\nl3\n']]],
  ['', ['abc', 'Xabc', 'XabYc'], [[2, 'Xabc'], [1, 'abYc']]],
];
for (const [before, edits, undos] of sequentialCases) {
  test(`sequential boundaries preserve requested text and selective undo: ${JSON.stringify([before, ...edits])}`, () => {
    let runs = initialMutationRuns(before, 'base');
    for (const [index, after] of edits.entries()) {
      const prior = mutationText(runs), operation = `op-${index}`;
      runs = applyMutationText(runs, visibleMutationRuns(runs), after, operation);
      expect(mutationText(runs)).toBe(after);
      expect(mutationText(runs, new Set([operation]))).toBe(prior);
    }
    for (const [index, expected] of undos) expect(mutationText(runs, new Set([`op-${index}`]))).toBe(expected);
    expect(mutationText(runs)).toBe(edits.at(-1));
  });
}

test('stale concurrent inserts keep publication order at a shared base position', () => {
  const base = initialMutationRuns('ac', 'base');
  const first = applyMutationText(base, base, 'abc', 'a');
  const second = applyMutationText(first, base, 'aXc', 'b');
  expect(mutationText(second)).toBe('abXc');
  expect(mutationText(second, new Set(['a']))).toBe('aXc');
  expect(mutationText(second, new Set(['b']))).toBe('abc');
});

test('legacy replacement layouts retain insertion order through selective undo', () => {
  // Frozen ac -> abc -> aYc ledger from the old boundary algorithm: the
  // replaced b precedes Y. Loading it must not rewrite its stored run order.
  const legacy = [
    { id: 'base', start: 0, text: 'a', owner: null, deletedBy: [], replaces: [] },
    { id: 'a:0', start: 0, text: 'b', owner: 'a', deletedBy: ['b'], replaces: [] },
    { id: 'b:0', start: 0, text: 'Y', owner: 'b', deletedBy: [], replaces: [{ id: 'a:0', start: 0, length: 1 }] },
    { id: 'base', start: 1, text: 'c', owner: null, deletedBy: [], replaces: [] },
  ];
  const stored = structuredClone(legacy);
  for (const [after, undone] of [['aXYc', 'aXbc'], ['aYXc', 'abXc']]) {
    const changed = applyMutationText(legacy, visibleMutationRuns(legacy), after, 'c');
    expect(mutationText(changed)).toBe(after);
    expect(mutationText(changed, new Set(['b']))).toBe(undone);
    expect(mutationText(changed, new Set(['c']))).toBe('aYc');
  }
  expect(legacy).toEqual(stored);
});

test('bounded seeded sequential edits reproduce every request and undo the last operation', () => {
  let seed = 29183;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let sequence = 0; sequence < 20; sequence++) {
    let text = 'abc\ndef\n', runs = initialMutationRuns(text, 'base');
    for (let index = 0; index < 30; index++) {
      const offset = random() % (text.length + 1);
      const removed = random() % (Math.min(3, text.length - offset) + 1);
      const inserted = Array.from({ length: random() % 4 }, () => 'abXY\n'[random() % 5]).join('');
      const after = text.slice(0, offset) + inserted + text.slice(offset + removed), operation = `op-${index}`;
      runs = applyMutationText(runs, visibleMutationRuns(runs), after, operation);
      expect(mutationText(runs)).toBe(after);
      expect(mutationText(runs, new Set([operation]))).toBe(text);
      text = after;
    }
  }
});

test('boundary inserts after coalesced replacements preserve text and undo order', () => {
  const base = initialMutationRuns('abc def ghi', 'base');
  const coarse = applyMutationText(base, base, 'aBc dEf ghi', 'a', { hunkBudget: 1 });
  const changed = applyMutationText(coarse, visibleMutationRuns(coarse), 'aBc dEXf ghi', 'b');
  expect(mutationText(coarse)).toBe('aBc dEf ghi');
  expect(mutationText(changed)).toBe('aBc dEXf ghi');
  expect(mutationText(changed, new Set(['b']))).toBe('aBc dEf ghi');
  expect(mutationText(changed, new Set(['a']))).toBe('abc deXf ghi');
});

test('sequential boundary edits preserve CRLF, UTF-8 and binary bytes', () => {
  const cases = [
    ['a\r\nc', ['a\r\nbc', 'a\r\nXbc'], 'a\r\nXc'],
    ['éc', ['é😀c', 'é🀄😀c'], 'é🀄c'],
    [Buffer.from([0, 255, 97]), [Buffer.from([0, 255, 98]), Buffer.from([0, 254, 98])], Buffer.from([0, 254, 98])],
  ];
  const bytes = (value) => Buffer.from(value).toString('latin1');
  for (const [before, edits, undone] of cases) {
    let runs = initialMutationRuns(bytes(before), 'base');
    for (const [index, after] of edits.entries()) {
      const prior = mutationText(runs), operation = `op-${index}`;
      runs = applyMutationText(runs, visibleMutationRuns(runs), bytes(after), operation);
      expect(mutationText(runs)).toBe(bytes(after));
      expect(mutationText(runs, new Set([operation]))).toBe(prior);
    }
    expect(mutationText(runs, new Set(['op-0']))).toBe(bytes(undone));
  }
});

test('diff reconstruction and captured mutations preserve arbitrary bytes', () => {
  let seed = 78231;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let n = 0; n < 500; n++) {
    const a = Array.from({ length: random() % 100 }, () => String.fromCharCode(random() % 9)).join('');
    const b = Array.from({ length: random() % 100 }, () => String.fromCharCode(random() % 9)).join('');
    const delta = mutationDiff(a, b);
    expect(delta.filter((part) => part.kind !== 'insert').map((part) => part.text).join('')).toBe(a);
    expect(delta.filter((part) => part.kind !== 'delete').map((part) => part.text).join('')).toBe(b);
    const base = initialMutationRuns(a, 'base');
    const changed = applyMutationText(base, base, b, 'a');
    expect(mutationText(changed)).toBe(b);
    expect(mutationText(changed, new Set(['a']))).toBe(a);
  }
});

test('selective undo preserves another session on the same line and through redo', () => {
  const base = initialMutationRuns('a = 1; b = 2;\r\n', 'base');
  const a = applyMutationText(base, base, 'a = 3; b = 2;\r\n', 'a');
  const b = applyMutationText(a, visibleMutationRuns(a), 'a = 3; b = 4;\r\n', 'b');
  expect(mutationText(b, new Set(['a']))).toBe('a = 1; b = 4;\r\n');
  expect(mutationText(b)).toBe('a = 3; b = 4;\r\n');
});

test('a surviving replacement suppresses its ancestors instead of resurrecting them', () => {
  const base = initialMutationRuns('x = 1', 'base');
  const a = applyMutationText(base, base, 'x = 2', 'a');
  const b = applyMutationText(a, visibleMutationRuns(a), 'x = 3', 'b');
  expect(mutationText(b, new Set(['a']))).toBe('x = 3');
  expect(mutationText(b, new Set(['b']))).toBe('x = 2');
  expect(mutationText(b, new Set(['a', 'b']))).toBe('x = 1');
});

test('late publication from an old view cannot resurrect a reverted operation', () => {
  const base = initialMutationRuns('a = 1; b = 2;', 'base');
  const a = applyMutationText(base, base, 'a = 3; b = 2;', 'a');
  const oldView = visibleMutationRuns(a);
  const late = applyMutationText(a, oldView, 'a = 3; b = 4;', 'b');
  expect(mutationText(late, new Set(['a']))).toBe('a = 1; b = 4;');
});

test('identical text at different positions retains its execution-base identity', () => {
  const base = initialMutationRuns('same\nsame\nsame\n', 'base');
  const a = applyMutationText(base, base, 'same\nA\nsame\n', 'a');
  const b = applyMutationText(a, base, 'same\nsame\nB\n', 'b');
  expect(mutationText(b)).toBe('same\nA\nB\n');
  expect(mutationText(b, new Set(['a']))).toBe('same\nsame\nB\n');
});

test('a deletion is not undone while another session still owns that deletion', () => {
  const base = initialMutationRuns('abc', 'base');
  const a = applyMutationText(base, base, 'ac', 'a');
  const b = applyMutationText(a, base, 'ac', 'b');
  expect(mutationText(b, new Set(['a']))).toBe('ac');
  expect(mutationText(b, new Set(['a', 'b']))).toBe('abc');
});

test('substantially different text is diffed within a bounded synchronous budget and stays exact', () => {
  let seed = 9151;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const text = (length) => Array.from({ length }, () => 'abcdefghij\n'[random() % 11]).join('');
  // Unbudgeted, these took about 27 s; budgeted about 0.2 s. The bound leaves
  // wide headroom for a loaded machine while still catching an unbounded diff.
  const a = text(32 * 1024), b = text(32 * 1024);
  const started = performance.now();
  const delta = mutationDiff(a, b);
  expect(performance.now() - started).toBeLessThan(5000);
  expect(delta.filter((part) => part.kind !== 'insert').map((part) => part.text).join('')).toBe(a);
  expect(delta.filter((part) => part.kind !== 'delete').map((part) => part.text).join('')).toBe(b);
  // A tiny budget still reconstructs both sides exactly.
  const coarse = mutationDiff(a, b, { budget: 10 });
  expect(coarse.filter((part) => part.kind !== 'insert').map((part) => part.text).join('')).toBe(a);
  expect(coarse.filter((part) => part.kind !== 'delete').map((part) => part.text).join('')).toBe(b);
  const base = initialMutationRuns(a, 'base');
  const changed = applyMutationText(base, base, b, 'x');
  expect(mutationText(changed)).toBe(b);
  expect(mutationText(changed, new Set(['x']))).toBe(a);
});

test('a large-to-small replacement and coalesced hunks keep text and undo exact', () => {
  const large = Array.from({ length: 4000 }, (_, index) => `line ${index}\n`).join('');
  const base = initialMutationRuns(large, 'base');
  const small = applyMutationText(base, base, 'short\n', 'a');
  expect(mutationText(small)).toBe('short\n');
  expect(mutationText(small, new Set(['a']))).toBe(large);
  const edited = large.replace(/line (\d*7)\n/g, 'LINE $1\n');
  const coalesced = applyMutationText(base, base, edited, 'b', { hunkBudget: 1 });
  const granular = applyMutationText(base, base, edited, 'b');
  expect(mutationText(coalesced)).toBe(edited);
  expect(mutationText(coalesced, new Set(['b']))).toBe(large);
  expect(coalesced.length).toBeLessThan(granular.length);
  // A later session's edit inside the coalesced span still survives undo of the first.
  const later = applyMutationText(coalesced, visibleMutationRuns(coalesced), edited.replace('line 5\n', 'FIVE\n'), 'c');
  expect(mutationText(later, new Set(['b']))).toContain('FIVE\n');
});

// The algorithm as it stood before direct ancestry: every replacement stored the
// full closure of what it replaced. Kept verbatim as the equivalence reference.
const reference = (() => {
const enabled = (id, inactive) => id === null || !inactive.has(id);
const visibleMutationRuns = (runs, inactive = new Set()) => runs.filter((run) =>
  enabled(run.owner, inactive) && !run.deletedBy.some((id) => enabled(id, inactive)));
const mutationText = (runs, inactive = new Set()) => visibleMutationRuns(runs, inactive).map((run) => run.text).join('');
const initialMutationRuns = (text, id) => text ? [{ id, start: 0, text, owner: null, deletedBy: [], replaces: [] }] : [];

function splitAt(runs, id, offset) {
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (run.id !== id || offset <= run.start || offset >= run.start + run.text.length) continue;
    const cut = offset - run.start;
    runs.splice(i, 1, { ...run, text: run.text.slice(0, cut), deletedBy: [...run.deletedBy] },
      { ...run, start: offset, text: run.text.slice(cut), deletedBy: [...run.deletedBy] });
    return;
  }
}

function baseRange(base, start, length) {
  const ranges = [];
  let position = 0;
  for (const run of base) {
    const low = Math.max(start, position), high = Math.min(start + length, position + run.text.length);
    if (low < high) ranges.push({ id: run.id, start: run.start + low - position, length: high - low });
    position += run.text.length;
  }
  return ranges;
}

function anchorAt(base, offset) {
  let position = 0, left = null;
  for (const run of base) {
    if (offset < position + run.text.length) {
      if (offset > position) left = { id: run.id, offset: run.start + offset - position };
      return { left, right: { id: run.id, offset: run.start + offset - position } };
    }
    position += run.text.length;
    left = { id: run.id, offset: run.start + run.text.length };
  }
  return { left, right: null };
}

function pastReplaced(runs, at) {
  const owner = runs[at - 1];
  while (at < runs.length && owner.replaces.some((range) => runs[at].id === range.id
    && runs[at].start >= range.start && runs[at].start < range.start + range.length)) at++;
  return at;
}

/** Record changes from a private base, including when that base has since been
 * reverted. Tombstones and replacement ancestry remain addressable forever
 * while any execution or undo record references them. */
// Each hunk scans the run list (split, anchor, ownership). Past this many
// hunk × run steps, every hunk merges into one replacement spanning the first
// to the last change: the same text, with coarser ownership.
const MUTATION_HUNK_WORK_BUDGET = 2_000_000;
const coalesceChanges = (changes) => {
  const first = changes.findIndex((change) => change.kind !== 'equal');
  const last = changes.findLastIndex((change) => change.kind !== 'equal');
  if (first < 0) return changes;
  const span = changes.slice(first, last + 1);
  const removed = span.filter((change) => change.kind !== 'insert').map((change) => change.text).join('');
  const inserted = span.filter((change) => change.kind !== 'delete').map((change) => change.text).join('');
  return [...changes.slice(0, first), ...(removed ? [{ kind: 'delete', text: removed }] : []),
    ...(inserted ? [{ kind: 'insert', text: inserted }] : []), ...changes.slice(last + 1)];
};

function applyMutationText(runs, base, after, operationID, { hunkBudget = MUTATION_HUNK_WORK_BUDGET } = {}) {
  const result = runs.map((run) => ({ ...run, deletedBy: [...run.deletedBy] }));
  let changes = mutationDiff(base.map((run) => run.text).join(''), after);
  const hunks = changes.reduce((count, change, index) => count + (change.kind !== 'equal' && changes[index - 1]?.kind !== 'delete'
    && changes[index - 1]?.kind !== 'insert' ? 1 : 0), 0);
  if (hunks > 1 && hunks * (result.length + base.length) > hunkBudget) changes = coalesceChanges(changes);
  let offset = 0, index = 0;
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    if (change.kind === 'equal') { offset += change.text.length; continue; }
    let removed = '', inserted = '';
    while (i < changes.length && changes[i].kind !== 'equal') {
      if (changes[i].kind === 'delete') removed += changes[i].text;
      else inserted += changes[i].text;
      i++;
    }
    i--;
    const anchor = anchorAt(base, offset);
    const ranges = baseRange(base, offset, removed.length);
    const covered = new Map();
    const visit = (range) => {
      const key = `${range.id}:${range.start}:${range.length}`;
      if (covered.has(key)) return;
      covered.set(key, range);
      splitAt(result, range.id, range.start); splitAt(result, range.id, range.start + range.length);
      for (const run of result) {
        if (run.id !== range.id || run.start < range.start || run.start >= range.start + range.length) continue;
        if (!run.deletedBy.includes(operationID)) run.deletedBy.push(operationID);
        // A later replacement must keep suppressing the replaced value when an
        // earlier replacement is undone. It is not a new insertion beside it.
        for (const ancestor of run.replaces) visit(ancestor);
      }
    };
    for (const range of ranges) visit(range);
    if (inserted) {
      if (anchor.left) splitAt(result, anchor.left.id, anchor.left.offset);
      if (anchor.right) splitAt(result, anchor.right.id, anchor.right.offset);
      const boundary = !removed && anchor.left && (!anchor.right || anchor.left.id !== anchor.right.id
        || anchor.left.offset !== anchor.right.offset);
      let at = !boundary && anchor.right ? result.findIndex((run) => run.id === anchor.right.id && run.start === anchor.right.offset) : -1;
      if (at < 0 && anchor.left) {
        const left = result.findIndex((run) => run.id === anchor.left.id && run.start + run.text.length === anchor.left.offset);
        if (left >= 0) at = boundary ? pastReplaced(result, left + 1) : left + 1;
      }
      if (at < 0) at = result.length;
      result.splice(at, 0, { id: `${operationID}:${index++}`, start: 0, text: inserted,
        owner: operationID, deletedBy: [], replaces: [...covered.values()] });
    }
    offset += removed.length;
  }
  return result;
}

  return { applyMutationText };
})();

test('direct ancestry projects like the stored closure under undo sets and stale bases', () => {
  let seed = 7331;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const pieces = ['a', 'b', 'X', '\n', 'line '];
  for (let sequence = 0; sequence < 24; sequence++) {
    const initial = 'line one\nline two\nline three\n';
    let current = { reference: initialMutationRuns(initial, 'base'), candidate: initialMutationRuns(initial, 'base') };
    const history = [current], operations = [];
    for (let index = 0; index < 24; index++) {
      // A view may be prepared from any earlier snapshot, under any undo set.
      const from = history[random() % history.length];
      const undone = new Set(operations.filter(() => random() % 4 === 0));
      const referenceBase = visibleMutationRuns(from.reference, undone), candidateBase = visibleMutationRuns(from.candidate, undone);
      const text = referenceBase.map((run) => run.text).join('');
      expect(candidateBase.map((run) => run.text).join('')).toBe(text);
      const offset = random() % (text.length + 1);
      const removed = random() % (Math.min(6, text.length - offset) + 1);
      const inserted = Array.from({ length: random() % 6 }, () => pieces[random() % pieces.length]).join('');
      const after = text.slice(0, offset) + inserted + text.slice(offset + removed), operation = `op-${index}`;
      current = { reference: reference.applyMutationText(current.reference, referenceBase, after, operation),
        candidate: applyMutationText(current.candidate, candidateBase, after, operation) };
      operations.push(operation); history.push(current);
      const sets = [new Set(), ...operations.map((id) => new Set([id])),
        ...Array.from({ length: 12 }, () => new Set(operations.filter(() => random() % 3 === 0)))];
      for (const disabled of sets) expect(mutationText(current.candidate, disabled)).toBe(mutationText(current.reference, disabled));
    }
  }
});

test('the run index equals the runs grouped by id after every hunk', () => {
  let runs = initialMutationRuns('alpha\nbeta\ngamma\ndelta\n', 'base'), checks = 0;
  const grouped = (result) => {
    const map = new Map();
    for (const run of result) { const list = map.get(run.id); if (list) list.push(run); else map.set(run.id, [run]); }
    return map;
  };
  const edits = ['alpha\nBETA\ngamma\ndelta\n', 'alpha\nB\nGAMMA\ndelta\n', 'ALPHA\nB\nGAMMA\ndel\n', 'ALPHA\nbeta\nGAMMA\ndel\nX\n'];
  for (const [index, after] of edits.entries()) {
    runs = applyMutationText(runs, visibleMutationRuns(runs), after, `op-${index}`, { onHunk: (result, byId) => {
      checks += 1;
      const expected = grouped(result);
      expect([...byId.keys()].sort()).toEqual([...expected.keys()].sort());
      for (const [id, list] of expected) expect(new Set(byId.get(id))).toEqual(new Set(list));
    } });
    expect(mutationText(runs)).toBe(after);
  }
  expect(checks).toBeGreaterThan(edits.length);
});

test('ancestry stays bounded across 70 overlapping rewrites of one large file', () => {
  const words = ['patient', 'booking', 'professional', 'calendar', 'export', 'status', 'details', 'card', 'row', 'filter'];
  const pick = (version, line) => words[(version * 7 + line * 3) % words.length];
  const block = (index, version) => `\n  it('${pick(version, 1)} view ${index}.${version}', () => {\n${Array.from({ length: 12 + (version % 4) }, (_, line) =>
    `    const ${pick(version + line, line)}${line} = screen.getByTestId('${pick(version, line)}-${line}-${(version * 13 + line) % 97}');\n`
    + `    expect(${pick(version + line, line)}${line}).toHaveTextContent(/${pick(version + 1, line)} ${(version + line) % 11}/i);`).join('\n')}\n  });\n`;
  const versions = Array.from({ length: 40 }, () => 0);
  const render = () => `describe('fixture', () => {${versions.map((version, index) => block(index, version)).join('')}});\n`;
  let runs = initialMutationRuns(render(), 'doc:baseline');
  for (let edit = 1; edit <= 70; edit += 1) {
    versions[edit % 3 === 0 ? 6 : 5] += 1;
    const after = render();
    runs = applyMutationText(runs, visibleMutationRuns(runs), after, `op${edit}`);
    expect(mutationText(runs)).toBe(after);
  }
  const total = runs.reduce((sum, run) => sum + run.replaces.length, 0);
  const largest = Math.max(...runs.map((run) => run.replaces.length));
  // The stored-closure algorithm reached 1.84M entries (largest 2,941) here.
  expect(total).toBeLessThan(250_000);
  expect(largest).toBeLessThan(2_000);
}, 120_000);

test('format 2 rows store run metadata once and decode to the same runs as format 1 rows', () => {
  const runs = [{ id: 'a', start: 0, text: 'x'.repeat(70_000), owner: null, deletedBy: [], replaces: [] },
    { id: 'b:0', start: 0, text: 'yz', owner: 'b', deletedBy: ['c'], replaces: [{ id: 'a', start: 5, length: 3 }] }];
  const rows = encodeMutationRunRows(runs);
  expect(rows.map((row) => row.continues === true)).toEqual([false, true, true, false]);
  expect(Object.keys(rows[1]).sort()).toEqual(['bytes', 'continues']);
  // Format 1 (today's saveRuns): every 32 KiB chunk repeats the metadata.
  const formatOne = runs.flatMap(({ text, ...metadata }) => Array.from({ length: Math.ceil(text.length / 32_768) }, (_, chunk) => ({
    ...metadata, start: metadata.start + chunk * 32_768, text: text.slice(chunk * 32_768, (chunk + 1) * 32_768) })));
  expect(decodeMutationRunRows(rows)).toEqual(formatOne);
  expect(decodeMutationRunRows(formatOne.map(({ text, ...metadata }) => ({ ...metadata, bytes: Buffer.from(text, 'latin1').toString('base64') }))))
    .toEqual(formatOne);
  expect(() => decodeMutationRunRows([{ continues: true, bytes: '' }])).toThrow('invalid mutation run row');
  expect(() => decodeMutationRunRows([{ id: 'a', start: 0, deletedBy: [], replaces: [] }])).toThrow('invalid mutation run row');
});

// Every (id, offset) unit a list reaches, as `replacedClosure` derives it:
// through the lists of the runs starting inside each reached range.
const closureUnits = (runs, list) => {
  const byId = new Map();
  for (const run of runs) { const same = byId.get(run.id); if (same) same.push(run); else byId.set(run.id, [run]); }
  const seen = new Set(), units = new Set(), stack = [...list];
  while (stack.length) {
    const range = stack.pop(), key = `${range.id}:${range.start}:${range.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (let offset = range.start; offset < range.start + range.length; offset++) units.add(`${range.id}@${offset}`);
    for (const run of byId.get(range.id) ?? []) if (run.start >= range.start && run.start < range.start + range.length) stack.push(...run.replaces);
  }
  return [...units].sort();
};
const rangeKey = (range) => `${range.id}:${range.start}:${range.length}`;
const isSubsequence = (part, whole) => {
  let at = 0;
  for (const range of whole) if (at < part.length && rangeKey(part[at]) === rangeKey(range)) at++;
  return at === part.length;
};
// Stored and read back: format 1 repeats a run's list on every 32 KiB chunk
// (equal, separate arrays); format 2 stores it once per run.
const storedRuns = (runs, format) => decodeMutationRunRows(JSON.parse(JSON.stringify(format === 2 ? encodeMutationRunRows(runs)
  : runs.flatMap(({ text, ...metadata }) => Array.from({ length: Math.ceil(text.length / 32_768) }, (_, chunk) => ({ ...metadata,
    start: metadata.start + chunk * 32_768, bytes: Buffer.from(text.slice(chunk * 32_768, (chunk + 1) * 32_768), 'latin1').toString('base64') }))))));
const expectSameClosures = (original, compacted) => {
  expect(compacted.map(({ replaces: _replaces, ...run }) => run)).toEqual(original.map(({ replaces: _replaces, ...run }) => run));
  for (const [index, run] of original.entries()) {
    expect(isSubsequence(compacted[index].replaces, run.replaces)).toBe(true);
    expect(closureUnits(compacted, compacted[index].replaces)).toEqual(closureUnits(original, run.replaces));
  }
};

test('compaction keeps every closure and every later edit, from stored closures and mixed layouts', async () => {
  let seed = 9157;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const pieces = ['a', 'b', 'X', '\n', 'line '];
  let reduced = 0;
  for (let sequence = 0; sequence < 12; sequence++) {
    // Some documents hold a run longer than one stored chunk, which itself
    // gets replaced in part.
    const initial = `line one\nline two\n${sequence % 3 === 0 ? `${'z'.repeat(34_000)}\n` : ''}line three\n`;
    const snapshots = [initial ? initialMutationRuns(initial, 'base') : []], operations = [];
    const edit = (lines, applyAll) => {
      const fromIndex = random() % snapshots.length, undone = new Set(operations.filter(() => random() % 4 === 0));
      const bases = Object.fromEntries(Object.entries(lines).map(([line]) => [line,
        visibleMutationRuns((snapshots[fromIndex][line] ?? snapshots[fromIndex]), undone)]));
      const text = Object.values(bases)[0].map((run) => run.text).join('');
      for (const base of Object.values(bases)) expect(base.map((run) => run.text).join('')).toBe(text);
      const offset = random() % (text.length + 1), removed = random() % (Math.min(6, text.length - offset) + 1);
      const inserted = Array.from({ length: random() % 6 }, () => pieces[random() % pieces.length]).join('');
      const operation = `op-${operations.length}`;
      operations.push(operation);
      return applyAll(bases, text.slice(0, offset) + inserted + text.slice(offset + removed), operation);
    };
    // Stored closures (an older host), then direct ancestry on top in some documents.
    let runs = snapshots[0];
    const legacyEdits = 10 + (random() % 10), directEdits = sequence % 2 ? 4 + (random() % 6) : 0;
    for (let index = 0; index < legacyEdits + directEdits; index++) {
      runs = edit({ runs }, ({ runs: base }, after, operation) => (index < legacyEdits
        ? reference.applyMutationText(runs, base, after, operation) : applyMutationText(runs, base, after, operation)));
      snapshots.push(runs);
    }
    const stored = storedRuns(runs, sequence % 4 < 2 ? 1 : 2);
    const result = await minimizeMutationAncestry(stored);
    expectSameClosures(stored, result.runs);
    expect(result.after).toBeLessThanOrEqual(result.before);
    reduced += result.before - result.after;
    // Continue from views of any snapshot under any undo set, with and without
    // compaction (and, for stored closures only, as the older host would).
    let lines = { uncompacted: stored, compacted: result.runs, ...(directEdits ? {} : { legacy: stored }) };
    for (let index = 0; index < 12; index++) {
      lines = edit(lines, (bases, after, operation) => Object.fromEntries(Object.entries(lines).map(([line, current]) => [line,
        line === 'legacy' ? reference.applyMutationText(current, bases[line], after, operation)
          : applyMutationText(current, bases[line], after, operation)])));
      snapshots.push(lines);
      const sets = [new Set(), ...operations.slice(-6).map((id) => new Set([id])),
        ...Array.from({ length: 10 }, () => new Set(operations.filter(() => random() % 3 === 0)))];
      for (const disabled of sets) {
        const expected = mutationText(lines.uncompacted, disabled);
        for (const current of Object.values(lines)) expect(mutationText(current, disabled)).toBe(expected);
      }
    }
  }
  expect(reduced).toBeGreaterThan(0);
}, 60_000);

test('compaction keeps partially overlapping ranges and drops a range covered by several', async () => {
  const run = (id, start, text, replaces = [], owner = id.split(':')[0]) => ({ id, start, text, owner, deletedBy: [], replaces });
  const runs = [
    run('base', 0, 'abc', [], null), run('base', 3, 'defghij', [], null),
    run('op1:0', 0, 'XY', [{ id: 'base', start: 0, length: 3 }]),
    run('op2:0', 0, 'ZW', [{ id: 'base', start: 3, length: 4 }]),
    // Neither range contains the other: both stay.
    run('op3:0', 0, 'P', [{ id: 'base', start: 0, length: 5 }, { id: 'base', start: 3, length: 7 }]),
    // (base, 2, 4) lies across what op1:0 and op2:0 replaced, so only together do they cover it.
    run('op4:0', 0, 'Q', [{ id: 'base', start: 2, length: 4 }, { id: 'op1:0', start: 0, length: 2 }, { id: 'op2:0', start: 0, length: 2 },
      { id: 'base', start: 0, length: 3 }, { id: 'base', start: 3, length: 0 }]),
  ];
  const result = await minimizeMutationAncestry(runs);
  expect(result.runs[4].replaces).toBe(runs[4].replaces);
  expect(result.runs[5].replaces).toEqual([{ id: 'op1:0', start: 0, length: 2 }, { id: 'op2:0', start: 0, length: 2 }]);
  expect([result.before, result.after, result.changed]).toEqual([9, 6, true]);
  expectSameClosures(runs, result.runs);
});

test('compaction refuses cyclic or malformed ancestry', async () => {
  const run = (id, replaces) => ({ id, start: 0, text: 'x', owner: id, deletedBy: [], replaces });
  await expect(minimizeMutationAncestry([run('a', [{ id: 'b', start: 0, length: 1 }]), run('b', [{ id: 'a', start: 0, length: 1 }])]))
    .rejects.toThrow('mutation_ancestry_cycle');
  await expect(minimizeMutationAncestry([run('a', [{ id: 'b', start: -1, length: 1 }])])).rejects.toThrow('mutation_ancestry_invalid');
  await expect(minimizeMutationAncestry([run('a', [{ id: 'b', start: 0 }])])).rejects.toThrow('mutation_ancestry_invalid');
});

test('compaction reduces a stored-closure chain to direct ranges and yields within its work budget', async () => {
  let runs = initialMutationRuns('head\nvalue 0\ntail\n', 'base');
  for (let index = 1; index <= 150; index++) {
    runs = reference.applyMutationText(runs, visibleMutationRuns(runs), `head\nvalue ${index}\ntail\n`, `op${index}`);
  }
  const stored = storedRuns(runs, 1);
  let yields = 0;
  const result = await minimizeMutationAncestry(stored, { sliceMs: 0, yieldNow: async () => { yields += 1; } });
  expect(result.before).toBeGreaterThan(10_000);
  expect(result.after).toBeLessThan(result.before / 20);
  expect(yields).toBeGreaterThanOrEqual(Math.floor(result.before / 1024));
  expectSameClosures(stored, result.runs);
  expect((await minimizeMutationAncestry(stored)).runs).toEqual(result.runs);
});
