import { afterEach, describe, expect, test } from 'bun:test';

import {
  eventMatchesShortcut,
  findShortcutConflict,
  getEffectiveShortcutCombo,
  migrateSendSelectionShortcutOverrides,
  UNASSIGNED_SHORTCUT,
} from './shortcuts';

const originalNavigator = globalThis.navigator;
const originalWindow = globalThis.window;

afterEach(() => {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
});

const keyboardEvent = (overrides: Partial<KeyboardEvent>): KeyboardEvent => ({
  key: 'l',
  code: 'KeyL',
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...overrides,
} as KeyboardEvent);

describe('selection shortcut defaults and migration', () => {
  test('assigns the new defaults when no explicit binding claimed mod+l', () => {
    const migrated = migrateSendSelectionShortcutOverrides({ open_settings: 'mod+comma' });
    expect(getEffectiveShortcutCombo('send_selection_to_input', migrated)).toBe('mod+l');
    expect(getEffectiveShortcutCombo('toggle_sidebar', migrated)).toBe('mod+alt+l');
    expect(migrated.open_settings).toBe('mod+comma');
  });

  test('preserves another action that explicitly claims mod+l', () => {
    const migrated = migrateSendSelectionShortcutOverrides({ open_command_palette: 'mod+l' });
    expect(migrated.open_command_palette).toBe('mod+l');
    expect(migrated.send_selection_to_input).toBe(UNASSIGNED_SHORTCUT);
    expect(getEffectiveShortcutCombo('send_selection_to_input', migrated)).toBe('');
  });

  test('preserves an explicit old-default sidebar binding', () => {
    const migrated = migrateSendSelectionShortcutOverrides({
      toggle_sidebar: 'mod+l',
      focus_input: 'alt+i',
    });
    expect(migrated.toggle_sidebar).toBe('mod+l');
    expect(migrated.focus_input).toBe('alt+i');
    expect(migrated.send_selection_to_input).toBe(UNASSIGNED_SHORTCUT);
  });

  test('detects conflicts against effective defaults', () => {
    expect(findShortcutConflict('send_selection_to_input', 'mod+alt+l', {})).toBe('toggle_sidebar');
    expect(findShortcutConflict('send_selection_to_input', 'mod+l', {})).toBeNull();
  });
});

describe('selection shortcut platform modifier', () => {
  test('matches Ctrl+L outside macOS', () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: 'Linux x86_64' },
    });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
    expect(eventMatchesShortcut(keyboardEvent({ ctrlKey: true }), 'mod+l')).toBe(true);
    expect(eventMatchesShortcut(keyboardEvent({ metaKey: true }), 'mod+l')).toBe(false);
  });

  test('matches Cmd+L in the macOS desktop shell', () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: 'Macintosh; Intel Mac OS X' },
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __TAURI__: { core: { invoke: () => undefined } } },
    });
    expect(eventMatchesShortcut(keyboardEvent({ metaKey: true }), 'mod+l')).toBe(true);
    expect(eventMatchesShortcut(keyboardEvent({ ctrlKey: true }), 'mod+l')).toBe(false);
  });
});
