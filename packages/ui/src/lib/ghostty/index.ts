import { loadGhosttyRuntime, type GhosttyRuntime } from './runtime';
import { GhosttyTerminalSurface } from './surface';
import { type GhosttyColor, type GhosttyTheme } from './core';
import type { TerminalTheme } from '../terminalTheme';
import './terminal.css';
import { terminalBuffer } from './buffer';
import { openExternalUrl } from '../url';

type Disposable = { dispose(): void };
type Addon = Disposable & { activate(terminal: Terminal): void };
export type TerminalOptions = {
  ghostty: Ghostty; theme: TerminalTheme; fontFamily?: string; fontSize?: number; lineHeight?: number;
  cursorBlink?: boolean; cursorStyle?: 'bar' | 'block' | 'underline'; scrollback?: number;
  disableStdin?: boolean; allowTransparency?: boolean; handleTouchPointer?: boolean;
  labels?: { input: string; scrollbar: string; output?: string };
  onLinkActivate?: (url: string, event: MouseEvent) => void;
};

export class Ghostty {
  private constructor(readonly runtime: GhosttyRuntime) {}
  static async load() { return new Ghostty(await loadGhosttyRuntime()); }
}

function themeColor(value: string): GhosttyColor {
  const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas 2D is unavailable');
  context.fillStyle = value; context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return { r, g, b };
}
function convertTheme(theme: TerminalTheme): GhosttyTheme {
  return { foreground: themeColor(theme.foreground), background: themeColor(theme.background),
    cursor: themeColor(theme.cursor), selectionBackground: theme.selectionBackground,
    palette: [theme.black, theme.red, theme.green, theme.yellow, theme.blue, theme.magenta, theme.cyan, theme.white,
      theme.brightBlack, theme.brightRed, theme.brightGreen, theme.brightYellow, theme.brightBlue, theme.brightMagenta,
      theme.brightCyan, theme.brightWhite].map(themeColor) };
}

/** Compatibility boundary for DevRyan's viewport and addons. Transport, PTY
 * authentication, output queues and session ownership remain in their owners. */
export class Terminal {
  private surface?: GhosttyTerminalSurface;
  private disposed = false;
  private readonly addons: Addon[] = [];
  private readonly data = new Set<(value: string) => void>();
  private readonly scroll = new Set<(value: number) => void>();
  private readonly selection = new Set<() => void>();
  private readonly size = new Set<(size: { cols: number; rows: number }) => void>();
  private readonly pending: Array<{ data: string; done?: () => void; replay?: boolean }> = [];
  constructor(readonly options: TerminalOptions) {}
  get cols() { return this.surface?.cols ?? 80; }
  get rows() { return this.surface?.rows ?? 24; }
  get textarea() { return this.surface?.input ?? null; }
  private listen<T>(listeners: Set<T>, listener: T): Disposable {
    listeners.add(listener); return { dispose: () => { listeners.delete(listener); } };
  }
  onData(listener: (data: string) => void) { return this.listen(this.data, listener); }
  onScroll(listener: (distance: number) => void) { return this.listen(this.scroll, listener); }
  onSelectionChange(listener: () => void) { return this.listen(this.selection, listener); }
  onResize(listener: (size: { cols: number; rows: number }) => void) { return this.listen(this.size, listener); }
  loadAddon(addon: Addon) { this.addons.push(addon); addon.activate(this); }
  async open(mount: HTMLElement) {
    if (this.disposed || this.surface) return;
    const surface = await GhosttyTerminalSurface.create(mount, {
      theme: convertTheme(this.options.theme), font: { family: this.options.fontFamily, size: this.options.fontSize },
      lineHeight: this.options.lineHeight,
      labels: this.options.labels ?? { input: 'Terminal input', scrollbar: 'Terminal scrollback' },
      handleTouchPointer: this.options.handleTouchPointer,
      onLinkActivate: this.options.onLinkActivate ?? ((url) => { void openExternalUrl(url); }),
      onData: (value) => { if (!this.options.disableStdin) for (const listener of this.data) listener(value); },
      onScroll: (value) => { for (const listener of this.scroll) listener(value); },
      onSelectionChange: () => { for (const listener of this.selection) listener(); },
      onResize: (cols, rows) => { for (const listener of this.size) listener({ cols, rows }); },
    });
    if (this.disposed) { surface.dispose(); return; }
    this.surface = surface;
    surface.setCursorBlink(this.options.cursorBlink === true);
    surface.setCursorStyle(this.options.cursorStyle ?? 'bar');
    for (const value of this.pending.splice(0)) this.write(value.data, value.done, value.replay);
  }
  write(data: string, done?: () => void, replay = false) {
    if (this.disposed) { done?.(); return; }
    if (!this.surface) { this.pending.push({ data, done, replay }); return; }
    this.surface.write(data, replay); done?.();
  }
  reset() { this.pending.length = 0; this.surface?.resetAndWrite(''); }
  resetAndWrite(data: string) { this.pending.length = 0; this.surface?.resetAndWrite(data); }
  focus() { this.surface?.focus(); }
  fit() { this.surface?.fit(); }
  setVisible(value: boolean) { this.surface?.setVisible(value); }
  getSelection() { return this.surface?.getSelection() ?? ''; }
  hasSelection() { return this.surface?.hasSelection() ?? false; }
  clearSelection() { this.surface?.clearSelection(); }
  scrollLines(rows: number) { this.surface?.scrollLines(rows); }
  scrollToBottom() { this.surface?.scrollToBottom(); }
  getViewportY() { return this.surface?.getViewportY() ?? 0; }
  hasBracketedPaste() { return this.surface?.hasBracketedPaste() ?? false; }
  setOption(key: 'cursorBlink', value: boolean) { this.options[key] = value; this.surface?.setCursorBlink(value); }
  get buffer() {
    const source = this.surface?.readBuffer();
    return terminalBuffer(source);
  }
  dispose() {
    if (this.disposed) return; this.disposed = true;
    this.surface?.dispose(); this.surface = undefined;
    for (const addon of this.addons) addon.dispose();
    this.pending.length = 0; this.data.clear(); this.scroll.clear(); this.selection.clear(); this.size.clear();
  }
}

export class FitAddon implements Addon {
  private terminal?: Terminal;
  activate(terminal: Terminal) { this.terminal = terminal; }
  fit() { this.terminal?.fit(); }
  observeResize() { this.fit(); } // The surface owns the ResizeObserver.
  dispose() { this.terminal = undefined; }
}
