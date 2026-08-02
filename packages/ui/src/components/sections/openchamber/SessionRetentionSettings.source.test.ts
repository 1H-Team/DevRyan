import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./SessionRetentionSettings.tsx', import.meta.url), 'utf8');
const messages = readFileSync(new URL('../../../lib/i18n/messages/en.settings.ts', import.meta.url), 'utf8');

describe('diagnostic data cleanup source contract', () => {
  test('uses one cleanup component and one clear-all action', () => {
    expect(source).toContain('const DiagnosticDataCleanup');
    expect(source).toContain('<DiagnosticDataCleanup />');
    expect(source).not.toContain('DiagnosticJournalCleanup');
    expect(source).not.toContain('ApplicationCacheCleanup');
    expect(source).toContain("settings.openchamber.about.diagnostics.clearAll");
  });

  test('removes the separate application-cache message namespace', () => {
    expect(messages).not.toContain('sessionRetention.applicationCache');
    expect(messages).toContain('diagnostics.clearDialog.descriptionDesktop');
    expect(messages).toContain('{sessions} sessions · {size}');
  });
});
