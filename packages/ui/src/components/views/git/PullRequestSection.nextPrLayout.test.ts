import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('./PullRequestSection.tsx', import.meta.url)),
  'utf8',
);

describe('PullRequestSection next pull request layout', () => {
  test('places the back action above the next pull request heading', () => {
    const backActionIndex = source.indexOf("t('gitView.pr.actions.cancelNextPr')");
    const nextPrHeadingIndex = source.indexOf("t('gitView.pr.createNextTitle')");

    expect(backActionIndex).toBeGreaterThan(-1);
    expect(nextPrHeadingIndex).toBeGreaterThan(backActionIndex);
  });

  test('returns to the merged pull request from the back action', () => {
    expect(source).toContain(
      '<Button variant="ghost" size="sm" onClick={() => setNextPrFromTerminalNumber(null)}>',
    );
  });

  test('shows the repository shortcut only for the ordinary create form', () => {
    expect(source).toContain('{!isStartingNextPr && repoUrl ? (');
  });
});
