import crypto from 'node:crypto';

import {
  resolveComputerScopeKey,
  resolveReasoningScopeKey,
} from '@openchamber/bots-runtime';

import { assertExactObject, validateUuid } from './validation.js';

const RUNTIME_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const COMPILED_HASH_PATTERN = /^[0-9a-f]{64}$/;
const NAME_PATTERN = /^devryan-bot-[a-z0-9-]{1,120}$/;
const EGRESS_AUTHORITY_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?:443$/;
const REASONING_PROXY_PATH_PATTERN = /^\/v1\/runtime\/[A-Za-z0-9_-]{43}$/;
const WORKSPACE_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHARED_FILE_MAX_BYTES = 25 * 1024 * 1024;

export class BotDockerProviderError extends Error {
  constructor(message, code = 'bot_runtime_request_invalid', statusCode = 400) {
    super(message);
    this.name = 'BotDockerProviderError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotDockerProviderError(message, code, statusCode);
};

const validateRuntimeToken = (value) => {
  if (typeof value !== 'string' || !RUNTIME_TOKEN_PATTERN.test(value)) {
    fail('Bot runtime capability is invalid');
  }
  return value;
};

const validateGatewayUrl = (value) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('Bot private gateway URL is invalid');
  }
  if (url.protocol !== 'http:' || url.hostname !== 'host.docker.internal' || !url.port
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    fail('Bot private gateway URL is invalid');
  }
  return url.origin;
};

const validateCompiledHash = (value) => {
  if (typeof value !== 'string' || !COMPILED_HASH_PATTERN.test(value)) {
    fail('Bot compiled revision hash is invalid');
  }
  return value;
};

const validateEgressHosts = (value) => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32
    || value.some((authority) => (
      typeof authority !== 'string'
      || authority.length > 260
      || !EGRESS_AUTHORITY_PATTERN.test(authority)
    ))
    || new Set(value).size !== value.length) {
    fail('Bot model egress hosts are invalid');
  }
  return Object.freeze([...value]);
};

const validateReasoningInput = (input) => {
  try {
    assertExactObject(input, {
      label: 'reasoning runtime request',
      required: [
        'botId',
        'runId',
        'channelId',
        'revisionId',
        'runtimeToken',
        'compiledHash',
        'gatewayUrl',
        'egressHosts',
        'environmentSecretCount',
        'chatgptImageGeneration',
      ],
    });
  } catch (error) {
    fail(error.message);
  }
  const channelId = validateUuid(input.channelId, 'channelId');
  if (!Number.isSafeInteger(input.environmentSecretCount)
    || input.environmentSecretCount < 0 || input.environmentSecretCount > 128
    || typeof input.chatgptImageGeneration !== 'boolean') {
    fail('Bot reasoning runtime capabilities are invalid');
  }
  return Object.freeze({
    botId: validateUuid(input.botId, 'botId'),
    scopeKey: resolveReasoningScopeKey({ channelId }),
    runId: validateUuid(input.runId, 'runId'),
    channelId,
    revisionId: validateUuid(input.revisionId, 'revisionId'),
    runtimeToken: validateRuntimeToken(input.runtimeToken),
    compiledHash: validateCompiledHash(input.compiledHash),
    gatewayUrl: validateGatewayUrl(input.gatewayUrl),
    egressHosts: validateEgressHosts(input.egressHosts),
    environmentSecretCount: input.environmentSecretCount,
    chatgptImageGeneration: input.chatgptImageGeneration,
  });
};

const validateComputerInput = (input) => {
  try {
    assertExactObject(input, {
      label: 'computer runtime request',
      required: [
        'botId',
        'runId',
        'channelId',
        'revisionId',
        'runtimeToken',
        'tenancy',
        'ownerUserId',
        'gatewayUrl',
        'browserNetworkMode',
        'browserEgressHosts',
        'isolationTier',
      ],
    });
  } catch (error) {
    fail(error.message);
  }
  const botId = validateUuid(input.botId, 'botId');
  const ownerUserId = validateUuid(input.ownerUserId, 'ownerUserId');
  if (!['team', 'personalized'].includes(input.tenancy)) fail('Bot computer tenancy is invalid');
  if (!['public_only', 'allowlist'].includes(input.browserNetworkMode)
    || !Array.isArray(input.browserEgressHosts) || input.browserEgressHosts.length > 64
    || input.browserEgressHosts.some((host) => typeof host !== 'string' || host.length > 512)
    || (input.browserNetworkMode === 'public_only' && input.browserEgressHosts.length !== 0)
    || (input.browserNetworkMode === 'allowlist' && input.browserEgressHosts.length === 0)
    || !['standard', 'runsc'].includes(input.isolationTier)) {
    fail('Bot computer network or isolation policy is invalid');
  }
  return Object.freeze({
    botId,
    scopeKey: resolveComputerScopeKey({ botId, tenancy: input.tenancy, ownerUserId }),
    runId: validateUuid(input.runId, 'runId'),
    channelId: validateUuid(input.channelId, 'channelId'),
    revisionId: validateUuid(input.revisionId, 'revisionId'),
    runtimeToken: validateRuntimeToken(input.runtimeToken),
    // One shared computer per Bot, whatever a legacy record says.
    scopeMode: 'team',
    gatewayUrl: validateGatewayUrl(input.gatewayUrl),
    browserNetworkMode: input.browserNetworkMode,
    browserEgressHosts: Object.freeze([...input.browserEgressHosts]),
    isolationTier: input.isolationTier,
  });
};

const validateTarget = (input, kind) => {
  const required = kind === 'reasoning'
    ? ['botId', 'channelId']
    : ['botId', 'tenancy', 'ownerUserId'];
  try {
    assertExactObject(input, { label: `${kind} runtime target`, required });
  } catch (error) {
    fail(error.message);
  }
  const botId = validateUuid(input.botId, 'botId');
  if (kind === 'reasoning') {
    const channelId = validateUuid(input.channelId, 'channelId');
    return Object.freeze({ kind, botId, scopeKey: resolveReasoningScopeKey({ channelId }) });
  }
  const ownerUserId = validateUuid(input.ownerUserId, 'ownerUserId');
  if (!['team', 'personalized'].includes(input.tenancy)) fail('Bot computer tenancy is invalid');
  return Object.freeze({
    kind,
    botId,
    scopeKey: resolveComputerScopeKey({ botId, tenancy: input.tenancy, ownerUserId }),
  });
};

const validateEndpoint = (endpoint, kind) => {
  const expectedKeys = kind === 'reasoning' ? 'host\0path\0port' : 'host\0port';
  if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)
    || Object.keys(endpoint).sort().join('\0') !== expectedKeys
    || !['127.0.0.1', '::1'].includes(endpoint.host)
    || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535
    || (kind === 'reasoning' && !REASONING_PROXY_PATH_PATTERN.test(endpoint.path))) {
    fail('Bot runtime endpoint is not loopback-confined', 'bot_runtime_endpoint_invalid', 502);
  }
  const origin = endpoint.host === '::1'
    ? `http://[::1]:${endpoint.port}`
    : `http://127.0.0.1:${endpoint.port}`;
  return Object.freeze({
    host: endpoint.host,
    port: endpoint.port,
    ...(kind === 'reasoning' ? { path: endpoint.path } : {}),
    baseUrl: `${origin}${kind === 'reasoning' ? endpoint.path : ''}`,
  });
};

const validateEnsureResult = (result, expectedKind) => {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).sort().join('\0') !== [
      'endpoint', 'image', 'kind', 'name', 'replaced', 'state',
    ].sort().join('\0')
    || result.kind !== expectedKind || result.state !== 'running'
    || typeof result.image !== 'string' || !result.image
    || typeof result.replaced !== 'boolean' || !NAME_PATTERN.test(result.name)) {
    fail('Electron returned an invalid Bot runtime result', 'bot_runtime_host_response_invalid', 502);
  }
  return Object.freeze({ ...result, endpoint: validateEndpoint(result.endpoint, expectedKind) });
};

const validateStatusResult = (result, expectedKind) => {
  const keys = Object.keys(result || {}).sort().join('\0');
  const expected = result?.state === 'absent'
    ? ['kind', 'name', 'state'].sort().join('\0')
    : ['endpoint', 'image', 'kind', 'name', 'state'].sort().join('\0');
  if (!result || typeof result !== 'object' || Array.isArray(result) || keys !== expected
    || result.kind !== expectedKind || !['absent', 'running', 'stopped'].includes(result.state)
    || !NAME_PATTERN.test(result.name)
    || (result.state !== 'absent' && result.image !== null && typeof result.image !== 'string')
    || (result.state === 'running' && result.endpoint === null)) {
    fail('Electron returned an invalid Bot runtime status', 'bot_runtime_host_response_invalid', 502);
  }
  return Object.freeze({
    ...result,
    endpoint: result.state === 'absent' || result.endpoint === null
      ? null
      : validateEndpoint(result.endpoint, expectedKind),
    ...(result.state === 'absent' ? { image: null } : {}),
  });
};

const validateStopResult = (result) => {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).sort().join('\0') !== 'name\0state'
    || !['absent', 'stopped'].includes(result.state) || !NAME_PATTERN.test(result.name)) {
    fail('Electron returned an invalid Bot runtime stop result', 'bot_runtime_host_response_invalid', 502);
  }
  return Object.freeze({ ...result });
};

const validateResetResult = (result) => {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).sort().join('\0') !== 'name\0removed\0state'
    || result.state !== 'reset' || !NAME_PATTERN.test(result.name)
    || !Array.isArray(result.removed) || result.removed.length > 3
    || result.removed.some((role) => (
      typeof role !== 'string' || !/^[a-z][a-z-]{0,31}$/.test(role)
    ))) {
    fail('Electron returned an invalid Bot runtime reset result', 'bot_runtime_host_response_invalid', 502);
  }
  return Object.freeze({ ...result, removed: Object.freeze([...result.removed]) });
};

const validateWorkspaceWrite = (input) => {
  try {
    assertExactObject(input, {
      label: 'Bot workspace write',
      required: ['botId', 'channelId', 'path', 'content'],
    });
  } catch (error) {
    fail(error.message);
  }
  const path = typeof input.path === 'string' ? input.path : '';
  if (!WORKSPACE_FILE_PATTERN.test(path)
    || ['.devryan', '.opencode'].includes(path.toLowerCase())
    || typeof input.content !== 'string'
    || Buffer.byteLength(input.content, 'utf8') > 48 * 1024) {
    fail('Bot workspace write is invalid');
  }
  return Object.freeze({
    botId: validateUuid(input.botId, 'botId'),
    channelId: validateUuid(input.channelId, 'channelId'),
    path,
    content: input.content,
  });
};

const validateWorkspaceWriteResult = (result, expected) => {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).sort().join('\0') !== 'bytes\0path\0sha256\0written'
    || result.written !== true || result.path !== expected.path
    || !Number.isSafeInteger(result.bytes) || result.bytes < 0
    || result.bytes !== Buffer.byteLength(expected.content, 'utf8')
    || typeof result.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(result.sha256)) {
    fail('Electron returned an invalid Bot workspace write result', 'bot_runtime_host_response_invalid', 502);
  }
  return Object.freeze({ ...result });
};

const validateSharedImport = (input) => {
  try {
    assertExactObject(input, {
      label: 'Bot Shared import',
      required: ['botId', 'channelId', 'messageId', 'filename', 'bytes'],
      optional: ['resourcePath'],
    });
  } catch (error) {
    fail(error.message);
  }
  const resourceSegments = typeof input.resourcePath === 'string'
    ? input.resourcePath.split('/')
    : null;
  if (typeof input.filename !== 'string' || !WORKSPACE_FILE_PATTERN.test(input.filename)
    || ['.devryan', '.opencode'].includes(input.filename.toLowerCase())
    || (resourceSegments && (
      Buffer.byteLength(input.resourcePath, 'utf8') > 180
      || resourceSegments.length > 32
      || resourceSegments.at(-1) !== input.filename
      || Buffer.byteLength(resourceSegments.slice(0, -1).join('/'), 'utf8') > 145
      || resourceSegments.some((segment) => !WORKSPACE_FILE_PATTERN.test(segment)
        || ['.devryan', '.opencode'].includes(segment.toLowerCase()))
    ))
    || !Buffer.isBuffer(input.bytes) || input.bytes.byteLength < 1
    || input.bytes.byteLength > SHARED_FILE_MAX_BYTES) {
    fail('Bot Shared import is invalid');
  }
  return Object.freeze({
    botId: validateUuid(input.botId, 'botId'),
    channelId: validateUuid(input.channelId, 'channelId'),
    messageId: validateUuid(input.messageId, 'messageId'),
    filename: input.filename,
    ...(resourceSegments ? { resourcePath: resourceSegments.join('/') } : {}),
    bytes: input.bytes,
    sha256: crypto.createHash('sha256').update(input.bytes).digest('hex'),
  });
};

const validateSharedImportResult = (result, expected) => {
  const path = expected.resourcePath
    ? `/workspace/Resources/${expected.resourcePath}`
    : `/workspace/Shared/${expected.channelId}/${expected.messageId}/${expected.filename}`;
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).sort().join('\0') !== 'bytes\0path\0sha256\0written'
    || result.written !== true || result.path !== path
    || result.bytes !== expected.bytes.byteLength || result.sha256 !== expected.sha256) {
    fail('Electron returned an invalid Bot Shared import result', 'bot_runtime_host_response_invalid', 502);
  }
  return Object.freeze({ ...result });
};

const validateWorkspaceImageResult = (result, expectedPath) => {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).sort().join('\0')
      !== 'contentBase64\0contentType\0filename\0path\0sha256\0size'
    || result.path !== expectedPath || typeof result.filename !== 'string'
    || result.filename !== expectedPath.split('/').at(-1)
    || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(result.contentType)
    || !Number.isSafeInteger(result.size) || result.size < 1 || result.size > 10 * 1024 * 1024
    || typeof result.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(result.sha256)
    || typeof result.contentBase64 !== 'string'
    || result.contentBase64.length > Math.ceil((10 * 1024 * 1024) / 3) * 4) {
    fail('Electron returned an invalid generated image', 'bot_image_publication_failed', 502);
  }
  const bytes = Buffer.from(result.contentBase64, 'base64');
  if (bytes.byteLength !== result.size || bytes.toString('base64') !== result.contentBase64
    || crypto.createHash('sha256').update(bytes).digest('hex') !== result.sha256) {
    bytes.fill(0);
    fail('Generated image integrity validation failed', 'bot_image_publication_failed', 502);
  }
  return Object.freeze({
    path: result.path,
    filename: result.filename,
    contentType: result.contentType,
    size: result.size,
    sha256: result.sha256,
    bytes,
  });
};

const validateWorkspaceListResult = (result, expectedPath) => {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).sort().join('\0') !== 'entries\0path\0state\0truncated'
    || !['running', 'stopped'].includes(result.state)
    || result.path !== expectedPath || typeof result.truncated !== 'boolean'
    || !Array.isArray(result.entries) || result.entries.length > 500
    || result.entries.some((entry) => (
      !entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.path !== 'string' || typeof entry.name !== 'string'
      || entry.path !== (expectedPath ? `${expectedPath}/${entry.name}` : entry.name)
      || Buffer.byteLength(entry.name, 'utf8') > 255
      || entry.name === '' || entry.name === '.' || entry.name === '..'
      || entry.name.includes('/') || entry.name.includes('\\') || entry.name.includes('\0')
      || !['file', 'dir'].includes(entry.type)
      || !Number.isSafeInteger(entry.size) || entry.size < 0
      || (entry.modifiedAt !== null && typeof entry.modifiedAt !== 'string')
    ))) {
    fail('Electron returned an invalid Bot workspace listing', 'bot_runtime_host_response_invalid', 502);
  }
  return Object.freeze({
    path: result.path,
    state: result.state,
    truncated: result.truncated,
    entries: Object.freeze(result.entries.map((entry) => Object.freeze({
      path: entry.path,
      name: entry.name,
      type: entry.type,
      size: entry.size,
      modifiedAt: entry.modifiedAt ?? null,
    }))),
  });
};

const validateContainerListResult = (result, expectedPath) => {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).sort().join('\0') !== 'entries\0path\0state\0truncated'
    || !['running', 'stopped'].includes(result.state)
    || result.path !== expectedPath || Buffer.byteLength(result.path, 'utf8') > 1024
    || typeof result.truncated !== 'boolean'
    || !Array.isArray(result.entries) || result.entries.length > 500
    || result.entries.some((entry) => (
      !entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.path !== 'string' || typeof entry.name !== 'string'
      || entry.path !== (expectedPath ? `${expectedPath}/${entry.name}` : entry.name)
      || Buffer.byteLength(entry.name, 'utf8') > 255
      || entry.name === '' || entry.name === '.' || entry.name === '..'
      || entry.name.includes('/') || entry.name.includes('\\') || entry.name.includes('\0')
      || !['file', 'directory', 'symlink', 'special'].includes(entry.kind)
      || !Number.isSafeInteger(entry.size) || entry.size < 0
      || (entry.modifiedAt !== null && typeof entry.modifiedAt !== 'string')
      || typeof entry.restricted !== 'boolean'
    ))) {
    fail('Electron returned an invalid Bot container listing', 'bot_runtime_host_response_invalid', 502);
  }
  return Object.freeze({
    path: result.path,
    state: result.state,
    truncated: result.truncated,
    entries: Object.freeze(result.entries.map((entry) => Object.freeze({
      path: entry.path,
      name: entry.name,
      kind: entry.kind,
      size: entry.size,
      modifiedAt: entry.modifiedAt ?? null,
      restricted: entry.restricted,
    }))),
  });
};

export function createBotDockerProvider({ botHost } = {}) {
  const available = botHost?.owner === 'electron'
    && typeof botHost.ensureReasoning === 'function'
    && typeof botHost.ensureComputer === 'function'
    && typeof botHost.inspect === 'function'
    && typeof botHost.stop === 'function';
  const requireHost = () => {
    if (!available) {
      fail('Production Bot containers require the Electron runtime owner', 'bot_runtime_unsupported_host', 503);
    }
  };
  const requireResetHost = () => {
    requireHost();
    if (typeof botHost.reset !== 'function') {
      fail('Production Bot reset requires the Electron runtime owner', 'bot_runtime_unsupported_host', 503);
    }
  };
  const requireWorkspaceWriteHost = () => {
    requireHost();
    if (typeof botHost.writeWorkspace !== 'function') {
      fail('Production Bot workspace writes require the Electron runtime owner', 'bot_runtime_unsupported_host', 503);
    }
  };
  const requireWorkspaceListHost = () => {
    requireHost();
    if (typeof botHost.listWorkspace !== 'function') {
      fail('Production Bot computer files require the Electron runtime owner', 'bot_runtime_unsupported_host', 503);
    }
  };
  const requireContainerListHost = () => {
    requireHost();
    if (typeof botHost.listFilesystem !== 'function') {
      fail('Production Bot container files require the Electron runtime owner', 'bot_runtime_unsupported_host', 503);
    }
  };
  const requireSharedImportHost = () => {
    requireHost();
    if (typeof botHost.importSharedFile !== 'function') {
      fail('Production Bot Shared imports require the Electron runtime owner', 'bot_runtime_unsupported_host', 503);
    }
  };
  const requireWorkspaceImageExportHost = () => {
    requireHost();
    if (typeof botHost.exportWorkspaceImage !== 'function') {
      fail('Production Bot image export requires the Electron runtime owner',
        'bot_image_publication_failed', 503);
    }
  };

  return Object.freeze({
    available,
    resetAvailable: available && typeof botHost.reset === 'function',
    workspaceWriteAvailable: available && typeof botHost.writeWorkspace === 'function',
    sharedImportAvailable: available && typeof botHost.importSharedFile === 'function',
    workspaceImageExportAvailable: available && typeof botHost.exportWorkspaceImage === 'function',
    workspaceListAvailable: available && typeof botHost.listWorkspace === 'function',
    containerListAvailable: available && typeof botHost.listFilesystem === 'function',
    async ensureReasoning(input) {
      requireHost();
      const request = validateReasoningInput(input);
      return validateEnsureResult(await botHost.ensureReasoning(request), 'reasoning');
    },
    async ensureComputer(input) {
      requireHost();
      const request = validateComputerInput(input);
      return validateEnsureResult(await botHost.ensureComputer(request), 'computer');
    },
    async inspectReasoning(input) {
      requireHost();
      const target = validateTarget(input, 'reasoning');
      return validateStatusResult(await botHost.inspect(target), 'reasoning');
    },
    async inspectComputer(input) {
      requireHost();
      const target = validateTarget(input, 'computer');
      return validateStatusResult(await botHost.inspect(target), 'computer');
    },
    async stopReasoning(input) {
      requireHost();
      return validateStopResult(await botHost.stop(validateTarget(input, 'reasoning')));
    },
    async stopComputer(input) {
      requireHost();
      return validateStopResult(await botHost.stop(validateTarget(input, 'computer')));
    },
    async resetReasoning(input, resource = 'all') {
      requireResetHost();
      if (!['opencode', 'workspace', 'runtime-config', 'all'].includes(resource)) {
        fail('Bot reasoning reset resource is invalid');
      }
      return validateResetResult(await botHost.reset({
        ...validateTarget(input, 'reasoning'),
        resource,
      }));
    },
    async resetComputer(input, resource = 'all') {
      requireResetHost();
      if (!['profile', 'scratch', 'shared', 'all'].includes(resource)) {
        fail('Bot computer reset resource is invalid');
      }
      return validateResetResult(await botHost.reset({
        ...validateTarget(input, 'computer'),
        resource,
      }));
    },
    async writeWorkspace(input) {
      requireWorkspaceWriteHost();
      const request = validateWorkspaceWrite(input);
      return validateWorkspaceWriteResult(await botHost.writeWorkspace({
        botId: request.botId,
        scopeKey: `channel:${request.channelId}`,
        path: request.path,
        content: request.content,
      }), request);
    },
    async importSharedFile(input) {
      requireSharedImportHost();
      const request = validateSharedImport(input);
      return validateSharedImportResult(await botHost.importSharedFile({
        botId: request.botId,
        scopeKey: `bot:${request.botId}`,
        channelId: request.channelId,
        messageId: request.messageId,
        filename: request.filename,
        ...(request.resourcePath ? { resourcePath: request.resourcePath } : {}),
        contentBase64: request.bytes.toString('base64'),
        expectedSize: request.bytes.byteLength,
        sha256: request.sha256,
      }), request);
    },
    async exportWorkspaceImage(input) {
      requireWorkspaceImageExportHost();
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || typeof input.path !== 'string' || input.path.length < 1
        || Buffer.byteLength(input.path, 'utf8') > 1024
        || input.path.startsWith('/') || input.path.includes('\0') || input.path.includes('\\')) {
        fail('Bot generated image request is invalid', 'bot_image_publication_failed', 400);
      }
      const segments = input.path.split('/');
      if (segments.length > 32 || segments.some((segment) => (
        segment === '' || segment === '.' || segment === '..'
        || Buffer.byteLength(segment, 'utf8') > 255
      )) || ['.devryan', '.opencode'].includes(segments[0].toLowerCase())) {
        fail('Bot generated image request is invalid', 'bot_image_publication_failed', 400);
      }
      const botId = validateUuid(input.botId, 'botId');
      const channelId = validateUuid(input.channelId, 'channelId');
      return validateWorkspaceImageResult(await botHost.exportWorkspaceImage({
        botId,
        scopeKey: `channel:${channelId}`,
        path: input.path,
      }), input.path);
    },
    // Read-only listing of the Bot's shared computer. Never starts a container.
    async listWorkspace(input) {
      requireWorkspaceListHost();
      const target = validateTarget(
        { botId: input?.botId, tenancy: input?.tenancy, ownerUserId: input?.ownerUserId },
        'computer',
      );
      const requestedPath = typeof input?.path === 'string' && input.path !== '' ? input.path : null;
      return validateWorkspaceListResult(await botHost.listWorkspace({
        kind: 'computer',
        botId: target.botId,
        scopeKey: target.scopeKey,
        path: requestedPath,
      }), requestedPath ?? '');
    },
    async listContainerFilesystem(input) {
      requireContainerListHost();
      const target = validateTarget(
        { botId: input?.botId, tenancy: input?.tenancy, ownerUserId: input?.ownerUserId },
        'computer',
      );
      const requestedPath = typeof input?.path === 'string' && input.path !== '' ? input.path : null;
      return validateContainerListResult(await botHost.listFilesystem({
        kind: 'computer',
        botId: target.botId,
        scopeKey: target.scopeKey,
        path: requestedPath,
      }), requestedPath ?? '');
    },
  });
}
