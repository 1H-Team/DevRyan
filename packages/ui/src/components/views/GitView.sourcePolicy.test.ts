import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const source = readFileSync(new URL('./GitView.tsx', import.meta.url), 'utf8');

describe('GitView Source policy presentation', () => {
  test('omits Update and falls back from a previously selected hidden tab', () => {
    expect(source).toContain('const hideUpdateTab = isSourceUpdateTabHidden(principal);');
    expect(source).toContain("...(!hideUpdateTab ? [{ id: 'branch'");
    expect(source).toContain("hideUpdateTab && actionTab === 'branch' ? 'commit' : actionTab");
    expect(source).toContain("visibleActionTab === 'branch'");
  });
});
