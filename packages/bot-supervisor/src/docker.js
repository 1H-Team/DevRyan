import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import {
  BOT_RUNTIME_LABEL,
  buildBotOwnershipLabels,
  buildBotSharedVolumeLabels,
  buildBotVolumeLabels,
  deriveBotResourceNames,
} from './names.js';
import {
  buildBotResourceFileArchive,
  buildBotSharedFileArchive,
  buildBotWorkspaceFileArchive,
} from './workspace-archive.js';
import { createBotSharedFileVerifier } from './shared-file-verifier.js';
import { createBotGeneratedImageVerifier } from './generated-image-verifier.js';
import {
  BOT_WORKSPACE_LISTING_MAX_ENTRIES,
  createBotWorkspaceListingParser,
  isBotContainerPathRestricted,
  resolveBotContainerPath,
  resolveBotGeneratedImagePath,
  resolveBotWorkspacePath,
} from './workspace-listing.js';

const DOCKER_API_VERSION = 'v1.44';
const MAX_DOCKER_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const SHARED_COMMIT_TIMEOUT_MS = 2_000;
const SHARED_COMMIT_POLL_MS = 25;
const CONTAINER_USER = '10001:10001';
// Go's os.FileMode type bits as returned by Docker's container-path stat.
const GO_FILE_MODE_TYPE_MASK = 0x8f280000;
const GO_FILE_MODE_DIRECTORY = 0x80000000;
const CONTAINER_DIRECTORY_LIST_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const target = process.argv[1];
if (!path.posix.isAbsolute(target) || path.posix.normalize(target) !== target
  || fs.realpathSync.native(target) !== target || !fs.lstatSync(target).isDirectory()) {
  process.exit(64);
}
const entries = [];
let truncated = false;
const directory = fs.opendirSync(target);
try {
  while (true) {
    const entry = directory.readSync();
    if (!entry) break;
    if (entries.length >= 500) {
      truncated = true;
      break;
    }
    let stats;
    try {
      stats = fs.lstatSync(path.join(target, entry.name), { throwIfNoEntry: true });
    } catch {
      entries.push({
        name: entry.name, kind: 'special', size: 0, mode: 0,
        modifiedAt: null, unreadable: true,
      });
      continue;
    }
    const kind = stats.isFile() ? 'file'
      : stats.isDirectory() ? 'directory'
      : stats.isSymbolicLink() ? 'symlink' : 'special';
    entries.push({
      name: entry.name,
      kind,
      size: kind === 'directory' ? 0 : Number(stats.size),
      mode: stats.mode & 0o7777,
      modifiedAt: Number.isFinite(stats.mtimeMs) ? stats.mtime.toISOString() : null,
      unreadable: false,
    });
  }
} finally {
  directory.closeSync();
}
process.stdout.write(JSON.stringify({ entries, truncated }));
`;
const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;
const IMAGE_REFERENCE_PATTERN = /^[a-z0-9][a-z0-9._/-]*(?::[0-9]+)?(?:[/:][a-z0-9][a-z0-9._/-]*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[0-9a-f]{64})$/;
const NETWORK_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/;
const RUNTIME_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{32,8192}$/;
const EGRESS_TOKEN_PATTERN = /^drb1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const COMPILED_HASH_PATTERN = /^[0-9a-f]{64}$/;
// 'team' is the only computer scope: one shared computer per Bot.
const SCOPE_MODES = new Set(['team']);

export const BOT_CONTAINER_PORTS = Object.freeze({
  reasoning: '4096/tcp',
  computer: '43122/tcp',
});

export const BOT_RESOURCE_LIMITS = Object.freeze({
  reasoning: Object.freeze({
    memoryBytes: 2 * GIB,
    nanoCpus: 2_000_000_000,
    pids: 256,
    shmBytes: 64 * MIB,
  }),
  computer: Object.freeze({
    memoryBytes: 3 * GIB,
    nanoCpus: 2_000_000_000,
    pids: 512,
    shmBytes: GIB,
  }),
});

export class BotDockerError extends Error {
  constructor(message, code, { statusCode = 500, dockerStatusCode = null, cause } = {}) {
    super(message, { cause });
    this.name = 'BotDockerError';
    this.code = code;
    this.statusCode = statusCode;
    this.dockerStatusCode = dockerStatusCode;
  }
}

const fail = (message, code, options) => {
  throw new BotDockerError(message, code, options);
};

const exactKeys = (value, expected, message = 'Bot supervisor request shape is invalid') => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) {
    fail(message, 'bot_supervisor_request_invalid', { statusCode: 400 });
  }
};

const isNotFound = (error) => (
  error?.code === 'bot_supervisor_docker_not_found' || error?.dockerStatusCode === 404
);

const mapDockerFailure = (error) => {
  if (error instanceof BotDockerError) throw error;
  if (['ENOENT', 'EACCES', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EPIPE', 'ETIMEDOUT'].includes(error?.code)) {
    fail('Docker Engine is unavailable', 'bot_supervisor_docker_unavailable', {
      statusCode: 503,
      cause: error,
    });
  }
  fail('Docker Engine request failed', 'bot_supervisor_docker_api_error', {
    statusCode: 502,
    cause: error,
  });
};

const dockerPath = (pathname) => `/${DOCKER_API_VERSION}${pathname}`;

export function createDockerSocketClient({
  socketPath = '/var/run/docker.sock',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  request = http.request,
} = {}) {
  if (typeof socketPath !== 'string' || !path.posix.isAbsolute(socketPath)
    || path.posix.basename(socketPath) !== 'docker.sock') {
    fail('Docker socket path is invalid', 'bot_supervisor_configuration_invalid');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000
    || typeof request !== 'function') {
    fail('Docker client configuration is invalid', 'bot_supervisor_configuration_invalid');
  }

  const call = ({
    method,
    pathname,
    query,
    body,
    rawBody,
    contentType = 'application/json',
    expected = [200],
    responseType = 'json',
  }) => new Promise((resolve, reject) => {
    const search = query ? `?${new URLSearchParams(query).toString()}` : '';
    if (body !== undefined && rawBody !== undefined) {
      reject(new BotDockerError('Docker request body is ambiguous', 'bot_supervisor_configuration_invalid'));
      return;
    }
    const payload = rawBody === undefined
      ? (body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8'))
      : Buffer.from(rawBody);
    const req = request({
      socketPath,
      method,
      path: `${dockerPath(pathname)}${search}`,
      headers: payload ? {
        'content-type': contentType,
        'content-length': String(payload.byteLength),
      } : undefined,
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.byteLength;
        if (bytes > MAX_DOCKER_RESPONSE_BYTES) {
          response.destroy(new Error('Docker response exceeded the limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!expected.includes(response.statusCode)) {
          reject(new BotDockerError(
            response.statusCode === 404 ? 'Docker resource was not found' : 'Docker Engine rejected the request',
            response.statusCode === 404
              ? 'bot_supervisor_docker_not_found'
              : 'bot_supervisor_docker_api_error',
            {
              statusCode: response.statusCode === 404 ? 404 : 502,
              dockerStatusCode: response.statusCode,
            },
          ));
          return;
        }
        if (responseType === 'text') {
          resolve(raw);
          return;
        }
        if (responseType === 'headers') {
          resolve(response.headers);
          return;
        }
        if (!raw) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(new BotDockerError('Docker Engine returned invalid JSON', 'bot_supervisor_docker_api_error', {
            statusCode: 502,
            dockerStatusCode: response.statusCode,
            cause: error,
          }));
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('Docker request timed out'), {
      code: 'ETIMEDOUT',
    })));
    req.on('error', (error) => {
      try {
        mapDockerFailure(error);
      } catch (mapped) {
        reject(mapped);
      }
    });
    if (payload) req.end(payload);
    else req.end();
  });

  // Streams a container archive through a consumer instead of buffering it.
  // Only what the consumer retains survives the call, so listing a workspace
  // costs the same whether it holds one file or a thousand.
  const streamArchive = (id, containerPath, consumer) => new Promise((resolve, reject) => {
    const req = request({
      socketPath,
      method: 'GET',
      path: `${dockerPath(`/containers/${encodeURIComponent(id)}/archive`)}?${
        new URLSearchParams({ path: containerPath }).toString()}`,
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new BotDockerError(
          response.statusCode === 404 ? 'Docker resource was not found' : 'Docker Engine rejected the request',
          response.statusCode === 404
            ? 'bot_supervisor_docker_not_found'
            : 'bot_supervisor_docker_api_error',
          {
            statusCode: response.statusCode === 404 ? 404 : 502,
            dockerStatusCode: response.statusCode,
          },
        ));
        return;
      }
      response.on('data', (chunk) => {
        try {
          consumer.push(chunk);
        } catch (error) {
          response.destroy();
          reject(error);
        }
      });
      response.on('error', reject);
      response.on('end', () => resolve(consumer.result()));
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('Docker request timed out'), {
      code: 'ETIMEDOUT',
    })));
    req.on('error', (error) => {
      try {
        mapDockerFailure(error);
      } catch (mapped) {
        reject(mapped);
      }
    });
    req.end();
  });

  return Object.freeze({
    streamContainerArchive: streamArchive,
    ping: () => call({ method: 'GET', pathname: '/_ping', responseType: 'text' }),
    inspectImage: (reference) => call({
      method: 'GET',
      pathname: `/images/${encodeURIComponent(reference)}/json`,
    }),
    inspectContainer: (name) => call({
      method: 'GET',
      pathname: `/containers/${encodeURIComponent(name)}/json`,
    }),
    listContainers: (labels) => call({
      method: 'GET',
      pathname: '/containers/json',
      query: {
        all: 'true',
        filters: JSON.stringify({ label: labels }),
      },
    }),
    createContainer: (name, config) => call({
      method: 'POST',
      pathname: '/containers/create',
      query: { name },
      body: config,
      expected: [201],
    }),
    startContainer: (id) => call({
      method: 'POST',
      pathname: `/containers/${encodeURIComponent(id)}/start`,
      expected: [204, 304],
    }),
    stopContainer: (id) => call({
      method: 'POST',
      pathname: `/containers/${encodeURIComponent(id)}/stop`,
      query: { t: '15' },
      expected: [204, 304],
    }),
    waitContainer: (id) => call({
      method: 'POST',
      pathname: `/containers/${encodeURIComponent(id)}/wait`,
      query: { condition: 'not-running' },
    }),
    removeContainer: (id) => call({
      method: 'DELETE',
      pathname: `/containers/${encodeURIComponent(id)}`,
      query: { force: 'false', v: 'false' },
      expected: [204],
    }),
    connectContainerNetwork: (network, id) => call({
      method: 'POST',
      pathname: `/networks/${encodeURIComponent(network)}/connect`,
      body: { Container: id },
    }),
    listContainerDirectory: async (id, containerPath) => {
      const created = await call({
        method: 'POST',
        pathname: `/containers/${encodeURIComponent(id)}/exec`,
        body: {
          AttachStderr: false,
          AttachStdout: true,
          Cmd: ['node', '-e', CONTAINER_DIRECTORY_LIST_SCRIPT, '--', containerPath],
          User: CONTAINER_USER,
          WorkingDir: '/',
          Tty: true,
        },
        expected: [201],
      });
      if (!created || typeof created.Id !== 'string' || !ID_PATTERN.test(created.Id)) {
        fail('Docker returned an invalid directory-list identity', 'bot_supervisor_docker_api_error', {
          statusCode: 502,
        });
      }
      const output = await call({
        method: 'POST',
        pathname: `/exec/${encodeURIComponent(created.Id)}/start`,
        body: { Detach: false, Tty: true },
        responseType: 'text',
      });
      const status = await call({
        method: 'GET',
        pathname: `/exec/${encodeURIComponent(created.Id)}/json`,
      });
      if (!status || status.Running !== false || status.ExitCode !== 0) {
        fail('Docker could not list the Bot container directory', 'bot_supervisor_docker_api_error', {
          statusCode: 502,
        });
      }
      let result;
      try {
        result = JSON.parse(String(output || '').trim());
      } catch {
        fail('Docker returned an invalid Bot directory listing', 'bot_supervisor_docker_api_error', {
          statusCode: 502,
        });
      }
      if (!result || typeof result !== 'object' || Array.isArray(result)
        || Object.keys(result).sort().join('\0') !== 'entries\0truncated'
        || typeof result.truncated !== 'boolean' || !Array.isArray(result.entries)
        || result.entries.length > BOT_WORKSPACE_LISTING_MAX_ENTRIES
        || result.entries.some((entry) => (
          !entry || typeof entry !== 'object' || Array.isArray(entry)
          || Object.keys(entry).sort().join('\0')
            !== 'kind\0mode\0modifiedAt\0name\0size\0unreadable'
          || typeof entry.name !== 'string' || entry.name === ''
          || Buffer.byteLength(entry.name, 'utf8') > 255
          || entry.name === '.' || entry.name === '..' || entry.name.includes('/')
          || entry.name.includes('\\') || entry.name.includes('\0')
          || !['file', 'directory', 'symlink', 'special'].includes(entry.kind)
          || !Number.isSafeInteger(entry.size) || entry.size < 0
          || !Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o7777
          || (entry.modifiedAt !== null
            && (typeof entry.modifiedAt !== 'string'
              || !Number.isFinite(Date.parse(entry.modifiedAt))))
          || typeof entry.unreadable !== 'boolean'
        ))) {
        fail('Docker returned an invalid Bot directory listing', 'bot_supervisor_docker_api_error', {
          statusCode: 502,
        });
      }
      return Object.freeze({
        entries: Object.freeze(result.entries.map((entry) => Object.freeze({ ...entry }))),
        truncated: result.truncated,
      });
    },
    statContainerPath: async (id, containerPath) => {
      const headers = await call({
        method: 'HEAD',
        pathname: `/containers/${encodeURIComponent(id)}/archive`,
        query: { path: containerPath },
        responseType: 'headers',
      });
      const encoded = headers?.['x-docker-container-path-stat'];
      let value;
      try {
        value = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      } catch {
        fail('Docker returned an invalid path stat', 'bot_supervisor_docker_api_error', {
          statusCode: 502,
        });
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || typeof value.name !== 'string' || !Number.isSafeInteger(value.mode)
        || value.mode < 0 || typeof value.linkTarget !== 'string') {
        fail('Docker returned an invalid path stat', 'bot_supervisor_docker_api_error', {
          statusCode: 502,
        });
      }
      return Object.freeze({
        name: value.name,
        mode: value.mode,
        linkTarget: value.linkTarget,
      });
    },
    putContainerArchive: (id, destination, archive) => call({
      method: 'PUT',
      pathname: `/containers/${encodeURIComponent(id)}/archive`,
      query: {
        path: destination,
        noOverwriteDirNonDir: '1',
        copyUIDGID: '1',
      },
      rawBody: archive,
      contentType: 'application/x-tar',
    }),
    commitSharedFile: async (id, source, destination) => {
      const created = await call({
        method: 'POST',
        pathname: `/containers/${encodeURIComponent(id)}/exec`,
        body: {
          AttachStderr: false,
          AttachStdout: false,
          Cmd: ['/usr/bin/mv', '--', source, destination],
          User: CONTAINER_USER,
          WorkingDir: '/workspace/Shared',
        },
        expected: [201],
      });
      if (!created || typeof created.Id !== 'string' || !ID_PATTERN.test(created.Id)) {
        fail('Docker returned an invalid Shared commit identity', 'bot_supervisor_docker_api_error', {
          statusCode: 502,
        });
      }
      await call({
        method: 'POST',
        pathname: `/exec/${encodeURIComponent(created.Id)}/start`,
        body: { Detach: false, Tty: false },
        responseType: 'text',
      });
      const deadline = Date.now() + SHARED_COMMIT_TIMEOUT_MS;
      let status;
      do {
        status = await call({
          method: 'GET',
          pathname: `/exec/${encodeURIComponent(created.Id)}/json`,
        });
        if (status?.Running === false) break;
        if (!status || status.Running !== true || Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, SHARED_COMMIT_POLL_MS));
      } while (true);
      if (!status || status.Running !== false || status.ExitCode !== 0) {
        fail('Docker could not atomically commit the Shared file', 'bot_supervisor_docker_api_error', {
          statusCode: 502,
        });
      }
    },
    inspectVolume: (name) => call({
      method: 'GET',
      pathname: `/volumes/${encodeURIComponent(name)}`,
    }),
    createVolume: (name, labels) => call({
      method: 'POST',
      pathname: '/volumes/create',
      body: { Name: name, Labels: labels },
      expected: [201],
    }),
    removeVolume: (name) => call({
      method: 'DELETE',
      pathname: `/volumes/${encodeURIComponent(name)}`,
      expected: [204],
    }),
  });
}

const normalizeImage = (value, key) => {
  if (typeof value !== 'string' || value.length > 512 || !IMAGE_REFERENCE_PATTERN.test(value)) {
    fail(`Configured ${key} image is invalid`, 'bot_supervisor_configuration_invalid');
  }
  return value;
};

const normalizeNetwork = (value, key) => {
  if (typeof value !== 'string' || !NETWORK_PATTERN.test(value)) {
    fail(`Configured ${key} network is invalid`, 'bot_supervisor_configuration_invalid');
  }
  return value;
};

const imageIdentity = (image, configuredReference) => {
  const repoDigests = Array.isArray(image?.RepoDigests)
    ? image.RepoDigests.filter((entry) => typeof entry === 'string').sort()
    : [];
  if (configuredReference.includes('@sha256:')) {
    if (!repoDigests.includes(configuredReference)) {
      fail('Configured image digest is not installed', 'bot_supervisor_image_mismatch', {
        statusCode: 409,
      });
    }
    return configuredReference;
  }
  const lastSlash = configuredReference.lastIndexOf('/');
  const lastColon = configuredReference.lastIndexOf(':');
  const repository = lastColon > lastSlash
    ? configuredReference.slice(0, lastColon)
    : configuredReference;
  const matchingDigest = repoDigests.find((entry) => entry.startsWith(`${repository}@sha256:`));
  if (matchingDigest) return matchingDigest;
  if (typeof image?.Id === 'string' && /^sha256:[0-9a-f]{64}$/.test(image.Id)) return image.Id;
  fail('Docker image has no verifiable identity', 'bot_supervisor_image_invalid', {
    statusCode: 409,
  });
};

const labelsContain = (actual, expected) => Object.entries(expected).every(
  ([key, value]) => actual?.[key] === value,
);

const assertOwned = ({ actual, expected, resource }) => {
  if (!labelsContain(actual, expected)) {
    fail(`Refusing to modify an unowned ${resource}`, 'bot_supervisor_ownership_refused', {
      statusCode: 409,
    });
  }
};

const baseIdentity = (deploymentId, kind, input) => ({
  deploymentId,
  botId: input.botId,
  scopeKey: input.scopeKey,
  kind,
});

const validateBaseRequest = (input) => {
  if (!ID_PATTERN.test(input.botId) || !SCOPE_PATTERN.test(input.scopeKey)) {
    fail('Bot supervisor identity is invalid', 'bot_supervisor_request_invalid', { statusCode: 400 });
  }
};

const validateGatewayUrl = (value) => {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('Bot private gateway URL is invalid', 'bot_supervisor_request_invalid', { statusCode: 400 });
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== 'host.docker.internal' || !parsed.port
    || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    fail('Bot private gateway URL is invalid', 'bot_supervisor_request_invalid', { statusCode: 400 });
  }
  return parsed.origin;
};

const validateReasoningRequest = (input) => {
  exactKeys(input, [
    'botId',
    'scopeKey',
    'runId',
    'channelId',
    'revisionId',
    'runtimeToken',
    'compiledHash',
    'gatewayUrl',
    'egressToken',
    'environmentSecretCount',
    'chatgptImageGeneration',
  ]);
  validateBaseRequest(input);
  if (!ID_PATTERN.test(input.runId) || !ID_PATTERN.test(input.channelId)
    || !ID_PATTERN.test(input.revisionId) || !RUNTIME_TOKEN_PATTERN.test(input.runtimeToken)
    || typeof input.egressToken !== 'string' || input.egressToken.length > 8_192
    || !EGRESS_TOKEN_PATTERN.test(input.egressToken)
    || !COMPILED_HASH_PATTERN.test(input.compiledHash)
    || !Number.isSafeInteger(input.environmentSecretCount)
    || input.environmentSecretCount < 0 || input.environmentSecretCount > 128
    || typeof input.chatgptImageGeneration !== 'boolean'
    || input.scopeKey !== `channel:${input.channelId}`) {
    fail('Reasoning runtime capability is invalid', 'bot_supervisor_request_invalid', {
      statusCode: 400,
    });
  }
  validateGatewayUrl(input.gatewayUrl);
};

const validateComputerRequest = (input) => {
  exactKeys(input, [
    'botId',
    'scopeKey',
    'runId',
    'channelId',
    'revisionId',
    'runtimeToken',
    'scopeMode',
    'gatewayUrl',
    'egressToken',
    'isolationTier',
  ]);
  validateBaseRequest(input);
  // A Bot has exactly one computer, so `bot:<botId>` is the only scope key a
  // computer request may carry.
  const scopeMatches = input.scopeMode === 'team' && input.scopeKey === `bot:${input.botId}`;
  if (!ID_PATTERN.test(input.runId) || !ID_PATTERN.test(input.channelId)
    || !ID_PATTERN.test(input.revisionId) || !RUNTIME_TOKEN_PATTERN.test(input.runtimeToken)
    || typeof input.egressToken !== 'string' || input.egressToken.length > 8_192
    || !EGRESS_TOKEN_PATTERN.test(input.egressToken)
    || !['standard', 'runsc'].includes(input.isolationTier)
    || !scopeMatches) {
    fail('Computer runtime capability is invalid', 'bot_supervisor_request_invalid', {
      statusCode: 400,
    });
  }
  validateGatewayUrl(input.gatewayUrl);
};

const validateTargetRequest = (input) => {
  exactKeys(input, ['kind', 'botId', 'scopeKey']);
  if (!['reasoning', 'computer'].includes(input.kind)) {
    fail('Bot runtime kind is invalid', 'bot_supervisor_request_invalid', { statusCode: 400 });
  }
  validateBaseRequest(input);
};

const reasoningHostDirectories = ({ runtimeRoot, channelId, revisionId, compiledHash, runId }) => Object.freeze({
  config: path.join(runtimeRoot, 'channels', channelId, revisionId, compiledHash),
  authFile: path.join(runtimeRoot, 'auth', runId, 'auth.json'),
  environmentFile: path.join(runtimeRoot, 'environment', runId, 'environment.json'),
  artifacts: path.join(runtimeRoot, 'artifacts', runId),
});

const volumeBindings = (kind, volumes, runtime) => (kind === 'reasoning'
  ? [
      `${volumes.opencode}:/data/opencode:rw`,
      `${runtime.authFile}:/data/opencode/auth.json:rw`,
      `${runtime.environmentFile}:/runtime-secrets/environment.json:ro`,
      `${volumes.workspace}:/workspace:rw`,
      `${volumes.shared}:/workspace/Shared:rw`,
      `${runtime.artifacts}:/workspace/.devryan:ro`,
      `${runtime.config}/skills:/workspace/.opencode/skills:ro`,
      `${runtime.config}:/runtime-config:ro`,
    ]
  : [
      `${volumes.profile}:/data/chromium:rw`,
      `${volumes.scratch}:/workspace:rw`,
      `${volumes.shared}:/workspace/Shared:rw`,
    ]);

export function createDynamicContainerSpec({
  kind,
  names,
  labels,
  image,
  network,
  runId,
  channelId,
  revisionId = null,
  runtimeToken = null,
  scopeMode = null,
  gatewayUrl,
  egressProxyUrl,
  egressToken = null,
  isolationTier = 'standard',
  environmentSecretCount = 0,
  chatgptImageGeneration = false,
  runtimeRoot,
  compiledHash = null,
}) {
  const port = BOT_CONTAINER_PORTS[kind];
  const limits = BOT_RESOURCE_LIMITS[kind];
  if (!port || !limits) {
    fail('Bot runtime kind is invalid', 'bot_supervisor_configuration_invalid');
  }
  const authenticatedEgressProxy = kind === 'reasoning'
    ? (() => {
        if (typeof egressToken !== 'string' || !EGRESS_TOKEN_PATTERN.test(egressToken)) {
          fail('Bot model egress capability is invalid', 'bot_supervisor_request_invalid', {
            statusCode: 400,
          });
        }
        const proxy = new URL(egressProxyUrl);
        proxy.username = 'devryan';
        proxy.password = egressToken;
        return proxy.toString();
      })()
    : null;
  if (kind === 'computer' && (typeof egressToken !== 'string'
    || !EGRESS_TOKEN_PATTERN.test(egressToken)
    || !['standard', 'runsc'].includes(isolationTier))) {
    fail('Bot browser egress or isolation capability is invalid', 'bot_supervisor_request_invalid', {
      statusCode: 400,
    });
  }
  const environment = kind === 'reasoning'
    ? [
        `DEVRYAN_BOT_RUN_ID=${runId}`,
        `DEVRYAN_BOT_CHANNEL_ID=${channelId}`,
        `DEVRYAN_BOT_REVISION_ID=${revisionId}`,
        `DEVRYAN_BOT_RUNTIME_TOKEN=${runtimeToken}`,
        `DEVRYAN_BOT_GATEWAY_URL=${gatewayUrl}`,
        `DEVRYAN_MODEL_EGRESS_URL=${egressProxyUrl}`,
        `DEVRYAN_BOT_ENVIRONMENT_SECRET_COUNT=${environmentSecretCount}`,
        `DEVRYAN_BOT_CHATGPT_IMAGE_GENERATION=${chatgptImageGeneration ? '1' : '0'}`,
        `HTTP_PROXY=${authenticatedEgressProxy}`,
        `HTTPS_PROXY=${authenticatedEgressProxy}`,
        'NO_PROXY=127.0.0.1,localhost,host.docker.internal',
      ]
    : [
        `DEVRYAN_BOT_RUN_ID=${runId}`,
        `DEVRYAN_BOT_CHANNEL_ID=${channelId}`,
        `DEVRYAN_BOT_REVISION_ID=${revisionId}`,
        `DEVRYAN_BOT_RUNTIME_TOKEN=${runtimeToken}`,
        `DEVRYAN_BOT_GATEWAY_URL=${gatewayUrl}`,
        `DEVRYAN_BOT_SCOPE_MODE=${scopeMode}`,
        `DEVRYAN_BROWSER_EGRESS_URL=${egressProxyUrl}`,
        `DEVRYAN_BROWSER_EGRESS_TOKEN=${egressToken}`,
        'DEVRYAN_COMPUTER_NETWORK_POLICY=proxy-only',
        'NO_PROXY=*',
      ];
  const runtimeDirectories = kind === 'reasoning'
    ? reasoningHostDirectories({ runtimeRoot, channelId, revisionId, compiledHash, runId })
    : null;
  return Object.freeze({
    Image: image,
    User: CONTAINER_USER,
    Env: environment,
    Labels: labels,
    ExposedPorts: { [port]: {} },
    // Chromium flushes its persistent profile after Browser.close; the computer
    // service waits up to ~15 s (10 s graceful + 5 s after SIGTERM) before it
    // SIGKILLs, so Docker must not kill the container before that completes.
    StopTimeout: 30,
    HostConfig: {
      AutoRemove: false,
      Binds: volumeBindings(kind, names.volumes, runtimeDirectories),
      CapDrop: ['ALL'],
      Init: true,
      LogConfig: {
        Type: 'local',
        Config: { 'max-size': '10m', 'max-file': '3' },
      },
      Memory: limits.memoryBytes,
      NanoCpus: limits.nanoCpus,
      NetworkMode: network,
      ...(kind === 'computer' && isolationTier === 'runsc' ? { Runtime: 'runsc' } : {}),
      ...(['reasoning', 'computer'].includes(kind) ? {
        ExtraHosts: ['host.docker.internal:host-gateway'],
      } : {}),
      PidsLimit: limits.pids,
      ...(kind === 'computer' ? {
        PortBindings: {
          [port]: [{ HostIp: '127.0.0.1', HostPort: '' }],
        },
      } : {}),
      ReadonlyRootfs: true,
      SecurityOpt: ['no-new-privileges:true'],
      ShmSize: limits.shmBytes,
      Tmpfs: {
        '/run': 'rw,noexec,nosuid,size=16m,mode=755',
        '/tmp': 'rw,noexec,nosuid,size=256m,mode=1777',
      },
      Ulimits: [{ Name: 'nofile', Soft: 4096, Hard: 4096 }],
    },
  });
}

const containerRunning = (container) => container?.State?.Running === true;
const containerId = (container) => container?.Id || container?.ID;

const publishedEndpoint = (container, kind) => {
  const binding = container?.NetworkSettings?.Ports?.[BOT_CONTAINER_PORTS[kind]]?.[0];
  if (!binding) return null;
  if (binding.HostIp !== '127.0.0.1' && binding.HostIp !== '::1') {
    fail('Bot runtime port is not loopback-confined', 'bot_supervisor_port_exposure_invalid', {
      statusCode: 409,
    });
  }
  const port = Number(binding.HostPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return Object.freeze({ host: binding.HostIp, port });
};

const runtimeEndpoint = (container, kind, name) => {
  if (!containerRunning(container)) return null;
  if (kind === 'reasoning') {
    return Object.freeze({ host: name, port: 4096 });
  }
  return publishedEndpoint(container, kind);
};

const inspectOrNull = async (docker, method, value) => {
  try {
    return await docker[method](...(Array.isArray(value) ? value : [value]));
  } catch (error) {
    if (isNotFound(error)) return null;
    mapDockerFailure(error);
  }
};

export function createBotDockerSupervisor({
  docker,
  deploymentId,
  images,
  reasoningNetwork = 'devryan-bots_runtime-internal',
  computerNetwork = 'devryan-bots_default',
  hostControlNetwork = 'devryan-bots-host-control',
  egressProxyUrl = 'http://egress:43121',
  runtimeRoot = '/var/lib/devryan-bots/host-runtime',
} = {}) {
  const dockerMethods = [
    'inspectImage',
    'inspectContainer',
    'listContainers',
    'createContainer',
    'startContainer',
    'stopContainer',
    'removeContainer',
    'connectContainerNetwork',
    'listContainerDirectory',
    'statContainerPath',
    'putContainerArchive',
    'streamContainerArchive',
    'inspectVolume',
    'createVolume',
    'removeVolume',
  ];
  if (!docker || dockerMethods.some((method) => typeof docker[method] !== 'function')
    || !ID_PATTERN.test(deploymentId)) {
    fail('Bot Docker supervisor configuration is invalid', 'bot_supervisor_configuration_invalid');
  }
  exactKeys(images, ['reasoning', 'computer'], 'Bot image configuration is invalid');
  const configuredImages = Object.freeze({
    reasoning: normalizeImage(images.reasoning, 'reasoning'),
    computer: normalizeImage(images.computer, 'computer'),
  });
  const assertDirectoryAncestry = async ({
    container,
    containerPath,
    authorizedRoot,
    notFoundCode,
    unsafeCode,
    label,
  }) => {
    const relative = containerPath === authorizedRoot
      ? ''
      : containerPath.slice(authorizedRoot === '/' ? 1 : authorizedRoot.length + 1);
    const segments = relative ? relative.split('/') : [];
    const ancestry = [authorizedRoot];
    for (let index = 0; index < segments.length; index += 1) {
      const suffix = segments.slice(0, index + 1).join('/');
      ancestry.push(authorizedRoot === '/' ? `/${suffix}` : `${authorizedRoot}/${suffix}`);
    }
    for (const candidate of ancestry) {
      const stat = await inspectOrNull(docker, 'statContainerPath', [container, candidate]);
      const expectedName = candidate === '/' ? null : candidate.split('/').at(-1);
      const typeBits = stat ? (((stat.mode >>> 0) & GO_FILE_MODE_TYPE_MASK) >>> 0) : null;
      if (!stat) {
        fail(`${label} path was not found`, notFoundCode, { statusCode: 404 });
      }
      if ((expectedName !== null && stat.name !== expectedName)
        || stat.linkTarget !== '' || typeBits !== GO_FILE_MODE_DIRECTORY) {
        fail(`Refusing to list an unsafe ${label} path`, unsafeCode, { statusCode: 409 });
      }
    }
  };
  const networks = Object.freeze({
    reasoning: normalizeNetwork(reasoningNetwork, 'reasoning'),
    computer: normalizeNetwork(computerNetwork, 'computer'),
    hostControl: normalizeNetwork(hostControlNetwork, 'host control'),
  });
  if (typeof runtimeRoot !== 'string' || !path.posix.isAbsolute(runtimeRoot)
    || runtimeRoot.length > 2_048 || /[:\u0000\r\n]/u.test(runtimeRoot)
    || path.posix.normalize(runtimeRoot) !== runtimeRoot) {
    fail('Bot host runtime root is invalid', 'bot_supervisor_configuration_invalid');
  }
  for (const value of [egressProxyUrl]) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      fail('Bot service URL configuration is invalid', 'bot_supervisor_configuration_invalid');
    }
    if (parsed.protocol !== 'http:' || parsed.hostname !== 'egress' || parsed.port !== '43121'
      || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      fail('Bot service URL configuration is invalid', 'bot_supervisor_configuration_invalid');
    }
  }

  const locks = new Map();

  const withLock = (key, operation) => {
    const previous = locks.get(key) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tracked = current.finally(() => {
      if (locks.get(key) === tracked) locks.delete(key);
    });
    locks.set(key, tracked);
    return tracked;
  };

  const identityFor = (kind, input) => baseIdentity(deploymentId, kind, input);

  const expectedOwnershipLabels = (identity) => {
    const names = deriveBotResourceNames(identity);
    return {
      'devryan.runtime': BOT_RUNTIME_LABEL,
      'devryan.deployment': identity.deploymentId,
      'devryan.bot': identity.botId,
      'devryan.scope': names.scopeDigest,
      'devryan.kind': identity.kind,
    };
  };

  const ensureVolume = async ({ name, role, identity }) => {
    const labels = buildBotVolumeLabels({ ...identity, volumeRole: role });
    let existing = await inspectOrNull(docker, 'inspectVolume', name);
    if (!existing) {
      try {
        await docker.createVolume(name, labels);
      } catch (error) {
        if (error?.dockerStatusCode !== 409) mapDockerFailure(error);
      }
      existing = await inspectOrNull(docker, 'inspectVolume', name);
      if (!existing) {
        fail('Docker did not create the Bot volume', 'bot_supervisor_docker_api_error', {
          statusCode: 502,
        });
      }
    }
    assertOwned({ actual: existing.Labels, expected: labels, resource: 'volume' });
  };

  const ensureSharedVolume = async ({ name, identity }) => {
    const labels = buildBotSharedVolumeLabels({
      deploymentId: identity.deploymentId,
      botId: identity.botId,
    });
    let existing = await inspectOrNull(docker, 'inspectVolume', name);
    if (!existing) {
      try {
        await docker.createVolume(name, labels);
      } catch (error) {
        if (error?.dockerStatusCode !== 409) mapDockerFailure(error);
      }
      existing = await inspectOrNull(docker, 'inspectVolume', name);
      if (!existing) {
        fail('Docker did not create the Bot shared volume', 'bot_supervisor_docker_api_error', {
          statusCode: 502,
        });
      }
    }
    assertOwned({ actual: existing.Labels, expected: labels, resource: 'volume' });
  };

  const ensureVolumes = async (identity, names) => {
    for (const [roleKey, name] of Object.entries(names.volumes)) {
      if (roleKey === 'shared') {
        await ensureSharedVolume({ name, identity });
        continue;
      }
      const role = roleKey.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
      await ensureVolume({ name, role, identity });
    }
  };

  const inspectOwnedContainer = async (identity, names) => {
    const existing = await inspectOrNull(docker, 'inspectContainer', names.container);
    if (!existing) return null;
    assertOwned({
      actual: existing.Config?.Labels,
      expected: expectedOwnershipLabels(identity),
      resource: 'container',
    });
    return existing;
  };

  const ensureInternal = async (kind, input) => {
    const identity = identityFor(kind, input);
    const names = deriveBotResourceNames(identity);
    const image = configuredImages[kind];
    let inspectedImage;
    try {
      inspectedImage = await docker.inspectImage(image);
    } catch (error) {
      mapDockerFailure(error);
    }
    const desiredImageIdentity = imageIdentity(inspectedImage, image);
    const ownershipLabels = buildBotOwnershipLabels({ ...identity, imageIdentity: desiredImageIdentity });
    const labels = {
      ...ownershipLabels,
      'devryan.revision': input.revisionId,
      'devryan.run': `sha256:${crypto.createHash('sha256').update(input.runId).digest('hex')}`,
      'devryan.channel': `sha256:${crypto.createHash('sha256').update(input.channelId).digest('hex')}`,
      'devryan.capability': `sha256:${crypto.createHash('sha256').update(input.runtimeToken).digest('hex')}`,
      ...(kind === 'reasoning' ? { 'devryan.config': input.compiledHash } : {}),
      ...(kind === 'computer' ? { 'devryan.scope-mode': input.scopeMode } : {}),
      ...(kind === 'computer' ? {
        'devryan.egress-capability': `sha256:${crypto.createHash('sha256').update(input.egressToken).digest('hex')}`,
        'devryan.isolation': input.isolationTier,
      } : {}),
    };
    let existing = await inspectOwnedContainer(identity, names);
    await ensureVolumes(identity, names);
    let replaced = false;

    const rotationLabels = [
      'devryan.image',
      'devryan.capability',
      ...(kind === 'reasoning' ? ['devryan.revision', 'devryan.run', 'devryan.channel', 'devryan.config'] : []),
      // The computer is per-Bot, long-lived, signed-in infrastructure. A revision
      // bump alone must not recreate it (that restarts Chromium and drops session
      // state); browser egress policy changes reach the running container through
      // in-place capability rotation, while scope and isolation changes still
      // rotate the container.
      ...(kind === 'computer' ? [
        'devryan.scope-mode',
        'devryan.isolation',
      ] : []),
    ];
    const replacementRequired = existing && rotationLabels.some(
      (label) => existing.Config?.Labels?.[label] !== labels[label],
    );
    if (replacementRequired) {
      if (containerRunning(existing)) await docker.stopContainer(containerId(existing));
      await docker.removeContainer(containerId(existing));
      existing = null;
      replaced = true;
    }

    if (!existing) {
      const config = createDynamicContainerSpec({
        kind,
        names,
        labels,
        image,
        network: networks[kind],
        runId: input.runId,
        channelId: input.channelId,
        revisionId: input.revisionId,
        runtimeToken: input.runtimeToken,
        scopeMode: kind === 'computer' ? input.scopeMode : null,
        gatewayUrl: input.gatewayUrl,
        egressProxyUrl,
        egressToken: input.egressToken,
        isolationTier: kind === 'computer' ? input.isolationTier : 'standard',
        environmentSecretCount: kind === 'reasoning' ? input.environmentSecretCount : 0,
        chatgptImageGeneration: kind === 'reasoning' ? input.chatgptImageGeneration : false,
        runtimeRoot,
        compiledHash: kind === 'reasoning' ? input.compiledHash : null,
      });
      try {
        const created = await docker.createContainer(names.container, config);
        if (['reasoning', 'computer'].includes(kind)) {
          await docker.connectContainerNetwork(networks.hostControl, created.Id);
        }
        await docker.startContainer(created.Id);
      } catch (error) {
        mapDockerFailure(error);
      }
      existing = await docker.inspectContainer(names.container);
    } else {
      if (['reasoning', 'computer'].includes(kind)
        && !Object.hasOwn(existing.NetworkSettings?.Networks || {}, networks.hostControl)) {
        await docker.connectContainerNetwork(networks.hostControl, containerId(existing));
      }
      if (!containerRunning(existing)) {
        await docker.startContainer(containerId(existing));
        existing = await docker.inspectContainer(names.container);
      }
    }

    const endpoint = runtimeEndpoint(existing, kind, names.container);
    if (!endpoint) {
      fail('Docker did not publish the Bot runtime port', 'bot_supervisor_port_unavailable', {
        statusCode: 502,
      });
    }
    return Object.freeze({
      kind,
      name: names.container,
      state: 'running',
      endpoint,
      image: desiredImageIdentity,
      replaced,
    });
  };

  const ensure = (kind, input) => {
    if (kind === 'reasoning') validateReasoningRequest(input);
    else if (kind === 'computer') validateComputerRequest(input);
    else fail('Bot runtime kind is invalid', 'bot_supervisor_request_invalid', { statusCode: 400 });
    const names = deriveBotResourceNames(identityFor(kind, input));
    const key = names.container;
    return withLock(key, () => ensureInternal(kind, input));
  };

  const status = async (input) => {
    validateTargetRequest(input);
    const identity = identityFor(input.kind, input);
    const names = deriveBotResourceNames(identity);
    const existing = await inspectOwnedContainer(identity, names);
    if (!existing) return Object.freeze({ kind: input.kind, name: names.container, state: 'absent' });
    return Object.freeze({
      kind: input.kind,
      name: names.container,
      state: containerRunning(existing) ? 'running' : 'stopped',
      endpoint: runtimeEndpoint(existing, input.kind, names.container),
      image: existing.Config?.Labels?.['devryan.image'] || null,
    });
  };

  const stop = (input) => {
    validateTargetRequest(input);
    const identity = identityFor(input.kind, input);
    const names = deriveBotResourceNames(identity);
    return withLock(names.container, async () => {
      const existing = await inspectOwnedContainer(identity, names);
      if (!existing) return Object.freeze({ state: 'absent', name: names.container });
      if (containerRunning(existing)) await docker.stopContainer(containerId(existing));
      return Object.freeze({ state: 'stopped', name: names.container });
    });
  };

  const writeWorkspace = async (input) => {
    exactKeys(input, ['botId', 'scopeKey', 'path', 'content']);
    validateBaseRequest(input);
    const channelId = input.scopeKey.startsWith('channel:')
      ? input.scopeKey.slice('channel:'.length)
      : '';
    if (!ID_PATTERN.test(channelId)) {
      fail('Bot workspace scope is invalid', 'bot_supervisor_request_invalid', { statusCode: 400 });
    }
    let file;
    try {
      file = buildBotWorkspaceFileArchive({ path: input.path, content: input.content });
    } catch (error) {
      fail(error?.message || 'Bot workspace file is invalid', error?.code || 'bot_supervisor_request_invalid', {
        statusCode: 400,
      });
    }
    const identity = identityFor('reasoning', input);
    const names = deriveBotResourceNames(identity);
    return withLock(names.container, async () => {
      const existing = await inspectOwnedContainer(identity, names);
      if (!existing) {
        fail('Bot reasoning workspace is unavailable', 'bot_supervisor_workspace_unavailable', {
          statusCode: 409,
        });
      }
      const container = containerId(existing);
      const destination = `/workspace/${file.path}`;
      const stat = await inspectOrNull(docker, 'statContainerPath', [container, destination]);
      if (stat && (stat.name !== file.path || stat.linkTarget !== ''
        || (stat.mode & 0xf8000000) !== 0)) {
        fail('Refusing to replace a non-regular Bot workspace entry', 'bot_supervisor_workspace_path_unsafe', {
          statusCode: 409,
        });
      }
      try {
        await docker.putContainerArchive(container, '/workspace', file.archive);
      } catch (error) {
        mapDockerFailure(error);
      } finally {
        file.archive.fill(0);
      }
      return Object.freeze({
        written: true,
        path: file.path,
        bytes: file.bytes,
        sha256: file.sha256,
      });
    });
  };

  const importSharedFile = async (input) => {
    exactKeys(input, [
      'botId', 'scopeKey', 'channelId', 'messageId', 'filename',
      'contentBase64', 'expectedSize', 'sha256',
      ...(Object.hasOwn(input, 'resourcePath') ? ['resourcePath'] : []),
    ]);
    validateBaseRequest(input);
    if (input.scopeKey !== `bot:${input.botId}`) {
      fail('Bot shared file scope is invalid', 'bot_supervisor_request_invalid', { statusCode: 400 });
    }
    let file;
    const filename = input.filename;
    const stagingFilename = `devryan-import-${input.sha256}.tmp`;
    try {
      file = input.resourcePath
        ? buildBotResourceFileArchive(input)
        : buildBotSharedFileArchive({ ...input, filename: stagingFilename });
    } catch (error) {
      fail(error?.message || 'Bot shared file is invalid', 'bot_supervisor_shared_file_invalid', {
        statusCode: 400,
      });
    }
    const identity = identityFor('computer', input);
    const names = deriveBotResourceNames(identity);
    return withLock(names.container, async () => {
      const existing = await inspectOwnedContainer(identity, names);
      if (!existing || !containerRunning(existing)) {
        fail('Bot computer is unavailable for Shared import', 'bot_supervisor_workspace_unavailable', {
          statusCode: 409,
        });
      }
      const container = containerId(existing);
      if (input.resourcePath) {
        const destination = `/workspace/${file.path}`;
        const current = await inspectOrNull(docker, 'statContainerPath', [container, destination]);
        if (current && (current.name !== filename || current.linkTarget !== ''
          || (current.mode & 0xf8000000) !== 0)) {
          fail('Refusing to replace an unsafe Bot resource entry', 'bot_supervisor_workspace_path_unsafe', {
            statusCode: 409,
          });
        }
        try {
          await docker.putContainerArchive(container, '/workspace', file.archive);
          const verified = await docker.streamContainerArchive(
            container,
            destination,
            createBotSharedFileVerifier({
              expectedFilename: filename,
              expectedSize: file.bytes,
              expectedSha256: file.sha256,
            }),
          );
          return Object.freeze({
            written: true,
            path: destination,
            bytes: verified.size,
            sha256: verified.sha256,
          });
        } catch (error) {
          if (error?.code?.startsWith('bot_supervisor_')) throw error;
          return mapDockerFailure(error);
        }
      }
      const directory = `${input.channelId}/${input.messageId}`;
      const stagedDestination = `/workspace/Shared/${file.path}`;
      const destination = `/workspace/Shared/${directory}/${filename}`;
      const current = await inspectOrNull(docker, 'statContainerPath', [container, destination]);
      if (current && (current.name !== filename || current.linkTarget !== ''
        || (current.mode & 0xf8000000) !== 0)) {
        fail('Refusing to replace an unsafe Bot Shared entry', 'bot_supervisor_workspace_path_unsafe', {
          statusCode: 409,
        });
      }
      try {
        await docker.putContainerArchive(container, '/workspace/Shared', file.archive);
        await docker.streamContainerArchive(
          container,
          stagedDestination,
          createBotSharedFileVerifier({
            expectedFilename: stagingFilename,
            expectedSize: file.bytes,
            expectedSha256: file.sha256,
          }),
        );
        await docker.commitSharedFile(container, stagedDestination, destination);
        const verified = await docker.streamContainerArchive(
          container,
          destination,
          createBotSharedFileVerifier({
            expectedFilename: filename,
            expectedSize: file.bytes,
            expectedSha256: file.sha256,
          }),
        );
        return Object.freeze({
          written: true,
          path: destination,
          bytes: verified.size,
          sha256: verified.sha256,
        });
      } catch (error) {
        if (error?.code?.startsWith('bot_supervisor_')) throw error;
        return mapDockerFailure(error);
      }
    }).finally(() => file.archive.fill(0));
  };

  const exportWorkspaceImage = async (input) => {
    exactKeys(input, ['botId', 'scopeKey', 'path']);
    validateBaseRequest(input);
    const channelId = input.scopeKey.startsWith('channel:')
      ? input.scopeKey.slice('channel:'.length)
      : '';
    if (!ID_PATTERN.test(channelId)) {
      fail('Bot generated image scope is invalid', 'bot_supervisor_request_invalid', { statusCode: 400 });
    }
    let containerPath;
    try {
      containerPath = resolveBotGeneratedImagePath(input.path);
    } catch (error) {
      fail(error?.message || 'Generated image path is invalid', 'bot_image_publication_failed', {
        statusCode: 400,
      });
    }
    if (containerPath === '/workspace') {
      fail('Generated image path is invalid', 'bot_image_publication_failed', { statusCode: 400 });
    }
    const identity = identityFor('reasoning', input);
    const names = deriveBotResourceNames(identity);
    return withLock(names.container, async () => {
      const existing = await inspectOwnedContainer(identity, names);
      if (!existing || !containerRunning(existing)) {
        fail('Generated image runtime is unavailable', 'bot_image_publication_failed', {
          statusCode: 409,
        });
      }
      const filename = containerPath.split('/').at(-1);
      const container = containerId(existing);
      const relativeSegments = input.path.split('/');
      const ancestry = ['/workspace'];
      for (let index = 0; index < relativeSegments.length; index += 1) {
        ancestry.push(`/workspace/${relativeSegments.slice(0, index + 1).join('/')}`);
      }
      for (const [index, candidate] of ancestry.entries()) {
        const stat = await inspectOrNull(docker, 'statContainerPath', [container, candidate]);
        const isTarget = index === ancestry.length - 1;
        const expectedName = candidate.split('/').at(-1);
        const typeBits = stat ? (((stat.mode >>> 0) & GO_FILE_MODE_TYPE_MASK) >>> 0) : null;
        const validType = isTarget ? typeBits === 0 : typeBits === GO_FILE_MODE_DIRECTORY;
        if (!stat || stat.name !== expectedName || stat.linkTarget !== '' || !validType) {
          fail('Generated image is not a regular owned workspace file', 'bot_image_publication_failed', {
            statusCode: 409,
          });
        }
      }
      const verified = await docker.streamContainerArchive(
        container,
        containerPath,
        createBotGeneratedImageVerifier({ expectedFilename: filename }),
      );
      try {
        return Object.freeze({
          path: input.path,
          filename,
          contentType: verified.contentType,
          size: verified.size,
          sha256: verified.sha256,
          contentBase64: verified.bytes.toString('base64'),
        });
      } finally {
        verified.bytes.fill(0);
      }
    });
  };

  // Read-only view of what a Bot has on its computer. The reasoning kind is
  // accepted too so a channel workspace can be inspected, but the UI defaults
  // to the computer because that is the Bot-wide surface.
  const listWorkspace = async (input) => {
    exactKeys(input, ['kind', 'botId', 'scopeKey', 'path']);
    validateTargetRequest({ kind: input.kind, botId: input.botId, scopeKey: input.scopeKey });
    let containerPath;
    try {
      containerPath = resolveBotWorkspacePath(input.path);
    } catch (error) {
      fail(
        error?.message || 'Bot workspace path is invalid',
        error?.code || 'bot_supervisor_workspace_path_unsafe',
        { statusCode: error?.statusCode || 400 },
      );
    }
    const identity = identityFor(input.kind, input);
    const names = deriveBotResourceNames(identity);
    const existing = await inspectOwnedContainer(identity, names);
    if (!existing) {
      fail('Bot workspace is unavailable', 'bot_supervisor_workspace_unavailable', {
        statusCode: 409,
      });
    }
    const state = containerRunning(existing) ? 'running' : 'stopped';
    const container = containerId(existing);
    await assertDirectoryAncestry({
      container,
      containerPath,
      authorizedRoot: '/workspace',
      notFoundCode: 'bot_supervisor_workspace_not_found',
      unsafeCode: 'bot_supervisor_workspace_path_unsafe',
      label: 'Bot workspace',
    });
    try {
      const listing = await docker.streamContainerArchive(
        container,
        containerPath,
        createBotWorkspaceListingParser({ maxEntries: BOT_WORKSPACE_LISTING_MAX_ENTRIES }),
      );
      const currentPath = containerPath.slice('/workspace'.length).replace(/^\//, '');
      return Object.freeze({
        state,
        path: currentPath,
        entries: Object.freeze(listing.entries.map((entry) => Object.freeze({
          ...entry,
          path: currentPath ? `${currentPath}/${entry.name}` : entry.name,
        }))),
        truncated: listing.truncated,
      });
    } catch (error) {
      if (error?.code?.startsWith('bot_supervisor_')) throw error;
      return mapDockerFailure(error);
    }
  };

  const listFilesystem = async (input) => {
    exactKeys(input, ['kind', 'botId', 'scopeKey', 'path']);
    validateTargetRequest({ kind: input.kind, botId: input.botId, scopeKey: input.scopeKey });
    if (input.kind !== 'computer') {
      fail('Bot container listing requires the computer runtime', 'bot_supervisor_request_invalid', {
        statusCode: 400,
      });
    }
    let containerPath;
    try {
      containerPath = resolveBotContainerPath(input.path);
    } catch (error) {
      fail(
        error?.message || 'Bot container path is invalid',
        error?.code || 'bot_supervisor_filesystem_path_unsafe',
        { statusCode: error?.statusCode || 400 },
      );
    }
    const identity = identityFor('computer', input);
    const names = deriveBotResourceNames(identity);
    const existing = await inspectOwnedContainer(identity, names);
    if (!existing) {
      fail('Bot computer is unavailable', 'bot_supervisor_workspace_unavailable', {
        statusCode: 409,
      });
    }
    const state = containerRunning(existing) ? 'running' : 'stopped';
    const container = containerId(existing);
    if (state !== 'running') {
      fail('Bot computer must be running to browse its container',
        'bot_supervisor_workspace_unavailable', { statusCode: 409 });
    }
    await assertDirectoryAncestry({
      container,
      containerPath,
      authorizedRoot: '/',
      notFoundCode: 'bot_supervisor_workspace_not_found',
      unsafeCode: 'bot_supervisor_filesystem_path_unsafe',
      label: 'Bot container',
    });
    try {
      const listing = await docker.listContainerDirectory(container, containerPath);
      const currentPath = containerPath === '/' ? '' : containerPath.slice(1);
      return Object.freeze({
        state,
        path: currentPath,
        entries: Object.freeze(listing.entries.map((entry) => {
          const absolutePath = path.posix.join(containerPath, entry.name);
          return Object.freeze({
            path: currentPath ? `${currentPath}/${entry.name}` : entry.name,
            name: entry.name,
            kind: entry.kind,
            size: entry.size,
            mode: entry.mode,
            modifiedAt: entry.modifiedAt,
            restricted: entry.unreadable
              || entry.kind === 'symlink'
              || entry.kind === 'special'
              || isBotContainerPathRestricted(absolutePath),
          });
        }).sort((left, right) => {
          if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
          return left.name.localeCompare(right.name);
        })),
        truncated: listing.truncated,
      });
    } catch (error) {
      if (error?.code?.startsWith('bot_supervisor_')) throw error;
      return mapDockerFailure(error);
    }
  };

  const reset = (input) => {
    exactKeys(input, ['kind', 'botId', 'scopeKey', 'resource']);
    validateTargetRequest({ kind: input.kind, botId: input.botId, scopeKey: input.scopeKey });
    const identity = identityFor(input.kind, input);
    const names = deriveBotResourceNames(identity);
    const allowed = input.kind === 'reasoning'
      ? new Set(['opencode', 'workspace', 'runtime-config', 'all'])
      : new Set(['profile', 'scratch', 'shared', 'all']);
    if (!allowed.has(input.resource)) {
      fail('Bot reset resource is invalid', 'bot_supervisor_request_invalid', { statusCode: 400 });
    }
    return withLock(names.container, async () => {
      const existing = await inspectOwnedContainer(identity, names);
      const selected = Object.entries(names.volumes).filter(([role]) => {
        const normalized = role.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
        return (input.resource === 'all' && normalized !== 'shared')
          || normalized === input.resource;
      });
      const ownedVolumes = [];
      for (const [roleKey, name] of selected) {
        const role = roleKey.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
        const volume = await inspectOrNull(docker, 'inspectVolume', name);
        if (!volume) continue;
        assertOwned({
          actual: volume.Labels,
          expected: role === 'shared'
            ? buildBotSharedVolumeLabels({ deploymentId: identity.deploymentId, botId: identity.botId })
            : buildBotVolumeLabels({ ...identity, volumeRole: role }),
          resource: 'volume',
        });
        ownedVolumes.push({ name, role });
      }
      if (existing) {
        if (containerRunning(existing)) await docker.stopContainer(containerId(existing));
        await docker.removeContainer(containerId(existing));
      }
      const removed = [];
      for (const { name, role } of ownedVolumes) {
        await docker.removeVolume(name);
        removed.push(role);
      }
      return Object.freeze({ state: 'reset', name: names.container, removed: Object.freeze(removed) });
    });
  };

  const listOwned = async () => {
    let rows;
    try {
      rows = await docker.listContainers([
        `devryan.runtime=${BOT_RUNTIME_LABEL}`,
        `devryan.deployment=${deploymentId}`,
      ]);
    } catch (error) {
      mapDockerFailure(error);
    }
    if (!Array.isArray(rows)) {
      fail('Docker returned an invalid container list', 'bot_supervisor_docker_api_error', {
        statusCode: 502,
      });
    }
    return rows.map((row) => Object.freeze({
      id: row.Id || row.ID,
      names: Array.isArray(row.Names) ? [...row.Names] : [],
      kind: row.Labels?.['devryan.kind'] || null,
      botId: row.Labels?.['devryan.bot'] || null,
      scope: row.Labels?.['devryan.scope'] || null,
      image: row.Labels?.['devryan.image'] || null,
      state: row.State || null,
    }));
  };

  return Object.freeze({
    ensureReasoning: (input) => ensure('reasoning', input),
    ensureComputer: (input) => ensure('computer', input),
    status,
    stop,
    reset,
    writeWorkspace,
    importSharedFile,
    exportWorkspaceImage,
    listWorkspace,
    listFilesystem,
    listOwned,
  });
}
