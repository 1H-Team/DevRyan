import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('./PullRequestSection.tsx', import.meta.url)),
  'utf8',
);

describe('PullRequestSection fork repository routing', () => {
  test('passes the resolved repository through every PR context request', () => {
    const calls = source.match(/github\.prContext\(/g) ?? [];
    const routedOptions = source.match(/sourceRepo[,\n]/g) ?? [];

    expect(calls.length).toBe(5);
    expect(routedOptions.length >= calls.length).toBe(true);
  });

  test('includes repository identity in body hydration ownership', () => {
    expect(source).toContain('`${directory}#${sourceRepoKey}#${pr.number}`');
  });
});
