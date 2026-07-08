import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'bun:test';

const currentDir = dirname(fileURLToPath(import.meta.url));

describe('provider logo aliases', () => {
  test('maps OpenCode Go to the OpenCode logo asset', () => {
    const source = readFileSync(resolve(currentDir, 'useProviderLogo.ts'), 'utf8');

    expect(source).toContain("['opencode-go', 'opencode']");
    expect(source).not.toContain("['opencode-go', 'gocode']");
    expect(existsSync(resolve(currentDir, '../assets/provider-logos/opencode.svg'))).toBe(true);
  });
});
