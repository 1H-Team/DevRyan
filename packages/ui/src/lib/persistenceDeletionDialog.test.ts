import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('desktop deletion-dialog preference hydration', () => {
  test('applies the sanitized saved preference to the UI store', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'persistence.ts'), 'utf8');

    expect(source).toContain("typeof settings.showDeletionDialog === 'boolean'");
    expect(source).toContain('settings.showDeletionDialog !== store.showDeletionDialog');
    expect(source).toContain('store.setShowDeletionDialog(settings.showDeletionDialog)');
  });
});
