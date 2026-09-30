import { expect, test } from 'bun:test';
import { applyMutationText, initialMutationRuns, mutationDiff, mutationText, visibleMutationRuns } from './session-mutation-text.js';

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
