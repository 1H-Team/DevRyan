import { expect, test } from 'bun:test';
import { applySourceChanges, normalizedEditorText } from './sourceText';

test('preserves LF, CRLF, mixed endings and missing final newlines on no-op', () => {
  for (const value of ['a\nb\n', 'a\r\nb\r\n', 'a\r\nb\nc\r', 'a\r\nb']) expect(applySourceChanges(value, [])).toBe(value);
});
test('keeps untouched endings while inserting the dominant style (LF on ties)', () => {
  expect(applySourceChanges('one\r\ntwo\r\nthree\n', [{ from: 4, to: 7, insert: 'two\nadded' }])).toBe('one\r\ntwo\r\nadded\r\nthree\n');
  expect(applySourceChanges('a\r\nb\nc', [{ from: 4, to: 4, insert: 'new\n' }])).toBe('a\r\nb\nnew\nc');
});
test('handles multiple edits using the old normalized document coordinates', () => {
  const source = 'one\r\ntwo\nthree';
  expect(normalizedEditorText(source)).toBe('one\ntwo\nthree');
  expect(applySourceChanges(source, [{ from: 0, to: 3, insert: 'ONE' }, { from: 8, to: 13, insert: 'THREE' }])).toBe('ONE\r\ntwo\nTHREE');
});
