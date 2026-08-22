import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

describe('Claude compatibility provider setting', () => {
  test('renders the managed prompt-mode switch with persistent API wiring', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./ProvidersPage.tsx', import.meta.url)),
      'utf8',
    );

    expect(source).toContain('renderClaudeCompatibilityMode');
    expect(source).toContain('setClaudeCompatibilityMode(compatibilityMode)');
    expect(source).toContain('claudePromptMode?.compatibilityMode === true');
    expect(source).toContain('claudePromptMode.editable === false');
  });
});
