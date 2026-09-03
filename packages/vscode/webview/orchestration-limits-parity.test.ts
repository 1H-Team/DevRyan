import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

describe('VS Code orchestration limits parity', () => {
  test('maps GET and PUT requests for /api/config/orchestration-limits to dedicated bridge operations', () => {
    const source = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');

    expect(source).toContain("pathname === '/api/config/orchestration-limits' && (method === 'GET' || method === 'PUT')");
    expect(source).toContain("'api:config/orchestration-limits:get'");
    expect(source).toContain("'api:config/orchestration-limits:set', body");
    // The bridge's `{ status, body }` envelope is forwarded unchanged so a 400 on
    // invalid input reaches the settings page the same way it does on the web host.
    const block = source.slice(
      source.indexOf("pathname === '/api/config/orchestration-limits'"),
      source.indexOf("pathname === '/api/config/agent-overrides'"),
    );
    expect(block).toContain('status: result.status');
    expect(block).toContain('JSON.stringify(result.body)');
    expect(block).toContain('status: 500');
  });
});
