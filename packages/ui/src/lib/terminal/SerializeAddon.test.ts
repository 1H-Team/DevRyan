import { expect, test } from 'bun:test';
import { GhosttyTerminalCore } from '../ghostty/core';
import { terminalBuffer } from '../ghostty/buffer';
import { SerializeAddon } from './SerializeAddon';
import { loadFixtureRuntime } from '../ghostty/runtime.fixture';

test('round-trips wide graphemes, soft wraps, colors, cursor and full scrollback', async () => {
  const theme = { foreground: { r: 255, g: 255, b: 255 }, background: { r: 0, g: 0, b: 0 }, cursor: { r: 255, g: 255, b: 255 } };
  const source = await GhosttyTerminalCore.create(12, 3, 8, 16, theme, () => {}, await loadFixtureRuntime());
  const restored = await GhosttyTerminalCore.create(12, 3, 8, 16, theme, () => {}, await loadFixtureRuntime());
  const serializer = new SerializeAddon();
  serializer.activate({ get buffer() { return terminalBuffer(source.readBuffer()); } });
  try {
    source.write('first\r\n' + 'row\r\n'.repeat(30) + '\x1b[1;38;2;123;45;67m界🙂\x1b[0m123456789012345\r\nprompt> ');
    source.scroll(-12);
    const original = source.readBuffer();
    const position = source.scrollbarState();
    const text = serializer.serializeAsText();
    expect(text.startsWith('first\n')).toBe(true);
    expect(text).toContain('界🙂123456789012345');
    expect(serializer.serializeAsText({ scrollback: 1 })).not.toContain('first');
    restored.resetAndWrite(serializer.serialize());
    const result = restored.readBuffer();
    expect(result.rows.map(row => row.text)).toEqual(original.rows.map(row => row.text));
    expect([result.cursorX, result.cursorY]).toEqual([original.cursorX, original.cursorY]);
    expect(result.rows.flatMap(row => row.cells).find(cell => cell.text === '界')?.foreground).toEqual({ r: 123, g: 45, b: 67 });
    expect(source.scrollbarState()).toEqual(position);
  } finally { source.dispose(); restored.dispose(); }
});
