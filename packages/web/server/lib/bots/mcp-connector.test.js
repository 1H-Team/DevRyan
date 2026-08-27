import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { encryptBotJson } from './encryption.js';
import {
  BOT_MCP_DEPLOYMENT_KEY_ID,
  botMcpDescriptorAssociatedData,
  createBotMcpConnectorHost,
  digestBotMcpDescriptor,
  digestBotMcpManifest,
  normalizeBotMcpCandidate,
  normalizeBotMcpToolManifest,
} from './mcp-connector.js';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const REVISION_ID = 'c0000000-0000-4000-8000-000000000001';
const BINDING_ID = 'd0000000-0000-4000-8000-000000000001';
const CREDENTIAL_ID = 'e0000000-0000-4000-8000-000000000001';
const OWNER_ID = 'a0000000-0000-4000-8000-000000000001';
const OTHER_OWNER_ID = 'a0000000-0000-4000-8000-000000000002';
const KEY = Buffer.alloc(32, 9);

const RAW_TOOLS = [{
  name: 'read-item',
  description: 'Read one item',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  annotations: { readOnlyHint: true },
}, {
  name: 'write-item',
  description: 'Change one item',
  inputSchema: { type: 'object' },
  annotations: { readOnlyHint: false },
}];

const createRepository = (rows) => ({
  get: vi.fn(async (filters) => rows.find((row) => (
    Object.entries(filters).every(([key, value]) => row[key] === value)
  )) || null),
  list: vi.fn(async ({ filters = {} } = {}) => ({
    items: rows.filter((row) => Object.entries(filters).every(([key, value]) => row[key] === value)),
    nextCursor: null,
  })),
});

const createInjectedHarness = (hostOptions = {}) => {
  const candidate = normalizeBotMcpCandidate({
    name: 'Inventory',
    type: 'local',
    command: ['/usr/bin/env', 'node', 'inventory.mjs'],
    environment: { INVENTORY_TOKEN: 'secret-token' },
    timeout: 5_000,
  });
  const manifest = normalizeBotMcpToolManifest(RAW_TOOLS);
  const binding = {
    id: BINDING_ID,
    bot_id: BOT_ID,
    server_name: candidate.serverName,
    transport: candidate.transport,
    display_metadata: { credentialRequired: true, toolCount: manifest.length },
    descriptor_envelope: encryptBotJson({
      key: KEY,
      keyId: BOT_MCP_DEPLOYMENT_KEY_ID,
      value: candidate.descriptor,
      associatedData: botMcpDescriptorAssociatedData(BINDING_ID),
    }),
    descriptor_digest: digestBotMcpDescriptor(candidate.descriptor),
    tool_manifest: manifest,
    manifest_digest: digestBotMcpManifest(manifest),
    credential_provider: `mcp.${BINDING_ID}`,
    credential_kind: 'mcp-transport',
  };
  const revision = {
    id: REVISION_ID,
    bot_id: BOT_ID,
    contract: {
      mcpBindings: [{
        id: BINDING_ID,
        descriptorDigest: binding.descriptor_digest,
        manifestDigest: binding.manifest_digest,
      }],
    },
  };
  const credential = {
    id: CREDENTIAL_ID,
    bot_id: BOT_ID,
    provider: binding.credential_provider,
    kind: binding.credential_kind,
    credential_scope: 'user',
    owner_user_id: OWNER_ID,
    status: 'active',
    revoked_at: null,
  };
  let liveTools = RAW_TOOLS;
  let result = { content: [{ type: 'text', text: 'ok' }] };
  let callError = null;
  let secretVersion = 1;
  const clients = [];
  const connectClient = vi.fn(async (_descriptor, secret) => {
    const client = {
      secret: structuredClone(secret),
      listTools: vi.fn(async () => ({ tools: liveTools })),
      callTool: vi.fn(async () => {
        if (callError) throw callError;
        return result;
      }),
      close: vi.fn(async () => undefined),
    };
    clients.push(client);
    return client;
  });
  const vault = {
    read: vi.fn(async () => ({
      credential: {
        id: CREDENTIAL_ID,
        botId: BOT_ID,
        provider: binding.credential_provider,
        kind: binding.credential_kind,
        credentialScope: 'user',
        ownerUserId: OWNER_ID,
        secretVersion,
      },
      secret: { environment: { INVENTORY_TOKEN: 'secret-token' }, headers: {} },
    })),
  };
  const host = createBotMcpConnectorHost({
    store: {
      repositories: {
        bot_mcp_bindings: createRepository([binding]),
        bot_revisions: createRepository([revision]),
        bot_credentials: createRepository([credential]),
      },
    },
    encryption: { getKey: async () => Buffer.from(KEY) },
    getCredentialVault: () => vault,
    connectClient,
    ...hostOptions,
  });
  return {
    binding,
    candidate,
    clients,
    connectClient,
    credential,
    host,
    setCallError: (value) => { callError = value; },
    setLiveTools: (value) => { liveTools = value; },
    setResult: (value) => { result = value; },
    setSecretVersion: (value) => { secretVersion = value; },
    vault,
  };
};

const createProtocolServer = () => {
  const server = new Server(
    { name: 'DevRyan MCP test fixture', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: RAW_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: 'text', text: 'fixture response' }],
  }));
  return server;
};

describe('Bot MCP connector host', () => {
  it('separates transport secrets and treats only explicit read-only annotations as reads', () => {
    const candidate = normalizeBotMcpCandidate({
      name: 'Remote inventory',
      type: 'remote',
      url: 'https://inventory.example/mcp',
      headers: { Authorization: 'Bearer secret' },
    });
    expect(JSON.stringify(candidate.descriptor)).not.toContain('Bearer secret');
    expect(candidate.secret.headers).toEqual({ Authorization: 'Bearer secret' });
    const manifest = normalizeBotMcpToolManifest(RAW_TOOLS);
    expect(manifest.find((tool) => tool.name === 'read-item')?.operationKind).toBe('read');
    expect(manifest.find((tool) => tool.name === 'write-item')?.operationKind).toBe('write');
    expect(() => normalizeBotMcpCandidate({
      name: 'Unsafe remote',
      type: 'remote',
      url: 'http://inventory.example/mcp',
    })).toThrow(expect.objectContaining({ code: 'bot_mcp_invalid' }));
  });

  it('resolves personalized credentials from the channel owner and returns non-exactly-once receipts', async () => {
    const harness = createInjectedHarness();
    const validated = await harness.host.connector.validate({
      botId: BOT_ID,
      revisionId: REVISION_ID,
      action: 'read-item',
      args: { id: 'one' },
      target: { bindingId: BINDING_ID },
      channelOwnerUserId: OWNER_ID,
      credentialId: null,
    });
    expect(validated).toMatchObject({ operationKind: 'read', credentialId: CREDENTIAL_ID });
    await expect(harness.host.describeBinding({
      botId: BOT_ID,
      revisionId: REVISION_ID,
      bindingId: BINDING_ID,
    })).resolves.toMatchObject({
      bindingId: BINDING_ID,
      serverName: 'Inventory',
      tools: expect.arrayContaining([expect.objectContaining({ name: 'read-item' })]),
    });
    await expect(harness.host.connector.validate({
      botId: BOT_ID,
      revisionId: REVISION_ID,
      action: 'read-item',
      args: {},
      target: { bindingId: BINDING_ID },
      channelOwnerUserId: OTHER_OWNER_ID,
      credentialId: null,
    })).rejects.toMatchObject({ code: 'bot_mcp_credential_required', statusCode: 409 });

    const execution = await harness.host.connector.execute({
      action: 'read-item',
      args: { id: 'one' },
      target: { bindingId: BINDING_ID },
      credentialId: CREDENTIAL_ID,
    });
    expect(execution.connectorReceipt).toEqual({
      nativeExactlyOnce: false,
      writeGuarantee: 'read_response',
    });
    expect(harness.connectClient).toHaveBeenCalledWith(
      expect.objectContaining({ transport: 'stdio' }),
      { environment: { INVENTORY_TOKEN: 'secret-token' }, headers: {} },
    );

    const write = await harness.host.connector.execute({
      action: 'write-item',
      args: {},
      target: { bindingId: BINDING_ID },
      credentialId: CREDENTIAL_ID,
    });
    expect(write.connectorReceipt.writeGuarantee).toBe('non_exactly_once');
    await harness.host.shutdown();
    expect(harness.clients[0].close).toHaveBeenCalled();
  });

  it('fails closed on manifest drift, oversized responses, and uncertain writes', async () => {
    const drift = createInjectedHarness();
    drift.setLiveTools([...RAW_TOOLS, {
      name: 'new-tool',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true },
    }]);
    await expect(drift.host.connector.execute({
      action: 'write-item',
      args: {},
      target: { bindingId: BINDING_ID },
      credentialId: CREDENTIAL_ID,
    })).rejects.toMatchObject({ code: 'bot_mcp_manifest_drift', statusCode: 409 });
    await drift.host.shutdown();

    const oversized = createInjectedHarness();
    oversized.setResult({ content: [{ type: 'text', text: 'x'.repeat(193 * 1024) }] });
    await expect(oversized.host.connector.execute({
      action: 'read-item',
      args: {},
      target: { bindingId: BINDING_ID },
      credentialId: CREDENTIAL_ID,
    })).rejects.toMatchObject({ code: 'bot_mcp_result_too_large', statusCode: 502 });
    await oversized.host.shutdown();

    const uncertain = createInjectedHarness();
    uncertain.setCallError(Object.assign(new Error('socket closed during write'), { code: 'ECONNRESET' }));
    await expect(uncertain.host.connector.execute({
      action: 'write-item',
      args: {},
      target: { bindingId: BINDING_ID },
      credentialId: CREDENTIAL_ID,
    })).rejects.toMatchObject({ transportUncertain: true });
    await uncertain.host.shutdown();
  });

  it('expires idle clients so local processes and remote sessions have a bounded lifetime', async () => {
    vi.useFakeTimers();
    try {
      const harness = createInjectedHarness({ clientIdleTtlMs: 120_000 });
      await harness.host.connector.execute({
        action: 'read-item',
        args: {},
        target: { bindingId: BINDING_ID },
        credentialId: CREDENTIAL_ID,
      });
      expect(harness.clients[0].close).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(120_000);

      expect(harness.clients[0].close).toHaveBeenCalledTimes(1);
      await harness.host.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never exceeds the client limit while another credential-scoped client is active', async () => {
    const harness = createInjectedHarness({ maxClients: 1 });
    let finishCall;
    harness.setResult(new Promise((resolve) => { finishCall = resolve; }));
    const first = harness.host.connector.execute({
      action: 'read-item',
      args: {},
      target: { bindingId: BINDING_ID },
      credentialId: CREDENTIAL_ID,
    });
    await vi.waitFor(() => expect(harness.clients[0]?.callTool).toHaveBeenCalledTimes(1));
    harness.setSecretVersion(2);

    await expect(harness.host.connector.execute({
      action: 'read-item',
      args: {},
      target: { bindingId: BINDING_ID },
      credentialId: CREDENTIAL_ID,
    })).rejects.toMatchObject({ code: 'bot_mcp_client_limit', statusCode: 503 });
    expect(harness.clients).toHaveLength(1);
    expect(harness.clients[0].close).not.toHaveBeenCalled();

    finishCall({ content: [{ type: 'text', text: 'finished' }] });
    await first;
    harness.setResult({ content: [{ type: 'text', text: 'next' }] });
    await harness.host.connector.execute({
      action: 'read-item',
      args: {},
      target: { bindingId: BINDING_ID },
      credentialId: CREDENTIAL_ID,
    });
    expect(harness.clients).toHaveLength(2);
    expect(harness.clients[0].close).toHaveBeenCalledTimes(1);
    await harness.host.shutdown();
  });

  it('preflights a real local stdio MCP fixture and closes its process', async () => {
    const serverModule = fileURLToPath(new URL(
      '../../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js',
      import.meta.url,
    ));
    const stdioModule = fileURLToPath(new URL(
      '../../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js',
      import.meta.url,
    ));
    const typesModule = fileURLToPath(new URL(
      '../../../node_modules/@modelcontextprotocol/sdk/dist/esm/types.js',
      import.meta.url,
    ));
    const script = [
      `import { Server } from ${JSON.stringify(serverModule)};`,
      `import { StdioServerTransport } from ${JSON.stringify(stdioModule)};`,
      `import { ListToolsRequestSchema } from ${JSON.stringify(typesModule)};`,
      "const server = new Server({name:'stdio-fixture',version:'1.0.0'},{capabilities:{tools:{}}});",
      `server.setRequestHandler(ListToolsRequestSchema, async () => ({tools:${JSON.stringify(RAW_TOOLS)}}));`,
      'await server.connect(new StdioServerTransport());',
    ].join('\n');
    const host = createBotMcpConnectorHost({
      store: {
        repositories: {
          bot_mcp_bindings: createRepository([]),
          bot_revisions: createRepository([]),
          bot_credentials: createRepository([]),
        },
      },
      encryption: { getKey: async () => Buffer.from(KEY) },
    });
    const candidate = normalizeBotMcpCandidate({
      name: 'Local fixture',
      type: 'local',
      command: [process.execPath, '--input-type=module', '-e', script],
      timeout: 10_000,
    });
    await expect(host.preflight({ descriptor: candidate.descriptor, secret: candidate.secret }))
      .resolves.toMatchObject({ manifest: expect.arrayContaining([expect.objectContaining({ name: 'read-item' })]) });
    await host.shutdown();
  }, 20_000);

  it('preflights a real remote Streamable HTTP MCP fixture', async () => {
    const app = express();
    app.use(express.json());
    app.post('/mcp', async (req, res) => {
      const server = createProtocolServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });
    app.get('/mcp', (_req, res) => res.status(405).end());
    app.delete('/mcp', (_req, res) => res.status(405).end());
    const listener = await new Promise((resolve) => {
      const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
    try {
      const address = listener.address();
      const host = createBotMcpConnectorHost({
        store: {
          repositories: {
            bot_mcp_bindings: createRepository([]),
            bot_revisions: createRepository([]),
            bot_credentials: createRepository([]),
          },
        },
        encryption: { getKey: async () => Buffer.from(KEY) },
      });
      const candidate = normalizeBotMcpCandidate({
        name: 'Remote fixture',
        type: 'remote',
        url: `http://127.0.0.1:${address.port}/mcp`,
        timeout: 10_000,
      });
      await expect(host.preflight({ descriptor: candidate.descriptor, secret: candidate.secret }))
        .resolves.toMatchObject({ manifest: expect.arrayContaining([expect.objectContaining({ name: 'write-item' })]) });
      await host.shutdown();
    } finally {
      await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    }
  }, 20_000);

  it('falls back to a credentialed legacy SSE MCP fixture', async () => {
    const app = express();
    app.use(express.json());
    const sessions = new Map();
    const authorized = (req) => req.headers.authorization === 'Bearer fixture-secret';
    app.get('/sse', async (req, res) => {
      if (!authorized(req)) {
        res.status(401).end();
        return;
      }
      const server = createProtocolServer();
      const transport = new SSEServerTransport('/messages', res);
      sessions.set(transport.sessionId, { server, transport });
      res.on('close', () => sessions.delete(transport.sessionId));
      await server.connect(transport);
    });
    app.post('/messages', async (req, res) => {
      if (!authorized(req)) {
        res.status(401).end();
        return;
      }
      const session = sessions.get(String(req.query.sessionId || ''));
      if (!session) {
        res.status(404).end();
        return;
      }
      await session.transport.handlePostMessage(req, res, req.body);
    });
    const listener = await new Promise((resolve) => {
      const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
    try {
      const address = listener.address();
      const host = createBotMcpConnectorHost({
        store: {
          repositories: {
            bot_mcp_bindings: createRepository([]),
            bot_revisions: createRepository([]),
            bot_credentials: createRepository([]),
          },
        },
        encryption: { getKey: async () => Buffer.from(KEY) },
      });
      const candidate = normalizeBotMcpCandidate({
        name: 'Legacy SSE fixture',
        type: 'remote',
        url: `http://127.0.0.1:${address.port}/sse`,
        headers: { Authorization: 'Bearer fixture-secret' },
        timeout: 10_000,
      });
      await expect(host.preflight({ descriptor: candidate.descriptor, secret: candidate.secret }))
        .resolves.toMatchObject({
          manifest: expect.arrayContaining([expect.objectContaining({ name: 'read-item' })]),
        });
      await host.shutdown();
    } finally {
      await Promise.all([...sessions.values()].map(async ({ transport, server }) => {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      }));
      await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    }
  }, 20_000);
});
