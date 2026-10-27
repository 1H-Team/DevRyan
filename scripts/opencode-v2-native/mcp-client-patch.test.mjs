import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { repositoryRoot } from './artifacts.mjs';

// The copy of @modelcontextprotocol/client that @opencode/core (and so the native
// bundle) resolves, loaded through its ESM entry as Bun.build does. The root
// `patchedDependencies` entry ports OpenCode's patches/@modelcontextprotocol%2Fclient@2.3.1.patch.
const core = await fs.realpath(path.join(repositoryRoot, 'node_modules/@opencode/core'));
const commonEntry = createRequire(path.join(core, 'package.json')).resolve('@modelcontextprotocol/client');
const packageRoot = path.dirname(path.dirname(commonEntry));
const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
const { Client, InMemoryTransport, discoverOAuthProtectedResourceMetadata, startAuthorization } =
  await import(pathToFileURL(path.join(packageRoot, manifest.exports['.'].import.default)).href);

const unionTool = {
  name: 'lookup',
  description: 'Returns a record or an error envelope',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  outputSchema: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    anyOf: [
      { type: 'object', properties: { record: { type: 'string' } }, required: ['record'] },
      { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] },
    ],
  },
};
const plainTool = { name: 'ping', inputSchema: { type: 'object' } };

test('the native runtime resolves @modelcontextprotocol/client 2.3.1', () => {
  assert.equal(manifest.name, '@modelcontextprotocol/client');
  assert.equal(manifest.version, '2.3.1');
});

test('an anyOf tool output schema keeps the whole MCP tool list', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  serverTransport.onmessage = message => {
    if (!('id' in message) || !('method' in message)) return;
    const reply = result => void serverTransport.send({ jsonrpc: '2.0', id: message.id, result });
    if (message.method === 'initialize') {
      reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'union-stub', version: '1.0.0' } });
    } else if (message.method === 'tools/list') {
      reply({ tools: [unionTool, plainTool] });
    } else {
      void serverTransport.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Unhandled ${message.method}` } });
    }
  };
  await serverTransport.start();
  const client = new Client({ name: 'devryan-patch-test', version: '1.0.0' });
  try {
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ['lookup', 'ping']);
    assert.deepEqual(tools[0].outputSchema, unionTool.outputSchema);
  } finally {
    await client.close();
  }
});

test('OAuth discovery drops the server query and offline_access does not force consent', async () => {
  const requested = [];
  const fetchFn = async url => {
    requested.push(String(url));
    return new Response(JSON.stringify({ resource: 'https://mcp.example/mcp', authorization_servers: ['https://auth.example'] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await discoverOAuthProtectedResourceMetadata('https://mcp.example/mcp?tenant=acme', undefined, fetchFn);
  assert.deepEqual(requested, ['https://mcp.example/.well-known/oauth-protected-resource/mcp']);

  const { authorizationUrl } = await startAuthorization('https://auth.example', {
    metadata: {
      issuer: 'https://auth.example', authorization_endpoint: 'https://auth.example/authorize', token_endpoint: 'https://auth.example/token',
      response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
    },
    clientInformation: { client_id: 'devryan' },
    redirectUrl: 'http://127.0.0.1:19876/callback',
    scope: 'openid offline_access',
  });
  assert.equal(authorizationUrl.searchParams.get('scope'), 'openid offline_access');
  assert.equal(authorizationUrl.searchParams.has('prompt'), false);
});
