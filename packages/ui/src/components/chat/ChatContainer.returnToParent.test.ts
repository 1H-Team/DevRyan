import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('ChatContainer return-to-parent action', () => {
  test('preserves the capitalized Parent label from the translation', () => {
    const source = readFileSync(fileURLToPath(new URL('./ChatContainer.tsx', import.meta.url)), 'utf8');

    expect(source).toContain('chat.container.returnToParent.label');
    expect(source).toContain('normal-case');
  });
});
