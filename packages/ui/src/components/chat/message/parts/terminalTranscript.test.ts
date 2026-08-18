import { describe, expect, test } from 'bun:test';

import {
  TERMINAL_TRANSCRIPT_TRUNCATION_MARKER,
  createTerminalTranscriptParser,
} from './terminalTranscript';

const render = (value: string) => createTerminalTranscriptParser().update(value).text;

describe('terminal transcript normalization', () => {
  test('normalizes carriage returns, line feeds, backspace, and tabs', () => {
    expect(render('progress 10%\rprogress 20%')).toBe('progress 20%');
    expect(render('abc\bX\nnext')).toBe('abX\nnext');
    expect(render('a\tb')).toBe('a       b');
  });

  test('supports CSI cursor movement and absolute positioning', () => {
    expect(render('one\ntwo\x1b[1A\x1b[1GONE')).toBe('ONE\ntwo');
    expect(render('a\x1b[3Cb')).toBe('a   b');
    expect(render('abcd\x1b[2DX')).toBe('abXd');
    expect(render('a\x1b[2Bz')).toBe('a\n\n z');
    expect(render('top\x1b[2Ebottom')).toBe('top\n\nbottom');
    expect(render('first\nsecond\x1b[1Ftop')).toBe('topst\nsecond');
    expect(render('a\nb\x1b[1;3HX')).toBe('a X\nb');
    expect(render('a\nb\x1b[2;2fX')).toBe('a\nbX');
  });

  test('supports erase line and erase display controls', () => {
    expect(render('abcdef\x1b[3G\x1b[KZ')).toBe('abZ');
    expect(render('abcdef\x1b[2KZ')).toBe('      Z');
    expect(render('one\ntwo\x1b[2Jdone')).toBe('\n   done');
  });

  test('supports cursor save and restore in CSI and classic forms', () => {
    expect(render('abc\x1b[sXX\x1b[uZ')).toBe('abcZX');
    expect(render('abc\x1b7XX\x1b8Z')).toBe('abcZX');
  });

  test('strips SGR, private cursor controls, and complete OSC sequences', () => {
    expect(render('\x1b[31mred\x1b[0m\x1b[?25l!\x1b[?25h')).toBe('red!');
    expect(render('a\x1b]0;secret title\x07b')).toBe('ab');
    expect(render('a\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\b')).toBe('alinkb');
  });

  test('retains split escape sequences across incremental updates', () => {
    const parser = createTerminalTranscriptParser();
    expect(parser.update('start\x1b[').text).toBe('start');
    expect(parser.update('start\x1b[31').text).toBe('start');
    expect(parser.update('start\x1b[31mred').text).toBe('startred');
    expect(parser.update('start\x1b[31mred\x1b]0;ti').text).toBe('startred');
    expect(parser.update('start\x1b[31mred\x1b]0;title\x1b').text).toBe('startred');
    expect(parser.update('start\x1b[31mred\x1b]0;title\x1b\\done').text).toBe('startreddone');
  });

  test('resets and reparses when output is replaced or shrinks', () => {
    const parser = createTerminalTranscriptParser();
    expect(parser.update('old\nvalue').text).toBe('old\nvalue');
    expect(parser.update('replacement').text).toBe('replacement');
    expect(parser.update('new').text).toBe('new');
  });

  test('safely discards malformed and unsupported controls', () => {
    expect(render('a\x1b[1234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890mb')).toBe('ab');
    expect(render('a\x1bXb\x00c')).toBe('abc');
  });

  test('caps rendered lines and bytes with a visible marker', () => {
    const lineParser = createTerminalTranscriptParser({ renderedLines: 3, renderedBytes: 10_000 });
    const lineSnapshot = lineParser.update('one\ntwo\nthree\nfour');
    expect(lineSnapshot.text).toBe(`${TERMINAL_TRANSCRIPT_TRUNCATION_MARKER}\nthree\nfour`);
    expect(lineSnapshot.renderedLines).toBe(3);

    const byteParser = createTerminalTranscriptParser({ renderedLines: 10, renderedBytes: 64 });
    const byteSnapshot = byteParser.update('abcdefghijklmnopqrstuvwxyz'.repeat(8));
    expect(byteSnapshot.truncated).toBe(true);
    expect(byteSnapshot.text.startsWith(TERMINAL_TRANSCRIPT_TRUNCATION_MARKER)).toBe(true);
    expect(byteSnapshot.renderedBytes <= 64).toBe(true);
  });

  test('uses the retained raw tail to continue large append-only streams', () => {
    const parser = createTerminalTranscriptParser({ rawTailBytes: 8 });
    const first = 'prefix-' + 'x'.repeat(64);
    parser.update(first);
    const next = parser.update(`${first}\nnext`);
    expect(next.text.endsWith('\nnext')).toBe(true);
    expect(next.rawLength).toBe(first.length + 5);
  });
});
