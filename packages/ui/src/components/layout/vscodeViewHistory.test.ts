import { describe, expect, test } from 'bun:test';
import { rememberViewBeforeSettings, resolveViewAfterSettings } from './vscodeViewHistory';

describe('VS Code settings view history', () => {
  test('remembers sessions or chat when settings first opens', () => {
    expect(rememberViewBeforeSettings('sessions', null)).toBe('sessions');
    expect(rememberViewBeforeSettings('chat', null)).toBe('chat');
  });

  test('does not overwrite the remembered view on repeated settings navigation', () => {
    expect(rememberViewBeforeSettings('settings', 'sessions')).toBe('sessions');
  });

  test('restores the remembered view and otherwise uses the layout fallback', () => {
    expect(resolveViewAfterSettings('chat', 'sessions')).toBe('chat');
    expect(resolveViewAfterSettings(null, 'sessions')).toBe('sessions');
  });
});
