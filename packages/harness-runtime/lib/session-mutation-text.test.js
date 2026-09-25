import { expect, test } from 'bun:test';
import { applyMutationText, initialMutationRuns, mutationDiff, mutationText, visibleMutationRuns } from './session-mutation-text.js';

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
