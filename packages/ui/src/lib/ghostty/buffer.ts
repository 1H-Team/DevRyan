import { GHOSTTY_CELL_WIDE, type GhosttyColor, type GhosttyTerminalCore } from './core';

/** A complete immutable view for serializers; reading restores the user's viewport. */
export function terminalBuffer(source?: ReturnType<GhosttyTerminalCore['readBuffer']>) {
  const encode = (color: GhosttyColor) => 0x1000000 + (color.r << 16) + (color.g << 8) + color.b;
    return { active: source ? { length: source.rows.length, baseY: source.baseY,
      cursorX: source.cursorX, cursorY: source.cursorY,
      getLine: (index: number) => {
        const row = source.rows[index]; if (!row) return undefined;
        return { length: row.cells.length, isWrapped: row.isWrapContinuation,
          getCell: (col: number) => {
            const cell = row.cells[col]; if (!cell) return undefined;
            return { getChars: () => cell.text, getCodepoint: () => cell.text.codePointAt(0) ?? 0,
              getWidth: () => cell.wide === GHOSTTY_CELL_WIDE.spacerTail ? 0 : cell.wide === GHOSTTY_CELL_WIDE.wide ? 2 : 1,
              getFgColor: () => encode(cell.foreground), getBgColor: () => encode(cell.background),
              isBold: () => cell.bold, isItalic: () => cell.italic, isUnderline: () => cell.underline,
              isInvisible: () => cell.invisible, isStrikethrough: () => cell.strikethrough };
          } };
      } } : undefined };
}
