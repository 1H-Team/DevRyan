import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

describe('VS Code Claude prompt-mode parity', () => {
  test('maps GET and PUT requests to dedicated bridge operations', () => {
    const source = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');

    expect(source).toContain("pathname === '/api/provider/anthropic/prompt-mode'");
    expect(source).toContain("'api:provider/anthropic/prompt-mode:get'");
    expect(source).toContain("'api:provider/anthropic/prompt-mode:set', body");
    expect(source).toContain('status: result.status');
    expect(source).toContain('JSON.stringify(result.body)');
  });
});
