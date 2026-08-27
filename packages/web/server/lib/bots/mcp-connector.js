import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { canonicalizeBotJson, hashCanonicalBotJson } from '@openchamber/bots-runtime';

import { decryptBotJson } from './encryption.js';
import {
  assertExactObject,
  validateBoundedJsonObject,
  validateBoundedString,
  validateOptionalUuid,
  validateUuid,
} from './validation.js';

const DEPLOYMENT_KEY_ID = 'deployment-v1';
const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const MAX_TOOLS = 256;
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_RESULT_BYTES = 192 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_CLIENTS = 8;
const DEFAULT_CLIENT_IDLE_TTL_MS = 5 * 60_000;

export class BotMcpConnectorError extends Error {
  constructor(message, code = 'bot_mcp_invalid', statusCode = 400) {
    super(message);
    this.name = 'BotMcpConnectorError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotMcpConnectorError(message, code, statusCode);
};

const isPlainObject = (value) => Boolean(
  value && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
);

const cloneJson = (value, label = 'MCP value') => {
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== 'string') fail(`${label} is invalid`);
    return JSON.parse(encoded);
  } catch (error) {
    if (error instanceof BotMcpConnectorError) throw error;
    fail(`${label} is invalid`);
  }
};

const stringRecord = (value, field, keyPattern) => {
  if (value === undefined) return Object.freeze({});
  if (!isPlainObject(value) || Object.keys(value).length > 64) fail(`${field} is invalid`);
  const output = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (!keyPattern.test(key) || typeof rawValue !== 'string'
      || rawValue.length > 16_384 || /[\u0000\r\n]/u.test(rawValue)) {
      fail(`${field} is invalid`);
    }
    output[key] = rawValue;
  }
  return Object.freeze(output);
};

const normalizeTimeout = (value) => {
  const timeout = value === undefined ? DEFAULT_TIMEOUT_MS : Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > MAX_TIMEOUT_MS) {
    fail('MCP timeout is invalid');
  }
  return timeout;
};

const normalizeRemoteUrl = (value) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('MCP server URL is invalid');
  }
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname.toLowerCase());
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.hash) {
    fail('Remote MCP servers require HTTPS, except for loopback development servers');
  }
  return url.toString();
};

export const botMcpDescriptorAssociatedData = (bindingId) => (
  `devryan:bot-mcp-binding:${validateUuid(bindingId, 'bindingId')}:v1`
);

export const normalizeBotMcpCandidate = (value) => {
  if (!isPlainObject(value)) fail('MCP server configuration is invalid');
  const type = value.type;
  const name = validateBoundedString(value.name, 'server.name', { maximum: 120 });
  const environment = stringRecord(value.environment, 'server.environment', ENVIRONMENT_NAME_PATTERN);
  const headers = stringRecord(value.headers, 'server.headers', HEADER_NAME_PATTERN);
  const timeout = normalizeTimeout(value.timeout);
  if (type === 'local') {
    assertExactObject(value, {
      label: 'Local MCP server',
      required: ['name', 'type', 'command'],
      optional: ['environment', 'timeout'],
    });
    if (!Array.isArray(value.command) || value.command.length < 1 || value.command.length > 64) {
      fail('Local MCP command is invalid');
    }
    const command = value.command.map((part, index) => validateBoundedString(
      part,
      `server.command[${index}]`,
      { maximum: 4_096 },
    ));
    return Object.freeze({
      serverName: name,
      transport: 'stdio',
      descriptor: Object.freeze({ version: 1, transport: 'stdio', command, environmentKeys: Object.keys(environment).sort(), timeout }),
      secret: Object.freeze({ environment: structuredClone(environment), headers: {} }),
      displayMetadata: Object.freeze({ serverName: name, transport: 'Local stdio' }),
      credentialRequired: Object.keys(environment).length > 0,
    });
  }
  if (type !== 'remote') fail('MCP server type is invalid');
  assertExactObject(value, {
    label: 'Remote MCP server',
    required: ['name', 'type', 'url'],
    optional: ['environment', 'headers', 'timeout'],
  });
  if (Object.keys(environment).length > 0) {
    fail('Remote MCP environment values are not supported');
  }
  return Object.freeze({
    serverName: name,
    transport: 'streamable_http',
    descriptor: Object.freeze({
      version: 1,
      transport: 'streamable_http',
      url: normalizeRemoteUrl(value.url),
      headerKeys: Object.keys(headers).sort(),
      timeout,
      legacySseFallback: true,
    }),
    secret: Object.freeze({ environment: {}, headers: structuredClone(headers) }),
    displayMetadata: Object.freeze({ serverName: name, transport: 'Remote HTTP' }),
    credentialRequired: Object.keys(headers).length > 0,
  });
};

const normalizeSchema = (value, field) => {
  const schema = value === undefined ? { type: 'object' } : cloneJson(value, field);
  if (!isPlainObject(schema) && typeof schema !== 'boolean') fail(`${field} is invalid`);
  if (Buffer.byteLength(JSON.stringify(schema), 'utf8') > 64 * 1024) fail(`${field} is too large`);
  return schema;
};

export const normalizeBotMcpToolManifest = (tools) => {
  if (!Array.isArray(tools) || tools.length > MAX_TOOLS) fail('MCP tool manifest is invalid');
  const names = new Set();
  const manifest = tools.map((tool, index) => {
    if (!isPlainObject(tool) || typeof tool.name !== 'string' || !TOOL_NAME_PATTERN.test(tool.name)
      || names.has(tool.name)) {
      fail(`MCP tool ${index} has an unsupported name`);
    }
    names.add(tool.name);
    const description = typeof tool.description === 'string'
      ? tool.description.replace(/[\u0000\r\n]+/gu, ' ').trim().slice(0, 1_000)
      : '';
    return Object.freeze({
      name: tool.name,
      description,
      inputSchema: normalizeSchema(tool.inputSchema, `MCP tool ${tool.name} input schema`),
      operationKind: tool.annotations?.readOnlyHint === true ? 'read' : 'write',
    });
  }).sort((left, right) => left.name.localeCompare(right.name));
  if (Buffer.byteLength(canonicalizeBotJson(manifest), 'utf8') > MAX_MANIFEST_BYTES) {
    fail('MCP tool manifest is too large', 'bot_mcp_manifest_too_large', 413);
  }
  return Object.freeze(manifest);
};

const normalizePinnedBotMcpManifest = (tools) => {
  if (!Array.isArray(tools) || tools.length > MAX_TOOLS) fail('Pinned MCP tool manifest is invalid');
  const names = new Set();
  const manifest = tools.map((tool, index) => {
    if (!isPlainObject(tool)
      || Object.keys(tool).sort().join('\0') !== ['description', 'inputSchema', 'name', 'operationKind'].join('\0')
      || typeof tool.name !== 'string' || !TOOL_NAME_PATTERN.test(tool.name)
      || names.has(tool.name) || typeof tool.description !== 'string'
      || tool.description.length > 1_000 || !['read', 'write'].includes(tool.operationKind)) {
      fail(`Pinned MCP tool ${index} is invalid`);
    }
    names.add(tool.name);
    return Object.freeze({
      name: tool.name,
      description: tool.description,
      inputSchema: normalizeSchema(tool.inputSchema, `Pinned MCP tool ${tool.name} input schema`),
      operationKind: tool.operationKind,
    });
  }).sort((left, right) => left.name.localeCompare(right.name));
  if (Buffer.byteLength(canonicalizeBotJson(manifest), 'utf8') > MAX_MANIFEST_BYTES) {
    fail('Pinned MCP tool manifest is too large', 'bot_mcp_manifest_too_large', 413);
  }
  return Object.freeze(manifest);
};

export const digestBotMcpManifest = (manifest) => hashCanonicalBotJson(manifest);
export const digestBotMcpDescriptor = (descriptor) => hashCanonicalBotJson(descriptor);

export const normalizePinnedBotMcpDescriptor = (value) => {
  if (!isPlainObject(value) || value.version !== 1) fail('Pinned MCP descriptor is invalid');
  if (value.transport === 'stdio') {
    assertExactObject(value, {
      label: 'Pinned local MCP descriptor',
      required: ['version', 'transport', 'command', 'environmentKeys', 'timeout'],
    });
    if (!Array.isArray(value.command) || value.command.length < 1 || value.command.length > 64
      || !Array.isArray(value.environmentKeys) || value.environmentKeys.length > 64) {
      fail('Pinned local MCP descriptor is invalid');
    }
    const command = value.command.map((part, index) => validateBoundedString(
      part,
      `descriptor.command[${index}]`,
      { maximum: 4_096 },
    ));
    const environmentKeys = value.environmentKeys.map((key) => {
      if (typeof key !== 'string' || !ENVIRONMENT_NAME_PATTERN.test(key)) {
        fail('Pinned MCP environment key is invalid');
      }
      return key;
    }).sort();
    if (new Set(environmentKeys).size !== environmentKeys.length) {
      fail('Pinned MCP environment keys are invalid');
    }
    return Object.freeze({
      version: 1,
      transport: 'stdio',
      command,
      environmentKeys,
      timeout: normalizeTimeout(value.timeout),
    });
  }
  if (value.transport !== 'streamable_http') fail('Pinned MCP transport is invalid');
  assertExactObject(value, {
    label: 'Pinned remote MCP descriptor',
    required: ['version', 'transport', 'url', 'headerKeys', 'timeout', 'legacySseFallback'],
  });
  if (!Array.isArray(value.headerKeys) || value.headerKeys.length > 64
    || value.legacySseFallback !== true) {
    fail('Pinned remote MCP descriptor is invalid');
  }
  const headerKeys = value.headerKeys.map((key) => {
    if (typeof key !== 'string' || !HEADER_NAME_PATTERN.test(key)) {
      fail('Pinned MCP header key is invalid');
    }
    return key;
  }).sort();
  if (new Set(headerKeys).size !== headerKeys.length) fail('Pinned MCP header keys are invalid');
  return Object.freeze({
    version: 1,
    transport: 'streamable_http',
    url: normalizeRemoteUrl(value.url),
    headerKeys,
    timeout: normalizeTimeout(value.timeout),
    legacySseFallback: true,
  });
};

const defaultConnectClient = async (descriptor, secret) => {
  const client = new Client({ name: 'DevRyan Bot MCP connector', version: '1.0.0' });
  const timeout = descriptor.timeout;
  const connect = async (transport) => {
    await client.connect(transport, { timeout });
    return Object.freeze({
      listTools: () => client.listTools(undefined, { timeout }),
      callTool: (input, signal) => client.callTool(input, undefined, { timeout, signal }),
      close: async () => client.close(),
    });
  };
  if (descriptor.transport === 'stdio') {
    const [command, ...args] = descriptor.command;
    return connect(new StdioClientTransport({
      command,
      args,
      env: structuredClone(secret.environment || {}),
      stderr: 'pipe',
    }));
  }
  const requestInit = { headers: structuredClone(secret.headers || {}) };
  try {
    return await connect(new StreamableHTTPClientTransport(new URL(descriptor.url), { requestInit }));
  } catch (streamableError) {
    await client.close().catch(() => undefined);
    if (descriptor.legacySseFallback !== true) throw streamableError;
    const fallbackClient = new Client({ name: 'DevRyan Bot MCP connector', version: '1.0.0' });
    const transport = new SSEClientTransport(new URL(descriptor.url), { requestInit });
    await fallbackClient.connect(transport, { timeout });
    return Object.freeze({
      listTools: () => fallbackClient.listTools(undefined, { timeout }),
      callTool: (input, signal) => fallbackClient.callTool(input, undefined, { timeout, signal }),
      close: async () => fallbackClient.close(),
    });
  }
};

const isTransportFailure = (error) => (
  error?.name === 'AbortError'
  || error?.code === 'ECONNRESET'
  || error?.code === 'ECONNREFUSED'
  || error?.code === 'EPIPE'
  || error?.code === 'ETIMEDOUT'
  || /(?:closed|connection|network|socket|stream|timed? out|transport)/i.test(error?.message || '')
);

const boundedResult = (value) => {
  const cloned = cloneJson(value ?? {}, 'MCP tool result');
  if (Buffer.byteLength(JSON.stringify(cloned), 'utf8') > MAX_RESULT_BYTES) {
    fail('MCP tool result is too large', 'bot_mcp_result_too_large', 502);
  }
  return cloned;
};

export function createBotMcpConnectorHost({
  store,
  encryption,
  getCredentialVault = () => null,
  connectClient = defaultConnectClient,
  maxClients = DEFAULT_MAX_CLIENTS,
  clientIdleTtlMs = DEFAULT_CLIENT_IDLE_TTL_MS,
} = {}) {
  if (!store?.repositories?.bot_mcp_bindings || !store?.repositories?.bot_revisions
    || !store?.repositories?.bot_credentials
    || typeof getCredentialVault !== 'function' || typeof connectClient !== 'function'
    || !Number.isSafeInteger(maxClients) || maxClients < 1 || maxClients > 32
    || !Number.isSafeInteger(clientIdleTtlMs)
    || clientIdleTtlMs < MAX_TIMEOUT_MS || clientIdleTtlMs > 60 * 60_000) {
    throw new TypeError('Bot MCP connector host is misconfigured');
  }

  const clients = new Map();
  let clientQueue = Promise.resolve();

  const withClientLock = async (operation) => {
    let release;
    const previous = clientQueue;
    clientQueue = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const clearClientTimer = (entry) => {
    if (entry?.idleTimer) clearTimeout(entry.idleTimer);
  };

  const armClientTimer = (key, entry) => {
    clearClientTimer(entry);
    if (entry.activeCalls > 0 || clients.get(key) !== entry) return;
    entry.idleTimer = setTimeout(() => {
      if (clients.get(key) !== entry || entry.activeCalls > 0) return;
      clients.delete(key);
      void entry.client.close().catch(() => undefined);
    }, clientIdleTtlMs);
    entry.idleTimer.unref?.();
  };

  const withKey = async (operation) => {
    if (typeof encryption?.getKey !== 'function') {
      fail('Bot encryption key is unavailable', 'bot_os_encryption_unavailable', 503);
    }
    const supplied = await encryption.getKey();
    const key = Buffer.from(supplied || []);
    try {
      if (key.byteLength !== 32) fail('Bot encryption key is unavailable', 'bot_os_encryption_unavailable', 503);
      return await operation(key);
    } finally {
      key.fill(0);
      if (Buffer.isBuffer(supplied) || supplied instanceof Uint8Array) supplied.fill(0);
    }
  };

  const decryptDescriptor = (binding) => withKey((key) => decryptBotJson({
    key,
    envelope: binding.descriptor_envelope,
    expectedKeyId: DEPLOYMENT_KEY_ID,
    associatedData: botMcpDescriptorAssociatedData(binding.id),
  }));

  const validatePinnedBinding = async (binding) => {
    const manifest = normalizePinnedBotMcpManifest(binding.tool_manifest);
    if (digestBotMcpManifest(manifest) !== binding.manifest_digest) {
      fail('The pinned MCP tool manifest failed integrity checks', 'bot_mcp_binding_integrity_failed', 409);
    }
    const descriptor = normalizePinnedBotMcpDescriptor(await decryptDescriptor(binding));
    if (digestBotMcpDescriptor(descriptor) !== binding.descriptor_digest) {
      fail('The pinned MCP descriptor failed integrity checks', 'bot_mcp_binding_integrity_failed', 409);
    }
    return { descriptor, manifest };
  };

  const loadBindingForRevision = async ({ botId, revisionId, bindingId }) => {
    const [binding, revision] = await Promise.all([
      store.repositories.bot_mcp_bindings.get({
        id: validateUuid(bindingId, 'bindingId'),
        bot_id: validateUuid(botId, 'botId'),
      }),
      store.repositories.bot_revisions.get({
        id: validateUuid(revisionId, 'revisionId'),
        bot_id: validateUuid(botId, 'botId'),
      }),
    ]);
    const reference = revision?.contract?.mcpBindings?.find?.((entry) => entry.id === binding?.id);
    if (!binding || !revision || !reference
      || reference.descriptorDigest !== binding.descriptor_digest
      || reference.manifestDigest !== binding.manifest_digest) {
      fail('MCP binding is not pinned by this Bot revision', 'bot_mcp_binding_unavailable', 409);
    }
    const pinned = await validatePinnedBinding(binding);
    return { binding, revision, ...pinned };
  };

  const listCredentials = async (binding) => (
    await store.repositories.bot_credentials.list({
      filters: { bot_id: binding.bot_id, provider: binding.credential_provider },
      limit: 100,
    })
  ).items.filter((row) => row.status === 'active' && row.revoked_at === null);

  const resolveCredential = async (binding, ownerUserId) => {
    const credentials = await listCredentials(binding);
    const team = credentials.find((row) => row.credential_scope === 'team' && row.owner_user_id === null);
    const personal = ownerUserId
      ? credentials.find((row) => row.credential_scope === 'user' && row.owner_user_id === ownerUserId)
      : null;
    const credential = personal || team || null;
    if (!credential && binding.display_metadata?.credentialRequired === true) {
      fail('Connect your credential before using this MCP server', 'bot_mcp_credential_required', 409);
    }
    return credential;
  };

  const secretFor = async (credential) => {
    if (!credential) return Object.freeze({ environment: {}, headers: {} });
    const vault = getCredentialVault();
    if (!vault || typeof vault.read !== 'function') {
      fail('Bot credential vault is unavailable', 'bot_credential_vault_unavailable', 503);
    }
    const result = await vault.read(credential.id);
    if (result.credential.botId !== credential.bot_id
      || result.credential.provider !== credential.provider
      || result.credential.kind !== credential.kind
      || result.credential.credentialScope !== credential.credential_scope
      || result.credential.ownerUserId !== credential.owner_user_id) {
      fail('MCP credential scope failed integrity checks', 'bot_mcp_credential_scope_invalid', 409);
    }
    const environment = stringRecord(result.secret?.environment, 'MCP credential environment', ENVIRONMENT_NAME_PATTERN);
    const headers = stringRecord(result.secret?.headers, 'MCP credential headers', HEADER_NAME_PATTERN);
    return Object.freeze({
      credential: result.credential,
      secret: Object.freeze({ environment, headers }),
    });
  };

  const closeOldest = async () => {
    if (clients.size < maxClients) return;
    const candidate = [...clients.entries()].find(([, entry]) => entry.activeCalls === 0);
    if (!candidate) {
      fail('The MCP client limit is busy', 'bot_mcp_client_limit', 503);
    }
    const [key, entry] = candidate;
    clients.delete(key);
    clearClientTimer(entry);
    await entry.client.close().catch(() => undefined);
  };

  const validateSecretKeys = (descriptor, secret) => {
    const expectedKeys = descriptor.transport === 'stdio'
      ? descriptor.environmentKeys
      : descriptor.headerKeys;
    const actualKeys = Object.keys(
      descriptor.transport === 'stdio' ? secret.environment : secret.headers,
    ).sort();
    if (actualKeys.join('\0') !== expectedKeys.join('\0')) {
      fail('MCP credential keys do not match the pinned descriptor', 'bot_mcp_credential_scope_invalid', 409);
    }
    return secret;
  };

  const acquireClient = async (binding, descriptor, credential, secretResult) => withClientLock(async () => {
    const version = secretResult?.credential?.secretVersion || 0;
    const key = `${binding.id}:${credential?.id || 'anonymous'}:${version}`;
    const existing = clients.get(key);
    if (existing) {
      clients.delete(key);
      clients.set(key, existing);
      clearClientTimer(existing);
      existing.activeCalls += 1;
      return { key, entry: existing };
    }
    await closeOldest();
    const secret = validateSecretKeys(descriptor, secretResult?.secret || secretResult);
    const client = await connectClient(descriptor, secret);
    const entry = { bindingId: binding.id, client, idleTimer: null, activeCalls: 1 };
    clients.set(key, entry);
    return { key, entry };
  });

  const releaseClient = (lease) => {
    if (!lease?.entry) return;
    const { key, entry } = lease;
    entry.activeCalls = Math.max(0, entry.activeCalls - 1);
    if (clients.get(key) === entry && entry.activeCalls === 0) armClientTimer(key, entry);
  };

  const manifestForClient = async (client) => normalizeBotMcpToolManifest((await client.listTools()).tools);

  const assertManifest = async (client, binding) => {
    const live = await manifestForClient(client);
    if (digestBotMcpManifest(live) !== binding.manifest_digest) {
      fail('The MCP server tool manifest changed; update the Draft binding before use', 'bot_mcp_manifest_drift', 409);
    }
    return live;
  };

  const preflight = async ({ descriptor, secret = { environment: {}, headers: {} } } = {}) => {
    let client;
    try {
      const normalizedDescriptor = normalizePinnedBotMcpDescriptor(descriptor);
      const normalizedSecret = Object.freeze({
        environment: stringRecord(secret?.environment, 'MCP environment', ENVIRONMENT_NAME_PATTERN),
        headers: stringRecord(secret?.headers, 'MCP headers', HEADER_NAME_PATTERN),
      });
      client = await connectClient(
        normalizedDescriptor,
        validateSecretKeys(normalizedDescriptor, normalizedSecret),
      );
      const manifest = await manifestForClient(client);
      return Object.freeze({ manifest, manifestDigest: digestBotMcpManifest(manifest) });
    } finally {
      await client?.close?.().catch(() => undefined);
    }
  };

  const closeBinding = async (bindingId) => {
    const normalizedId = validateUuid(bindingId, 'bindingId');
    const pending = [];
    for (const [key, entry] of clients) {
      if (entry.bindingId !== normalizedId) continue;
      clients.delete(key);
      clearClientTimer(entry);
      pending.push(entry.client.close().catch(() => undefined));
    }
    await Promise.all(pending);
  };

  const connector = Object.freeze({
    id: 'mcp',
    async describeActions() {
      return Object.freeze([{ name: 'call', operationKind: 'write', description: 'Call one pinned MCP tool through the Bot action gateway.' }]);
    },
    async validate(input) {
      const target = validateBoundedJsonObject(input?.target, 'MCP target', 4 * 1024);
      assertExactObject(target, { label: 'MCP target', required: ['bindingId'] });
      const { binding } = await loadBindingForRevision({
        botId: input?.botId,
        revisionId: input?.revisionId,
        bindingId: target.bindingId,
      });
      const tool = binding.tool_manifest?.find?.((entry) => entry.name === input?.action);
      if (!tool) fail('MCP tool is not pinned by this binding', 'bot_mcp_tool_unavailable', 403);
      const credential = await resolveCredential(binding, validateOptionalUuid(
        input?.channelOwnerUserId,
        'channelOwnerUserId',
      ));
      const suppliedCredentialId = validateOptionalUuid(input?.credentialId, 'credentialId');
      if (suppliedCredentialId && suppliedCredentialId !== credential?.id) {
        fail('MCP credentials are resolved by the Bot channel', 'bot_mcp_credential_scope_invalid', 403);
      }
      return Object.freeze({
        args: validateBoundedJsonObject(input?.args, 'MCP tool arguments', 64 * 1024),
        target: Object.freeze({ bindingId: binding.id, serverName: binding.server_name }),
        operationKind: tool.operationKind === 'read' ? 'read' : 'write',
        credentialId: credential?.id || null,
      });
    },
    async authorize(input) {
      if (input?.action?.tool !== 'connector:mcp') {
        fail('MCP action authorization is invalid', 'bot_mcp_authorization_invalid', 403);
      }
      return Object.freeze({ authorized: true });
    },
    async execute(input) {
      const binding = await store.repositories.bot_mcp_bindings.get({
        id: validateUuid(input?.target?.bindingId, 'bindingId'),
      });
      if (!binding) fail('MCP binding is unavailable', 'bot_mcp_binding_unavailable', 409);
      const pinned = await validatePinnedBinding(binding);
      const tool = pinned.manifest.find((entry) => entry.name === input?.action);
      if (!tool) fail('MCP tool is unavailable', 'bot_mcp_tool_unavailable', 403);
      const credentialId = validateOptionalUuid(input?.credentialId, 'credentialId');
      const credential = credentialId
        ? await store.repositories.bot_credentials.get({ id: credentialId, bot_id: binding.bot_id })
        : null;
      if (credential && (credential.provider !== binding.credential_provider
        || credential.status !== 'active' || credential.revoked_at !== null)) {
        fail('MCP credential is unavailable', 'bot_mcp_credential_required', 409);
      }
      if (!credential && binding.display_metadata?.credentialRequired === true) {
        fail('Connect your credential before using this MCP server', 'bot_mcp_credential_required', 409);
      }
      let secretResult = { environment: {}, headers: {} };
      let descriptor = pinned.descriptor;
      let clientLease = null;
      try {
        secretResult = await secretFor(credential);
        clientLease = await acquireClient(binding, descriptor, credential, secretResult);
        const client = clientLease.entry.client;
        await assertManifest(client, binding);
        let result;
        try {
          result = await client.callTool({ name: tool.name, arguments: input.args }, AbortSignal.timeout(descriptor.timeout));
        } catch (error) {
          if (isTransportFailure(error) && error && typeof error === 'object') {
            try {
              error.transportUncertain = true;
            } catch {
              const uncertain = new BotMcpConnectorError(
                'MCP transport failed during the tool call',
                'bot_mcp_transport_failed',
                502,
              );
              uncertain.transportUncertain = true;
              throw uncertain;
            }
          }
          throw error;
        }
        if (result?.isError === true) {
          fail('The MCP tool reported an error', 'bot_mcp_tool_failed', 502);
        }
        return Object.freeze({
          result: boundedResult(result),
          connectorReceipt: Object.freeze({
            nativeExactlyOnce: false,
            writeGuarantee: tool.operationKind === 'read' ? 'read_response' : 'non_exactly_once',
          }),
        });
      } finally {
        releaseClient(clientLease);
        descriptor = null;
        secretResult = null;
      }
    },
    async reconcile() {
      return Object.freeze({ state: 'unknown', automatic: false });
    },
    async revoke(input) {
      await closeBinding(input?.bindingId);
      return Object.freeze({ revoked: true });
    },
  });

  return Object.freeze({
    connector,
    preflight,
    closeBinding,
    async describeBinding({ botId, revisionId, bindingId }) {
      const { binding, manifest } = await loadBindingForRevision({ botId, revisionId, bindingId });
      return Object.freeze({
        bindingId: binding.id,
        serverName: binding.server_name,
        descriptorDigest: binding.descriptor_digest,
        manifestDigest: binding.manifest_digest,
        tools: Object.freeze(manifest.map((tool) => Object.freeze(structuredClone(tool)))),
      });
    },
    async checkBinding({ botId, revisionId, bindingId, ownerUserId = null }) {
      const { binding, descriptor } = await loadBindingForRevision({ botId, revisionId, bindingId });
      const credential = await resolveCredential(binding, ownerUserId);
      const secretResult = await secretFor(credential);
      let client;
      try {
        client = await connectClient(
          descriptor,
          validateSecretKeys(descriptor, secretResult?.secret || secretResult),
        );
        await assertManifest(client, binding);
        return Object.freeze({ ready: true, credentialId: credential?.id || null });
      } finally {
        await client?.close?.().catch(() => undefined);
      }
    },
    async shutdown() {
      const closing = [...clients.values()].map((entry) => {
        clearClientTimer(entry);
        return entry.client.close().catch(() => undefined);
      });
      clients.clear();
      await Promise.all(closing);
    },
  });
}

export const BOT_MCP_DEPLOYMENT_KEY_ID = DEPLOYMENT_KEY_ID;
