import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompiledMcpLane } from './package-mcp-lane.mjs';

test('compiled MCP fixture uses actual HTTP and retains invalid calls as failures', async () => {
  const lane = await createCompiledMcpLane();
  const request = async (id, method, params) => {
    const response = await fetch(lane.configuration.compiled.url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    return { status: response.status, body: await response.json() };
  };
  try {
    assert.equal((await request(1, 'initialize', { protocolVersion: '2025-03-26' })).body.result.serverInfo.name, 'compiled-owned-mcp');
    assert.equal((await request(2, 'tools/list', {})).body.result.tools[0].name, 'lookup');
    assert.equal((await request(3, 'tools/call', { name: 'lookup', arguments: { value: 'compiled-location-one' } })).body.result.isError, false);
    assert.equal((await request(4, 'tools/call', { name: 'foreign', arguments: { value: 'compiled-location-two' } })).status, 500);
    assert.throws(lane.check, /foreign/);
  } finally { await assert.rejects(lane.close(), /foreign/); }
});
