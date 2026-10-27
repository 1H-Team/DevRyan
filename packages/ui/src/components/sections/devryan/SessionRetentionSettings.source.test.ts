import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { settingsDict } from '@/lib/i18n/messages/en.settings';

const messages: Record<string, string> = settingsDict;

const source = readFileSync(new URL('./SessionRetentionSettings.tsx', import.meta.url), 'utf8');

describe('diagnostic data cleanup source contract', () => {
  test('offers bounded diagnostic clear ranges through one cleanup component', () => {
    expect(source).toContain('const DiagnosticDataCleanup');
    expect(source).toContain('<DiagnosticDataCleanup />');
    expect(source).not.toContain('DiagnosticJournalCleanup');
    expect(source).not.toContain('ApplicationCacheCleanup');
    expect(source).toContain("{ value: '24h'");
    expect(source).toContain("{ value: '7d'");
    expect(source).toContain("{ value: '14d'");
    expect(source).toContain("{ value: 'all'");
    expect(source).toContain('diagnostics.clear(clearRange)');
  });

  test('removes the separate application-cache message namespace', () => {
    expect(Object.keys(messages).filter((key) => key.includes('sessionRetention.applicationCache'))).toEqual([]);
    expect(messages['settings.devryan.about.diagnostics.clearDialog.descriptionDesktop']).toBeTruthy();
    expect(messages['settings.devryan.about.diagnostics.health']).toBe('{sessions} sessions · {size}');
  });
});
