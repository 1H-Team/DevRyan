import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));

describe('SessionSidebar PR ownership boundary', () => {
  test('does not import or refresh GitHub PR status', () => {
    const source = readFileSync(join(testDirectory, '..', 'SessionSidebar.tsx'), 'utf8');

    expect(source).not.toContain('useGitHubPrStatusStore');
    expect(source).not.toContain('usePrVisualSummaryByKeys');
    expect(source).not.toContain('getGitHubPrStatusKey');
    expect(source).not.toContain('refreshPrStatusTargets');
  });
});
