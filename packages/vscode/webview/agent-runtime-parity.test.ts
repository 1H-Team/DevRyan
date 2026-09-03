import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

describe('VS Code agent runtime settings parity', () => {
  test('maps GET and PUT requests for /api/config/agent-runtime to dedicated bridge operations', () => {
    const source = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');

    expect(source).toContain("pathname === '/api/config/agent-runtime' && (method === 'GET' || method === 'PUT')");
    expect(source).toContain("'api:config/agent-runtime:get'");
    expect(source).toContain("'api:config/agent-runtime:set', body");
    // The bridge's `{ status, body }` envelope is forwarded unchanged so a 400 on
    // invalid input (and the `restartRequired` flag on a changed value) reach the
    // settings page the same way they do on the web host.
    const block = source.slice(
      source.indexOf("pathname === '/api/config/agent-runtime'"),
      source.indexOf("pathname === '/api/config/agent-overrides'"),
    );
    expect(block).toContain('status: result.status');
    expect(block).toContain('JSON.stringify(result.body)');
    expect(block).toContain('status: 500');
  });
});
