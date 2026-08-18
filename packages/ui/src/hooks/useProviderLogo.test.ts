import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'bun:test';

const currentDir = dirname(fileURLToPath(import.meta.url));

describe('provider logo aliases', () => {
  test('maps every Claude-compatible provider id to the local Claude logo asset', () => {
    const source = readFileSync(resolve(currentDir, 'useProviderLogo.ts'), 'utf8');

    expect(source).toContain("['anthropic', 'claude']");
    expect(source).toContain("['claude', 'claude']");
    expect(source).toContain("['anthropic-oauth', 'claude']");
    expect(source).toContain("['opencode-with-claude', 'claude']");
    expect(source).not.toContain("['claude', 'anthropic']");
    expect(existsSync(resolve(currentDir, '../assets/provider-logos/claude.svg'))).toBe(true);
  });

  test('maps OpenCode Go to the OpenCode logo asset', () => {
    const source = readFileSync(resolve(currentDir, 'useProviderLogo.ts'), 'utf8');

    expect(source).toContain("['opencode-go', 'opencode']");
    expect(source).not.toContain("['opencode-go', 'gocode']");
    expect(existsSync(resolve(currentDir, '../assets/provider-logos/opencode.svg'))).toBe(true);
  });
});
