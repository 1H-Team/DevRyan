import { describe, expect, test } from 'bun:test';

import { devRyanStorageKey, migrateLegacyStorageKeys } from './legacyStorageMigration';

const memoryStorage = (entries: Record<string, string>): Storage => {
  const map = new Map(Object.entries(entries));
  return {
    get length() { return map.size; },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
    clear: () => map.clear(),
  };
};

describe('legacy browser storage keys', () => {
  test('copies openchamber-prefixed keys once and never overwrites a DevRyan key', () => {
    const storage = memoryStorage({
      'openchamber.pwaName': 'Old',
      'openchamber_chat_drafts': '{"a":1}',
      'openchamber:files:md-viewer-mode': 'preview',
      'openchamber-session-todos': '{}',
      'devryan.i18n.v1': 'fr',
      'openchamber.i18n.v1': 'de',
      'openchamberish': 'x',
      'other': 'y',
    });
    expect(migrateLegacyStorageKeys(storage)).toBe(4);
    expect(storage.getItem('devryan.pwaName')).toBe('Old');
    expect(storage.getItem('devryan_chat_drafts')).toBe('{"a":1}');
    expect(storage.getItem('devryan:files:md-viewer-mode')).toBe('preview');
    expect(storage.getItem('devryan-session-todos')).toBe('{}');
    expect(storage.getItem('devryan.i18n.v1')).toBe('fr');
    expect(storage.getItem('openchamber.pwaName')).toBe('Old');
    expect(storage.getItem('devryanish')).toBeNull();
    expect(migrateLegacyStorageKeys(storage)).toBe(0);
  });

  test('maps only the prefix', () => {
    expect(devRyanStorageKey('openchamber.conflict:ses_1')).toBe('devryan.conflict:ses_1');
    expect(devRyanStorageKey('session.status')).toBe('session.status');
  });
});
