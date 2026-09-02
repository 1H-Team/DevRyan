import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  createRuntimeToken,
  normalizeBrowserHosts,
  normalizeModelHosts,
} from '@openchamber/bot-egress/token';

import {
  BOT_RUNTIME_IMAGE_KEYS,
  BotRuntimeManifestError,
  validateInstalledBotRuntimeManifest,
} from './bot-runtime-manifest.mjs';

export const BOT_RUNTIME_COMPOSE_PROJECT = 'devryan-bots';
export const BOT_RUNTIME_STATE_VERSION = 1;

const execFileAsync = promisify(execFile);
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const DEFAULT_BOT_RUNTIME_READY_DEADLINE_MS = 15 * 60_000;
const DEFAULT_SERVICE_HEALTH_TIMEOUT_MS = 90_000;
const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;
const ENGINE_MEMORY_PROBE_TTL_MS = 5 * 60_000;
// Docker Desktop hands every container the memory of one shared VM. These
// numbers mirror the per-container limits in
// packages/bot-supervisor/src/docker.js (BOT_RESOURCE_LIMITS) and
// docker/bots/compose.yml; the preflight below only warns, it never blocks.
export const BOT_RUNTIME_ENGINE_MEMORY_POLICY = Object.freeze({
  minimumBytes: 6 * GIB,
  recommendedBytes: 8 * GIB,
  containerLimitBytes: Object.freeze({
    reasoning: 2 * GIB,
    computer: 3 * GIB,
    indexer: GIB,
    supervisor: 256 * MIB,
    'engine-proxy': 256 * MIB,
    egress: 256 * MIB,
  }),
});

const formatGib = (bytes) => {
  const value = bytes / GIB;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
};

export const evaluateBotRuntimeEngineMemory = (
  memTotalBytes,
  policy = BOT_RUNTIME_ENGINE_MEMORY_POLICY,
) => {
  if (!Number.isSafeInteger(memTotalBytes) || memTotalBytes <= 0) return [];
  const warnings = [];
  const available = formatGib(memTotalBytes);
  if (memTotalBytes < policy.minimumBytes) {
    warnings.push({
      code: 'docker_memory_low',
      message: `Docker Desktop gives containers ${available} GiB of memory; Bots need at least `
        + `${formatGib(policy.minimumBytes)} GiB (${formatGib(policy.recommendedBytes)} GiB recommended). `
        + 'Raise the memory limit in Docker Desktop Settings > Resources.',
    });
  }
  const exceeding = Object.entries(policy.containerLimitBytes)
    .filter(([, limitBytes]) => limitBytes > memTotalBytes)
    .map(([kind, limitBytes]) => `${kind} (${formatGib(limitBytes)} GiB)`);
  if (exceeding.length > 0) {
    warnings.push({
      code: 'docker_memory_below_limits',
      message: `Bot containers may use more memory than the ${available} GiB Docker Desktop provides: `
        + `${exceeding.join(', ')}. Runs can be stopped under memory pressure.`,
    });
  }
  return warnings;
};
const SERVICE_HEALTH_POLL_INTERVAL_MS = 1_000;
const MAX_READY_TRANSITIONS = 3;
const FIXED_DOCKER_CANDIDATES = Object.freeze([
  '/opt/homebrew/bin/docker',
  '/usr/local/bin/docker',
  '/Applications/Docker.app/Contents/Resources/bin/docker',
]);
const FIXED_SERVICES = Object.freeze(['supervisor', 'engine-proxy', 'egress', 'indexer']);
const IMAGE_ENVIRONMENT_KEYS = Object.freeze({
  supervisor: 'DEVRYAN_BOT_SUPERVISOR_IMAGE',
  'engine-proxy': 'DEVRYAN_BOT_ENGINE_PROXY_IMAGE',
  egress: 'DEVRYAN_BOT_EGRESS_IMAGE',
  indexer: 'DEVRYAN_BOT_INDEXER_IMAGE',
  opencode: 'DEVRYAN_BOT_OPENCODE_IMAGE',
  computer: 'DEVRYAN_BOT_COMPUTER_IMAGE',
});
const SERVICE_ENVIRONMENT_KEYS = Object.freeze([
  'DEVRYAN_BOT_SUPERVISOR_TOKEN',
  'DEVRYAN_BOT_ENGINE_PROXY_TOKEN',
  'DEVRYAN_BOT_EGRESS_SIGNING_KEY',
  'DEVRYAN_BOT_EGRESS_CONTROL_TOKEN',
  'DEVRYAN_BOT_INDEXER_TOKEN',
  'DEVRYAN_BOT_DEPLOYMENT_ID',
  'DEVRYAN_DOCKER_SOCKET_GID',
  'DEVRYAN_BOT_HOST_RUNTIME_ROOT',
]);
const BASE64URL_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEPLOYMENT_ID_PATTERN = /^deployment-[0-9a-f]{24}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCOPE_PATTERN = /^(?:channel|bot):[0-9a-f-]{36}(?::user:[0-9a-f-]{36})?$/i;
const RUNTIME_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const COMPILED_HASH_PATTERN = /^[0-9a-f]{64}$/;
const SHARED_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHARED_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SHARED_FILE_MAX_BYTES = 25 * 1024 * 1024;
const SUPERVISOR_PORT = '43120';
const EGRESS_PORT = '43121';
const INDEXER_PORT = '43123';
const SUPERVISOR_RESPONSE_LIMIT = 1024 * 1024;
const GENERATED_IMAGE_RESPONSE_LIMIT = 14 * 1024 * 1024;
const INDEXER_REQUEST_LIMIT = 64 * 1024 * 1024;
const AGENT_EGRESS_REQUEST_LIMIT = 256 * 1024;
const COMPUTER_EGRESS_ROTATION_ATTEMPTS = 30;
const COMPUTER_EGRESS_ROTATION_INTERVAL_MS = 250;
const SCOPED_ARTIFACT_FILE_LIMIT = 1_001;
const SCOPED_ARTIFACT_BYTE_LIMIT = 101 * 1024 * 1024;
const SCOPED_SKILL_FILE_LIMIT = 128;
const SCOPED_SKILL_FILE_BYTE_LIMIT = 256 * 1024;
const SCOPED_SKILL_TOTAL_BYTE_LIMIT = 2 * 1024 * 1024;
const ENVIRONMENT_SECRET_FILE_LIMIT = 300 * 1024;
const ENVIRONMENT_SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const ENVIRONMENT_SECRET_RESERVED = new Set([
  'HOME', 'PATH', 'SHELL', 'USER', 'LOGNAME', 'PWD', 'OLDPWD',
  'NODE_OPTIONS', 'NODE_PATH', 'BUN_OPTIONS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
]);
const isReservedEnvironmentSecretName = (name) => {
  const upper = name.toUpperCase();
  return upper.startsWith('DEVRYAN_') || upper.startsWith('OPENCODE_')
    || upper.startsWith('XDG_') || upper.endsWith('_PROXY')
    || ENVIRONMENT_SECRET_RESERVED.has(upper);
};
const BROWSER_PROFILE_ARCHIVE_FORMAT = 'DevRyan.BotBrowserProfiles';
const BROWSER_PROFILE_ARCHIVE_VERSION = 1;
const BROWSER_PROFILE_ARCHIVE_LIMIT = 250 * 1024 * 1024;
const BROWSER_PROFILE_RAW_LIMIT = 180 * 1024 * 1024;
const BROWSER_PROFILE_EXPANDED_LIMIT = 1024 * 1024 * 1024;
const BROWSER_PROFILE_ENTRY_LIMIT = 100_000;
const BROWSER_PROFILE_SCOPE_LIMIT = 500;
const BROWSER_PROFILE_VOLUME_PATTERN = /^devryan-bot-computer-([0-9a-f]{24})-profile$/;
const SUPERVISOR_OPERATIONS = Object.freeze({
  ensureReasoning: '/v1/ensure/reasoning',
  ensureComputer: '/v1/ensure/computer',
  inspect: '/v1/status',
  stop: '/v1/stop',
  reset: '/v1/reset',
  writeWorkspace: '/v1/workspace/write',
  importSharedFile: '/v1/shared/import',
  exportWorkspaceImage: '/v1/workspace/export-image',
  listWorkspace: '/v1/workspace/list',
  listFilesystem: '/v1/filesystem/list',
});
const INDEXER_OPERATIONS = Object.freeze({
  status: Object.freeze({ method: 'GET', pathname: '/v1/status' }),
  upsert: Object.freeze({ method: 'POST', pathname: '/v1/upsert' }),
  delete: Object.freeze({ method: 'POST', pathname: '/v1/delete' }),
  search: Object.freeze({ method: 'POST', pathname: '/v1/search' }),
  rebuild: Object.freeze({ method: 'POST', pathname: '/v1/rebuild' }),
});

export class BotRuntimeManagerError extends Error {
  constructor(message, code, diagnostics = null) {
    super(message);
    this.name = 'BotRuntimeManagerError';
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export async function resolveDockerSocketSupplementalGid({
  platform = process.platform,
  stat = fs.stat,
} = {}) {
  // Docker Desktop virtualizes the macOS socket bind into its Linux VM as
  // root:root. The macOS symlink target's host group is therefore not the
  // group visible to the non-root supervisor container.
  if (platform === 'darwin') return 0;
  try {
    const socket = await stat('/var/run/docker.sock');
    return Number.isInteger(socket?.gid) && socket.gid >= 0 && socket.gid <= 2 ** 31 - 1
      ? socket.gid
      : 0;
  } catch {
    return 0;
  }
}

const fail = (message, code) => {
  throw new BotRuntimeManagerError(message, code);
};

const classifyImagePullFailure = (key, result) => {
  const output = `${result?.stderr || ''}\n${result?.stdout || ''}`
    .replace(/[\r\n\0]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2_000);
  if (/unauthorized|authentication required|access denied|denied:|forbidden|insufficient[_ ]scope/i.test(output)) {
    return `Bot runtime image ${key} is not publicly accessible. Install the latest DevRyan update or contact the release administrator.`;
  }
  if (/manifest unknown|name unknown|not found|no such manifest/i.test(output)) {
    return `Bot runtime image ${key} is missing from this DevRyan release. Install the latest DevRyan update or contact the release administrator.`;
  }
  if (/timed? out|timeout|network is unreachable|temporary failure|connection (?:reset|refused)|tls handshake timeout|no such host|server misbehaving/i.test(output)) {
    return `Bot runtime image ${key} could not be downloaded because the registry is unreachable. Check the network connection and try again.`;
  }
  return `Unable to download Bot runtime image ${key}. Try again or install the latest DevRyan update.`;
};

export function deriveBotRuntimeServiceEnvironment(deploymentKey, {
  dockerSocketGid = 0,
  hostRuntimeRoot = '/var/lib/devryan-bots/host-runtime',
} = {}) {
  if (!Buffer.isBuffer(deploymentKey) || deploymentKey.byteLength !== 32
    || !Number.isInteger(dockerSocketGid) || dockerSocketGid < 0 || dockerSocketGid > 2 ** 31 - 1
    || typeof hostRuntimeRoot !== 'string' || !path.isAbsolute(hostRuntimeRoot)
    || path.normalize(hostRuntimeRoot) !== hostRuntimeRoot || hostRuntimeRoot.length > 2_048
    || /[:\u0000\r\n]/u.test(hostRuntimeRoot)) {
    fail('Bot runtime service secret input is invalid', 'bot_runtime_secret_invalid');
  }
  const derive = (purpose) => crypto.createHmac('sha256', deploymentKey)
    .update(`devryan-production-bots/${purpose}/v1`, 'utf8')
    .digest();
  const deploymentDigest = derive('deployment-id');
  const supervisorToken = derive('supervisor-auth');
  const engineProxyToken = derive('engine-proxy-auth');
  const egressSigningKey = derive('egress-signing');
  const egressControlToken = derive('egress-control');
  const indexerToken = derive('indexer-auth');
  try {
    return Object.freeze({
      DEVRYAN_BOT_DEPLOYMENT_ID: `deployment-${deploymentDigest.toString('hex').slice(0, 24)}`,
      DEVRYAN_BOT_SUPERVISOR_TOKEN: supervisorToken.toString('base64url'),
      DEVRYAN_BOT_ENGINE_PROXY_TOKEN: engineProxyToken.toString('base64url'),
      DEVRYAN_BOT_EGRESS_SIGNING_KEY: egressSigningKey.toString('base64url'),
      DEVRYAN_BOT_EGRESS_CONTROL_TOKEN: egressControlToken.toString('base64url'),
      DEVRYAN_BOT_INDEXER_TOKEN: indexerToken.toString('base64url'),
      DEVRYAN_DOCKER_SOCKET_GID: String(dockerSocketGid),
      DEVRYAN_BOT_HOST_RUNTIME_ROOT: hostRuntimeRoot,
    });
  } finally {
    deploymentDigest.fill(0);
    supervisorToken.fill(0);
    engineProxyToken.fill(0);
    egressSigningKey.fill(0);
    egressControlToken.fill(0);
    indexerToken.fill(0);
  }
}

const normalizeProcessResult = (result) => ({
  exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : 1,
  stdout: typeof result?.stdout === 'string' ? result.stdout : '',
  stderr: typeof result?.stderr === 'string' ? result.stderr : '',
});

const defaultRunProcess = async (file, args, { env, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {}) => {
  try {
    const result = await execFileAsync(file, args, {
      env,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      shell: false,
      windowsHide: true,
    });
    return { exitCode: 0, stdout: result.stdout || '', stderr: result.stderr || '' };
  } catch (error) {
    return {
      exitCode: Number.isInteger(error?.code) ? error.code : 1,
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      stderr: typeof error?.stderr === 'string' ? error.stderr : '',
    };
  }
};

const defaultWait = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

export async function resolveDockerExecutable({
  env = process.env,
  platform = process.platform,
  fixedCandidates = platform === 'darwin' ? FIXED_DOCKER_CANDIDATES : [],
  fsPromises = fs,
} = {}) {
  const candidates = [...fixedCandidates];
  for (const directory of String(env?.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    candidates.push(path.join(directory, platform === 'win32' ? 'docker.exe' : 'docker'));
  }

  for (const candidate of [...new Set(candidates)]) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || path.basename(candidate) === '.') continue;
    try {
      await fsPromises.access(candidate, fsConstants.X_OK);
      const realPath = await fsPromises.realpath(candidate);
      const stat = await fsPromises.stat(realPath);
      const expectedName = platform === 'win32' ? 'docker.exe' : 'docker';
      if (stat.isFile() && path.isAbsolute(realPath) && path.basename(realPath) === expectedName) {
        return realPath;
      }
    } catch {
      // Continue through the fixed candidate inventory.
    }
  }
  return null;
}

const atomicWriteJson = async (filePath, value, fsPromises) => {
  const directory = path.dirname(filePath);
  await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsPromises.chmod(directory, 0o700);
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await fsPromises.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsPromises.rename(temporaryPath, filePath);
    await fsPromises.chmod(filePath, 0o600);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fsPromises.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
};

export const createFileBotRuntimeStateStore = ({ dataDirectory, fsPromises = fs } = {}) => {
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)) {
    fail('Bot runtime state requires an absolute data directory', 'bot_runtime_state_invalid');
  }
  const statePath = path.join(dataDirectory, 'bots', 'runtime', 'installation.v1.json');
  return {
    async read() {
      let contents;
      try {
        contents = await fsPromises.readFile(statePath, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        fail('Bot runtime installation state cannot be read', 'bot_runtime_state_unreadable');
      }
      let parsed;
      try {
        parsed = JSON.parse(contents);
      } catch {
        fail('Bot runtime installation state is invalid', 'bot_runtime_state_invalid');
      }
      if (!parsed || typeof parsed !== 'object' || parsed.version !== BOT_RUNTIME_STATE_VERSION) {
        fail('Bot runtime installation state is invalid', 'bot_runtime_state_invalid');
      }
      return parsed;
    },
    async write(value) {
      await atomicWriteJson(statePath, value, fsPromises);
    },
    path: statePath,
  };
};

const publicManifest = (manifest) => manifest ? ({
  channel: manifest.channel,
  releaseId: manifest.releaseId,
  architecture: manifest.architecture,
  fingerprint: manifest.fingerprint,
}) : null;

const baseStatus = ({ state, code, currentState, desiredManifest, issues = [], warnings = [] }) => ({
  ok: state === 'healthy',
  state,
  code,
  issues,
  warnings,
  manifest: publicManifest(currentState?.current || desiredManifest),
  desiredManifest: publicManifest(desiredManifest),
  updateStaged: Boolean(currentState?.staged),
  canSetup: state === 'setup_required',
  canRepair: ['degraded', 'runtime_update_required'].includes(state),
  canUpdate: state === 'runtime_update_required',
  canRollback: Boolean(currentState?.previous || currentState?.staged),
});

const dockerNotInstalledStatus = () => ({
  ok: false,
  state: 'docker_not_installed',
  code: 'bot_runtime_docker_not_installed',
  issues: [{ code: 'docker_not_installed', message: 'Docker is not installed' }],
  warnings: [],
  manifest: null,
  desiredManifest: null,
  updateStaged: false,
  canSetup: false,
  canRepair: false,
  canUpdate: false,
  canRollback: false,
});

const dockerUnavailableStatus = () => ({
  ...dockerNotInstalledStatus(),
  state: 'docker_unavailable',
  code: 'bot_runtime_docker_unavailable',
  issues: [{ code: 'docker_unavailable', message: 'Docker is installed but unavailable' }],
});

const composeArgs = (composePath, action) => [
  'compose',
  '--project-name',
  BOT_RUNTIME_COMPOSE_PROJECT,
  '--file',
  composePath,
  ...action,
];

const validateServiceEnvironment = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).sort().join('\0') !== [...SERVICE_ENVIRONMENT_KEYS].sort().join('\0')
    || !BASE64URL_SECRET_PATTERN.test(raw.DEVRYAN_BOT_SUPERVISOR_TOKEN)
    || !BASE64URL_SECRET_PATTERN.test(raw.DEVRYAN_BOT_ENGINE_PROXY_TOKEN)
    || !BASE64URL_SECRET_PATTERN.test(raw.DEVRYAN_BOT_EGRESS_SIGNING_KEY)
    || !BASE64URL_SECRET_PATTERN.test(raw.DEVRYAN_BOT_EGRESS_CONTROL_TOKEN)
    || !BASE64URL_SECRET_PATTERN.test(raw.DEVRYAN_BOT_INDEXER_TOKEN)
    || !DEPLOYMENT_ID_PATTERN.test(raw.DEVRYAN_BOT_DEPLOYMENT_ID)
    || !/^\d{1,10}$/.test(raw.DEVRYAN_DOCKER_SOCKET_GID)
    || Number(raw.DEVRYAN_DOCKER_SOCKET_GID) > 2 ** 31 - 1) {
    fail('Bot runtime service environment is invalid', 'bot_runtime_secret_invalid');
  }
  if (typeof raw.DEVRYAN_BOT_HOST_RUNTIME_ROOT !== 'string'
    || !path.isAbsolute(raw.DEVRYAN_BOT_HOST_RUNTIME_ROOT)
    || path.normalize(raw.DEVRYAN_BOT_HOST_RUNTIME_ROOT) !== raw.DEVRYAN_BOT_HOST_RUNTIME_ROOT
    || raw.DEVRYAN_BOT_HOST_RUNTIME_ROOT.length > 2_048
    || /[:\u0000\r\n]/u.test(raw.DEVRYAN_BOT_HOST_RUNTIME_ROOT)) {
    fail('Bot runtime service environment is invalid', 'bot_runtime_secret_invalid');
  }
  return raw;
};

const manifestEnvironment = (baseEnvironment, manifest, serviceEnvironment) => {
  const environment = { ...baseEnvironment };
  for (const key of BOT_RUNTIME_IMAGE_KEYS) {
    environment[IMAGE_ENVIRONMENT_KEYS[key]] = manifest.images[key].reference;
  }
  Object.assign(environment, validateServiceEnvironment(serviceEnvironment));
  environment.DEVRYAN_BOT_ACTIVE_REVISIONS = '';
  return environment;
};

const parseRepoDigests = (stdout) => {
  try {
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === 'string') : [];
  } catch {
    return [];
  }
};

const isBrowserProfileScope = (botId, scopeKey) => {
  if (!UUID_PATTERN.test(botId) || typeof scopeKey !== 'string') return false;
  if (scopeKey === `bot:${botId}`) return true;
  const prefix = `bot:${botId}:user:`;
  return scopeKey.startsWith(prefix) && UUID_PATTERN.test(scopeKey.slice(prefix.length));
};

const browserProfileIdentity = (deploymentId, botId, scopeKey) => {
  if (!DEPLOYMENT_ID_PATTERN.test(deploymentId) || !UUID_PATTERN.test(botId)
    || !isBrowserProfileScope(botId, scopeKey)) {
    fail('Bot browser profile scope is invalid', 'bot_runtime_request_invalid');
  }
  const digest = crypto.createHash('sha256')
    .update(`${deploymentId}\0${botId}\0computer\0${scopeKey}`, 'utf8')
    .digest('hex');
  return Object.freeze({
    volumeName: `devryan-bot-computer-${digest.slice(0, 24)}-profile`,
    labels: Object.freeze({
      'devryan.runtime': 'production-bots',
      'devryan.deployment': deploymentId,
      'devryan.bot': botId,
      'devryan.scope': `sha256:${digest}`,
      'devryan.kind': 'computer',
      'devryan.volume-role': 'profile',
    }),
  });
};

const normalizeBrowserProfileScopes = (botId, rawScopes) => {
  if (!UUID_PATTERN.test(botId) || !Array.isArray(rawScopes)
    || rawScopes.length > BROWSER_PROFILE_SCOPE_LIMIT) {
    fail('Bot browser profile selection is invalid', 'bot_runtime_request_invalid');
  }
  const scopes = [...new Set(rawScopes)];
  if (scopes.length !== rawScopes.length || scopes.some((scopeKey) => (
    !isBrowserProfileScope(botId, scopeKey)
  ))) {
    fail('Bot browser profile selection is invalid', 'bot_runtime_request_invalid');
  }
  return Object.freeze(scopes.sort());
};

const parseBrowserProfileArchive = (botId, bytes) => {
  const encoded = Buffer.from(bytes || []);
  let parsed;
  try {
    if (encoded.byteLength < 1 || encoded.byteLength > BROWSER_PROFILE_ARCHIVE_LIMIT) {
      fail('Bot browser profile archive is invalid', 'bot_runtime_profile_archive_invalid');
    }
    parsed = JSON.parse(encoded.toString('utf8'));
  } catch (error) {
    if (error instanceof BotRuntimeManagerError) throw error;
    fail('Bot browser profile archive is invalid', 'bot_runtime_profile_archive_invalid');
  } finally {
    encoded.fill(0);
  }
  if (!exactObject(parsed, ['format', 'version', 'botId', 'profiles'])
    || parsed.format !== BROWSER_PROFILE_ARCHIVE_FORMAT
    || parsed.version !== BROWSER_PROFILE_ARCHIVE_VERSION
    || parsed.botId !== botId || !Array.isArray(parsed.profiles)
    || parsed.profiles.length > BROWSER_PROFILE_SCOPE_LIMIT) {
    fail('Bot browser profile archive is incompatible', 'bot_runtime_profile_archive_invalid');
  }
  const profiles = [];
  let totalBytes = 0;
  try {
    for (const profile of parsed.profiles) {
      if (!exactObject(profile, ['scopeKey', 'sha256', 'size', 'archiveBase64'])
        || !isBrowserProfileScope(botId, profile.scopeKey)
        || typeof profile.archiveBase64 !== 'string'
        || typeof profile.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(profile.sha256)
        || !Number.isSafeInteger(profile.size) || profile.size < 1) {
        fail('Bot browser profile archive entry is invalid', 'bot_runtime_profile_archive_invalid');
      }
      const archive = Buffer.from(profile.archiveBase64, 'base64');
      if (archive.toString('base64') !== profile.archiveBase64
        || archive.byteLength !== profile.size
        || crypto.createHash('sha256').update(archive).digest('hex') !== profile.sha256) {
        archive.fill(0);
        fail('Bot browser profile archive integrity check failed', 'bot_runtime_profile_archive_invalid');
      }
      totalBytes += archive.byteLength;
      if (totalBytes > BROWSER_PROFILE_RAW_LIMIT) {
        archive.fill(0);
        fail('Bot browser profile archive is too large', 'bot_runtime_profile_archive_invalid');
      }
      profiles.push({ scopeKey: profile.scopeKey, archive });
    }
    if (new Set(profiles.map((profile) => profile.scopeKey)).size !== profiles.length) {
      fail('Bot browser profile archive contains duplicate scopes', 'bot_runtime_profile_archive_invalid');
    }
    return profiles;
  } catch (error) {
    for (const profile of profiles) profile.archive.fill(0);
    throw error;
  }
};

const parseComposeRows = (stdout) => {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const rows = [];
    for (const line of trimmed.split(/\r?\n/)) {
      try {
        rows.push(JSON.parse(line));
      } catch {
        return [];
      }
    }
    return rows;
  }
};

const exactObject = (value, fields) => (
  value
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...fields].sort().join('\0')
);

const validateUuid = (value) => typeof value === 'string' && UUID_PATTERN.test(value);

const validateGatewayUrl = (value) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('Bot private gateway URL is invalid', 'bot_runtime_request_invalid');
  }
  if (url.protocol !== 'http:' || url.hostname !== 'host.docker.internal' || !url.port
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    fail('Bot private gateway URL is invalid', 'bot_runtime_request_invalid');
  }
};

const validateSupervisorInput = (operation, input) => {
  const fields = operation === 'ensureReasoning'
    ? [
        'botId',
        'scopeKey',
        'runId',
        'channelId',
        'revisionId',
        'runtimeToken',
        'compiledHash',
        'gatewayUrl',
        'egressHosts',
        'environmentSecretCount',
        'chatgptImageGeneration',
      ]
    : operation === 'ensureComputer'
      ? [
          'botId', 'scopeKey', 'runId', 'channelId', 'revisionId', 'runtimeToken',
          'scopeMode', 'gatewayUrl', 'browserNetworkMode', 'browserEgressHosts',
          'isolationTier',
        ]
      : operation === 'writeWorkspace'
        ? ['botId', 'scopeKey', 'path', 'content']
      : operation === 'importSharedFile'
        ? [
            'botId', 'scopeKey', 'channelId', 'messageId', 'filename',
            'contentBase64', 'expectedSize', 'sha256',
            ...(Object.hasOwn(input, 'resourcePath') ? ['resourcePath'] : []),
          ]
      : operation === 'exportWorkspaceImage'
        ? ['botId', 'scopeKey', 'path']
      : operation === 'listWorkspace' || operation === 'listFilesystem'
        ? ['kind', 'botId', 'scopeKey', 'path']
      : operation === 'reset'
        ? ['kind', 'botId', 'scopeKey', 'resource']
        : ['kind', 'botId', 'scopeKey'];
  if (!exactObject(input, fields) || !validateUuid(input.botId) || !SCOPE_PATTERN.test(input.scopeKey || '')) {
    fail('Bot supervisor request is invalid', 'bot_runtime_request_invalid');
  }
  if (operation === 'inspect' || operation === 'stop' || operation === 'reset') {
    if (!['reasoning', 'computer'].includes(input.kind)) {
      fail('Bot supervisor target is invalid', 'bot_runtime_request_invalid');
    }
    if (operation === 'reset') {
      const allowed = input.kind === 'reasoning'
        ? new Set(['opencode', 'workspace', 'runtime-config', 'all'])
        : new Set(['profile', 'scratch', 'shared', 'all']);
      if (!allowed.has(input.resource)) {
        fail('Bot reset resource is invalid', 'bot_runtime_request_invalid');
      }
    }
    return structuredClone(input);
  }
  if (operation === 'ensureReasoning'
    && (!Number.isSafeInteger(input.environmentSecretCount)
      || input.environmentSecretCount < 0 || input.environmentSecretCount > 128
      || typeof input.chatgptImageGeneration !== 'boolean')) {
    fail('Bot reasoning runtime capabilities are invalid', 'bot_runtime_request_invalid');
  }
  if (operation === 'listWorkspace') {
    if (!['reasoning', 'computer'].includes(input.kind)) {
      fail('Bot supervisor target is invalid', 'bot_runtime_request_invalid');
    }
    // Listing is read-only, but the path still has to be a plain relative
    // location inside the workspace mount.
    if (input.path !== null && input.path !== undefined) {
      const segments = typeof input.path === 'string' ? input.path.split('/') : [];
      if (typeof input.path !== 'string' || Buffer.byteLength(input.path, 'utf8') > 1024
        || input.path.includes('\0') || input.path.includes('\\') || input.path.startsWith('/')
        || segments.length > 32
        || segments.some((segment) => (
          segment === '' || segment === '.' || segment === '..'
          || Buffer.byteLength(segment, 'utf8') > 255
        ))
        || ['.devryan', '.opencode'].includes((segments[0] || '').toLowerCase())) {
        fail('Bot workspace listing request is invalid', 'bot_runtime_request_invalid');
      }
    }
    return structuredClone({ ...input, path: input.path ?? null });
  }
  if (operation === 'listFilesystem') {
    if (input.kind !== 'computer') {
      fail('Bot container listing target is invalid', 'bot_runtime_request_invalid');
    }
    if (input.path !== null && input.path !== undefined) {
      const segments = typeof input.path === 'string' ? input.path.split('/') : [];
      if (typeof input.path !== 'string' || Buffer.byteLength(input.path, 'utf8') > 1024
        || input.path.includes('\0') || input.path.startsWith('/')
        || input.path.includes('\\') || segments.length > 32
        || segments.some((segment) => (
          segment === '' || segment === '.' || segment === '..'
          || Buffer.byteLength(segment, 'utf8') > 255
        ))) {
        fail('Bot container listing request is invalid', 'bot_runtime_request_invalid');
      }
    }
    return structuredClone({ ...input, path: input.path ?? null });
  }
  if (operation === 'writeWorkspace') {
    const channelId = input.scopeKey.startsWith('channel:')
      ? input.scopeKey.slice('channel:'.length)
      : '';
    if (!validateUuid(channelId)
      || typeof input.path !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.path)
      || ['.devryan', '.opencode'].includes(input.path.toLowerCase())
      || typeof input.content !== 'string'
      || Buffer.byteLength(input.content, 'utf8') > 48 * 1024) {
      fail('Bot workspace write request is invalid', 'bot_runtime_request_invalid');
    }
    return structuredClone(input);
  }
  if (operation === 'importSharedFile') {
    const resourceSegments = typeof input.resourcePath === 'string'
      ? input.resourcePath.split('/')
      : null;
    if (input.scopeKey !== `bot:${input.botId}`
      || !validateUuid(input.channelId) || !validateUuid(input.messageId)
      || typeof input.filename !== 'string' || !SHARED_FILENAME_PATTERN.test(input.filename)
      || ['.devryan', '.opencode'].includes(input.filename.toLowerCase())
      || !Number.isSafeInteger(input.expectedSize) || input.expectedSize < 1
      || input.expectedSize > SHARED_FILE_MAX_BYTES
      || typeof input.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(input.sha256)
      || typeof input.contentBase64 !== 'string'
      || input.contentBase64.length > Math.ceil(SHARED_FILE_MAX_BYTES / 3) * 4
      || !SHARED_BASE64_PATTERN.test(input.contentBase64)
      || (resourceSegments && (
        Buffer.byteLength(input.resourcePath, 'utf8') > 180
        || resourceSegments.length > 32
        || resourceSegments.at(-1) !== input.filename
        || Buffer.byteLength(resourceSegments.slice(0, -1).join('/'), 'utf8') > 145
        || resourceSegments.some((segment) => !SHARED_FILENAME_PATTERN.test(segment))
      ))) {
      fail('Bot Shared import request is invalid', 'bot_runtime_request_invalid');
    }
    return structuredClone(input);
  }
  if (operation === 'exportWorkspaceImage') {
    const channelId = input.scopeKey.startsWith('channel:')
      ? input.scopeKey.slice('channel:'.length)
      : '';
    if (!validateUuid(channelId) || typeof input.path !== 'string' || input.path.length < 1
      || Buffer.byteLength(input.path, 'utf8') > 1024 || input.path.startsWith('/')
      || input.path.includes('\0') || input.path.includes('\\')) {
      fail('Bot generated image request is invalid', 'bot_runtime_request_invalid');
    }
    const segments = input.path.split('/');
    if (segments.length > 32 || segments.some((segment) => (
      segment === '' || segment === '.' || segment === '..'
      || Buffer.byteLength(segment, 'utf8') > 255
    )) || ['.devryan', '.opencode'].includes(segments[0].toLowerCase())) {
      fail('Bot generated image request is invalid', 'bot_runtime_request_invalid');
    }
    return structuredClone(input);
  }
  if (!validateUuid(input.runId) || !validateUuid(input.channelId) || !validateUuid(input.revisionId)
    || !RUNTIME_TOKEN_PATTERN.test(input.runtimeToken)) {
    fail('Bot runtime capability is invalid', 'bot_runtime_request_invalid');
  }
  validateGatewayUrl(input.gatewayUrl);
  if (operation === 'ensureReasoning') {
    if (input.scopeKey !== `channel:${input.channelId}`
      || !COMPILED_HASH_PATTERN.test(input.compiledHash)) {
      fail('Bot reasoning runtime request is invalid', 'bot_runtime_request_invalid');
    }
    let egressHosts;
    try {
      egressHosts = normalizeModelHosts(input.egressHosts);
    } catch {
      fail('Bot reasoning model egress hosts are invalid', 'bot_runtime_request_invalid');
    }
    if (egressHosts.some((authority) => !authority.endsWith(':443'))) {
      fail('Bot reasoning model egress hosts are invalid', 'bot_runtime_request_invalid');
    }
    return { ...structuredClone(input), egressHosts };
  } else {
    // One shared computer per Bot: `bot:<botId>` is the only valid scope.
    if (input.scopeMode !== 'team' || input.scopeKey !== `bot:${input.botId}`
      || !['public_only', 'allowlist'].includes(input.browserNetworkMode)
      || !Array.isArray(input.browserEgressHosts)
      || (input.browserNetworkMode === 'public_only' && input.browserEgressHosts.length !== 0)
      || !['standard', 'runsc'].includes(input.isolationTier)) {
      fail('Bot computer runtime request is invalid', 'bot_runtime_request_invalid');
    }
    let browserEgressHosts = Object.freeze([]);
    if (input.browserNetworkMode === 'allowlist') {
      try {
        browserEgressHosts = normalizeBrowserHosts(input.browserEgressHosts);
      } catch {
        fail('Bot browser egress hosts are invalid', 'bot_runtime_request_invalid');
      }
      if (browserEgressHosts.length > 64) {
        fail('Bot browser egress hosts are invalid', 'bot_runtime_request_invalid');
      }
    }
    return { ...structuredClone(input), browserEgressHosts };
  }
};

const parseLoopbackComposeEndpoint = (stdout, service) => {
  const rows = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
  if (rows.length !== 1) fail(`Bot ${service} endpoint is unavailable`, `bot_runtime_${service}_unavailable`);
  let url;
  try {
    url = new URL(`http://${rows[0]}`);
  } catch {
    fail(`Bot ${service} endpoint is invalid`, `bot_runtime_${service}_unavailable`);
  }
  if (!['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    fail(`Bot ${service} endpoint is not loopback-confined`, `bot_runtime_${service}_unavailable`);
  }
  return url.origin;
};

const readSupervisorResponse = async (response, maximumBytes = SUPERVISOR_RESPONSE_LIMIT) => {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    fail('Bot supervisor response is too large', 'bot_runtime_supervisor_response_invalid');
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    fail('Bot supervisor response is invalid', 'bot_runtime_supervisor_response_invalid');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      fail('Bot supervisor response is too large', 'bot_runtime_supervisor_response_invalid');
    }
    chunks.push(Buffer.from(value));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail('Bot supervisor response is invalid', 'bot_runtime_supervisor_response_invalid');
  }
};

const exposeReasoningProxyEndpoint = (supervisorEndpoint, result) => {
  if (result?.kind !== 'reasoning' || result.state !== 'running') return result;
  const endpoint = result.endpoint;
  if (!exactObject(endpoint, ['proxyToken'])
    || !BASE64URL_SECRET_PATTERN.test(endpoint.proxyToken)) {
    fail('Bot supervisor returned an invalid runtime proxy', 'bot_runtime_supervisor_response_invalid');
  }
  let supervisor;
  try {
    supervisor = new URL(supervisorEndpoint);
  } catch {
    fail('Bot supervisor endpoint is invalid', 'bot_runtime_supervisor_response_invalid');
  }
  const host = supervisor.hostname === '[::1]' ? '::1' : supervisor.hostname;
  const port = Number(supervisor.port);
  if (!['127.0.0.1', '::1'].includes(host)
    || !Number.isInteger(port) || port < 1 || port > 65_535) {
    fail('Bot supervisor endpoint is invalid', 'bot_runtime_supervisor_response_invalid');
  }
  return Object.freeze({
    ...result,
    endpoint: Object.freeze({
      host,
      port,
      path: `/v1/runtime/${endpoint.proxyToken}`,
    }),
  });
};

const computerRuntimeOrigin = (result) => {
  if (result?.kind !== 'computer' || result.state !== 'running'
    || !exactObject(result.endpoint, ['host', 'port'])
    || !['127.0.0.1', '::1'].includes(result.endpoint.host)
    || !Number.isInteger(result.endpoint.port)
    || result.endpoint.port < 1 || result.endpoint.port > 65_535) {
    fail('Bot supervisor returned an invalid computer endpoint', 'bot_runtime_supervisor_response_invalid');
  }
  return result.endpoint.host === '::1'
    ? `http://[::1]:${result.endpoint.port}`
    : `http://127.0.0.1:${result.endpoint.port}`;
};

const serviceIssues = (rows) => {
  const byService = new Map();
  for (const row of rows) {
    const service = typeof row?.Service === 'string'
      ? row.Service
      : (typeof row?.service === 'string' ? row.service : '');
    if (service) byService.set(service, row);
  }
  const issues = [];
  for (const service of FIXED_SERVICES) {
    const row = byService.get(service);
    const state = String(row?.State || row?.state || '').toLowerCase();
    const health = String(row?.Health || row?.health || '').toLowerCase();
    if (!row) {
      issues.push({ code: 'service_missing', service, message: `Bot runtime service ${service} is missing` });
    } else if (['dead', 'exited'].includes(state)) {
      issues.push({ code: 'service_stopped', service, message: `Bot runtime service ${service} stopped` });
    } else if (state !== 'running' || (health && health !== 'healthy')) {
      issues.push({
        code: 'service_unhealthy',
        service,
        message: `Bot runtime service ${service} is unhealthy`,
      });
    }
  }
  return issues;
};

export function createBotRuntimeManager({
  composePath,
  loadManifest,
  resolveDocker = () => resolveDockerExecutable(),
  runProcess = defaultRunProcess,
  stateStore,
  dataDirectory,
  baseEnvironment = process.env,
  loadRuntimeEnvironment,
  fetchImpl = globalThis.fetch,
  wait = defaultWait,
  now = Date.now,
} = {}) {
  if (typeof composePath !== 'string' || !path.isAbsolute(composePath)) {
    fail('Bot runtime compose path must be absolute', 'bot_runtime_configuration_invalid');
  }
  if (typeof loadManifest !== 'function' || typeof resolveDocker !== 'function'
    || typeof runProcess !== 'function' || typeof loadRuntimeEnvironment !== 'function'
    || typeof fetchImpl !== 'function' || typeof wait !== 'function' || typeof now !== 'function') {
    fail('Bot runtime manager dependencies are invalid', 'bot_runtime_configuration_invalid');
  }
  const installationState = stateStore || createFileBotRuntimeStateStore({ dataDirectory });
  if (typeof installationState?.read !== 'function' || typeof installationState?.write !== 'function') {
    fail('Bot runtime state store is invalid', 'bot_runtime_configuration_invalid');
  }
  let mutation = Promise.resolve();
  let activeLifecycleOperation = null;
  const hostRuntimeRoot = typeof dataDirectory === 'string' && path.isAbsolute(dataDirectory)
    ? path.join(dataDirectory, 'bots', 'runtime')
    : null;

  const composeEnvironment = async (manifest) => manifestEnvironment(
    baseEnvironment,
    manifest,
    await loadRuntimeEnvironment(),
  );

  const invalidInstallationState = (message = 'Bot runtime installation state is outdated or invalid') => ({
    version: BOT_RUNTIME_STATE_VERSION,
    current: null,
    previous: null,
    staged: null,
    invalid: {
      code: 'installation_state_outdated',
      message,
    },
  });

  const tryValidateInstalledManifest = (record, architecture) => {
    try {
      return validateInstalledBotRuntimeManifest(record, { architecture });
    } catch (error) {
      if (error instanceof BotRuntimeManifestError) return null;
      throw error;
    }
  };

  const readInstallationState = async (desiredManifest) => {
    let raw;
    try {
      raw = await installationState.read();
    } catch (error) {
      if (error?.code === 'bot_runtime_state_invalid') {
        return invalidInstallationState(error.message);
      }
      throw error;
    }
    if (raw === null) return null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).sort().join('\0') !== 'current\0previous\0staged\0version'
      || raw.version !== BOT_RUNTIME_STATE_VERSION
      || !raw.current) {
      return invalidInstallationState();
    }
    const current = tryValidateInstalledManifest(raw.current, desiredManifest.architecture);
    if (!current) return invalidInstallationState();
    return {
      version: BOT_RUNTIME_STATE_VERSION,
      current,
      previous: raw.previous
        ? tryValidateInstalledManifest(raw.previous, desiredManifest.architecture)
        : null,
      staged: raw.staged
        ? tryValidateInstalledManifest(raw.staged, desiredManifest.architecture)
        : null,
    };
  };

  const operationSnapshot = () => activeLifecycleOperation ? Object.freeze({
    id: activeLifecycleOperation.id,
    action: activeLifecycleOperation.action,
    phase: activeLifecycleOperation.phase,
    completed: activeLifecycleOperation.completed,
    total: activeLifecycleOperation.total,
    code: activeLifecycleOperation.code,
    startedAt: activeLifecycleOperation.startedAt,
  }) : null;

  const publishProgress = (progress) => {
    if (!activeLifecycleOperation) return;
    activeLifecycleOperation.phase = progress.phase;
    activeLifecycleOperation.completed = Number.isInteger(progress.completed) ? progress.completed : null;
    activeLifecycleOperation.total = Number.isInteger(progress.total) ? progress.total : null;
    activeLifecycleOperation.code = typeof progress.code === 'string' ? progress.code : null;
    const snapshot = operationSnapshot();
    for (const listener of activeLifecycleOperation.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Progress reporting is best-effort and must never weaken lifecycle enforcement.
      }
    }
  };

  const deadlineError = () => fail(
    'Bot runtime preparation timed out. Check Docker and the network, then retry.',
    'bot_runtime_startup_timeout',
  );

  const run = async (
    dockerPath,
    args,
    environment = baseEnvironment,
    deadlineAt = null,
  ) => {
    const remainingMs = deadlineAt === null
      ? DEFAULT_COMMAND_TIMEOUT_MS
      : deadlineAt - now();
    if (remainingMs <= 0) deadlineError();
    const result = normalizeProcessResult(await runProcess(dockerPath, args, {
      env: environment,
      timeoutMs: Math.min(DEFAULT_COMMAND_TIMEOUT_MS, remainingMs),
    }));
    if (deadlineAt !== null && now() >= deadlineAt) deadlineError();
    return result;
  };

  const validatePrivateFile = async (filePath, { maximumBytes, writable }) => {
    let handle;
    try {
      handle = await fs.open(
        filePath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
      );
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > maximumBytes
        || (stat.mode & 0o077) !== 0 || (!writable && (stat.mode & 0o222) !== 0)) {
        fail('Bot scoped runtime file is invalid', 'bot_runtime_scoped_file_invalid');
      }
      return handle;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (error instanceof BotRuntimeManagerError) throw error;
      fail('Bot scoped runtime file is unavailable', 'bot_runtime_scoped_file_invalid');
    }
  };

  const validateRuntimeDirectory = async (directory) => {
    if (!hostRuntimeRoot || !directory.startsWith(`${hostRuntimeRoot}${path.sep}`)) {
      fail('Bot runtime root is unavailable', 'bot_runtime_scoped_file_invalid');
    }
    let rootRealPath;
    let directoryRealPath;
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
        fail('Bot scoped runtime directory is invalid', 'bot_runtime_scoped_file_invalid');
      }
      [rootRealPath, directoryRealPath] = await Promise.all([
        fs.realpath(hostRuntimeRoot),
        fs.realpath(directory),
      ]);
    } catch (error) {
      if (error instanceof BotRuntimeManagerError) throw error;
      fail('Bot scoped runtime directory is unavailable', 'bot_runtime_scoped_file_invalid');
    }
    if (!directoryRealPath.startsWith(`${rootRealPath}${path.sep}`)) {
      fail('Bot scoped runtime directory escaped its root', 'bot_runtime_scoped_file_invalid');
    }
  };

  const validateMaterializedArtifacts = async (directory) => {
    const rootRealPath = await fs.realpath(directory);
    let fileCount = 0;
    let totalBytes = 0;
    let manifest = null;
    const materializedFiles = new Map();
    const walk = async (current) => {
      const entries = [];
      for await (const entry of await fs.opendir(current)) entries.push(entry);
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (entry.name.toLowerCase() === '.git') {
          fail('Bot scoped artifacts contain forbidden metadata', 'bot_runtime_scoped_file_invalid');
        }
        const candidate = path.join(current, entry.name);
        const stat = await fs.lstat(candidate).catch(() => null);
        if (!stat || stat.isSymbolicLink()) {
          fail('Bot scoped artifact is invalid', 'bot_runtime_scoped_file_invalid');
        }
        if (stat.isDirectory()) {
          if ((stat.mode & 0o077) !== 0) {
            fail('Bot scoped artifact directory is not private', 'bot_runtime_scoped_file_invalid');
          }
          const realPath = await fs.realpath(candidate).catch(() => null);
          if (!realPath || !realPath.startsWith(`${rootRealPath}${path.sep}`)) {
            fail('Bot scoped artifact directory escaped its root', 'bot_runtime_scoped_file_invalid');
          }
          await walk(candidate);
          continue;
        }
        if (!stat.isFile()) {
          fail('Bot scoped artifact must be a regular file', 'bot_runtime_scoped_file_invalid');
        }
        const isManifest = current === directory && entry.name === 'manifest.json';
        const handle = await validatePrivateFile(candidate, {
          maximumBytes: isManifest ? 1024 * 1024 : SCOPED_ARTIFACT_BYTE_LIMIT,
          writable: false,
        });
        try {
          const openedStat = await handle.stat();
          if (openedStat.nlink !== 1) {
            fail('Bot scoped artifact hard links are forbidden', 'bot_runtime_scoped_file_invalid');
          }
          fileCount += 1;
          totalBytes += openedStat.size;
          if (isManifest) {
            const parsed = JSON.parse(await handle.readFile('utf8'));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
              || Object.keys(parsed).sort().join('\0') !== 'files\0version'
              || parsed.version !== 1 || !Array.isArray(parsed.files)
              || parsed.files.length > SCOPED_ARTIFACT_FILE_LIMIT - 1) {
              fail('Bot scoped artifact manifest is invalid', 'bot_runtime_scoped_file_invalid');
            }
            manifest = parsed;
          } else {
            const relativePath = path.relative(directory, candidate).split(path.sep).join('/');
            if (!relativePath || relativePath.startsWith('../') || materializedFiles.has(relativePath)) {
              fail('Bot scoped artifact path is invalid', 'bot_runtime_scoped_file_invalid');
            }
            materializedFiles.set(relativePath, openedStat.size);
          }
        } catch (error) {
          if (error instanceof BotRuntimeManagerError) throw error;
          fail('Bot scoped artifact manifest is invalid', 'bot_runtime_scoped_file_invalid');
        } finally {
          await handle.close();
        }
        if (fileCount > SCOPED_ARTIFACT_FILE_LIMIT || totalBytes > SCOPED_ARTIFACT_BYTE_LIMIT) {
          fail('Bot scoped artifacts exceed runtime limits', 'bot_runtime_scoped_file_invalid');
        }
      }
    };
    await walk(directory);
    if (fileCount < 1 || !manifest) {
      fail('Bot scoped artifact manifest is missing', 'bot_runtime_scoped_file_invalid');
    }
    const declaredPaths = new Set();
    for (const entry of manifest.files) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || !['private_artifact', 'library'].includes(entry.kind)
        || typeof entry.relativePath !== 'string'
        || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1) {
        fail('Bot scoped artifact manifest is invalid', 'bot_runtime_scoped_file_invalid');
      }
      const normalized = path.posix.normalize(entry.relativePath);
      if (normalized !== entry.relativePath || normalized === 'manifest.json'
        || normalized.startsWith('../') || normalized.startsWith('/')
        || normalized.split('/').some((segment) => segment.toLowerCase() === '.git')
        || declaredPaths.has(normalized)
        || materializedFiles.get(normalized) !== entry.bytes) {
        fail('Bot scoped artifact manifest does not match its files', 'bot_runtime_scoped_file_invalid');
      }
      declaredPaths.add(normalized);
    }
    if (declaredPaths.size !== materializedFiles.size) {
      fail('Bot scoped artifact manifest does not match its files', 'bot_runtime_scoped_file_invalid');
    }
  };

  const validateMaterializedSkills = async (configDirectory, revision) => {
    const directory = path.join(configDirectory, 'skills');
    await validateRuntimeDirectory(directory);
    const expected = new Map();
    const skills = revision?.skills ?? [];
    if (!Array.isArray(skills) || skills.length > SCOPED_SKILL_FILE_LIMIT) {
      fail('Bot compiled skill manifest is invalid', 'bot_runtime_scoped_file_invalid');
    }
    for (const skill of skills) {
      if (!skill || typeof skill !== 'object' || Array.isArray(skill)
        || typeof skill.name !== 'string' || !/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/.test(skill.name)
        || !Array.isArray(skill.files)) {
        fail('Bot compiled skill manifest is invalid', 'bot_runtime_scoped_file_invalid');
      }
      for (const file of skill.files) {
        const relativePath = `${skill.name}/${file?.path || ''}`;
        const normalized = path.posix.normalize(relativePath);
        if (!file || typeof file.path !== 'string' || normalized !== relativePath
          || normalized.startsWith('../') || path.posix.isAbsolute(normalized)
          || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)
          || expected.has(normalized)) {
          fail('Bot compiled skill manifest is invalid', 'bot_runtime_scoped_file_invalid');
        }
        expected.set(normalized, file.sha256);
      }
    }
    if (expected.size > SCOPED_SKILL_FILE_LIMIT) {
      fail('Bot compiled skills exceed runtime limits', 'bot_runtime_scoped_file_invalid');
    }
    const rootRealPath = await fs.realpath(directory);
    const actual = new Map();
    let totalBytes = 0;
    const walk = async (current) => {
      const entries = [];
      for await (const entry of await fs.opendir(current)) entries.push(entry);
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const candidate = path.join(current, entry.name);
        const stat = await fs.lstat(candidate).catch(() => null);
        if (!stat || stat.isSymbolicLink() || entry.name.toLowerCase() === '.git') {
          fail('Bot compiled skill path is invalid', 'bot_runtime_scoped_file_invalid');
        }
        if (stat.isDirectory()) {
          if ((stat.mode & 0o077) !== 0) {
            fail('Bot compiled skill directory is not private', 'bot_runtime_scoped_file_invalid');
          }
          const realPath = await fs.realpath(candidate).catch(() => null);
          if (!realPath || !realPath.startsWith(`${rootRealPath}${path.sep}`)) {
            fail('Bot compiled skill directory escaped its root', 'bot_runtime_scoped_file_invalid');
          }
          await walk(candidate);
          continue;
        }
        const handle = await validatePrivateFile(candidate, {
          maximumBytes: SCOPED_SKILL_FILE_BYTE_LIMIT,
          writable: false,
        });
        try {
          const openedStat = await handle.stat();
          if (!openedStat.isFile() || openedStat.nlink !== 1) {
            fail('Bot compiled skill file is invalid', 'bot_runtime_scoped_file_invalid');
          }
          const relativePath = path.relative(directory, candidate).split(path.sep).join('/');
          const bytes = await handle.readFile();
          totalBytes += bytes.byteLength;
          actual.set(relativePath, crypto.createHash('sha256').update(bytes).digest('hex'));
        } finally {
          await handle.close();
        }
        if (actual.size > SCOPED_SKILL_FILE_LIMIT || totalBytes > SCOPED_SKILL_TOTAL_BYTE_LIMIT) {
          fail('Bot compiled skills exceed runtime limits', 'bot_runtime_scoped_file_invalid');
        }
      }
    };
    await walk(directory);
    if (actual.size !== expected.size
      || [...expected].some(([relativePath, digest]) => actual.get(relativePath) !== digest)) {
      fail('Bot compiled skills do not match the revision manifest', 'bot_runtime_scoped_file_invalid');
    }
  };

  const validateReasoningDirectories = async (input) => {
    if (!hostRuntimeRoot) fail('Bot runtime data directory is unavailable', 'bot_runtime_scoped_file_invalid');
    const configDirectory = path.join(
      hostRuntimeRoot,
      'channels',
      input.channelId,
      input.revisionId,
      input.compiledHash,
    );
    const authDirectory = path.join(hostRuntimeRoot, 'auth', input.runId);
    const artifactsDirectory = path.join(hostRuntimeRoot, 'artifacts', input.runId);
    const environmentDirectory = path.join(hostRuntimeRoot, 'environment', input.runId);
    await Promise.all([
      validateRuntimeDirectory(configDirectory),
      validateRuntimeDirectory(authDirectory),
      validateRuntimeDirectory(artifactsDirectory),
      validateRuntimeDirectory(environmentDirectory),
    ]);
    await validateMaterializedArtifacts(artifactsDirectory);
    let revisionHandle;
    let configHandle;
    let authHandle;
    let environmentHandle;
    try {
      revisionHandle = await validatePrivateFile(path.join(configDirectory, 'revision.json'), {
        maximumBytes: 1024 * 1024,
        writable: false,
      });
      configHandle = await validatePrivateFile(path.join(configDirectory, 'opencode.json'), {
        maximumBytes: 1024 * 1024,
        writable: false,
      });
      authHandle = await validatePrivateFile(path.join(authDirectory, 'auth.json'), {
        maximumBytes: 1024 * 1024,
        writable: true,
      });
      environmentHandle = await validatePrivateFile(
        path.join(environmentDirectory, 'environment.json'),
        { maximumBytes: ENVIRONMENT_SECRET_FILE_LIMIT, writable: false },
      );
      const revision = JSON.parse(await revisionHandle.readFile('utf8'));
      if (revision?.compiledHash !== input.compiledHash || revision?.revisionId !== input.revisionId) {
        fail('Bot compiled revision identity is invalid', 'bot_runtime_scoped_file_invalid');
      }
      await validateMaterializedSkills(configDirectory, revision);
      const environmentPayload = JSON.parse(await environmentHandle.readFile('utf8'));
      const environmentEntries = Object.entries(environmentPayload?.variables || {});
      if (!exactObject(environmentPayload, ['version', 'variables'])
        || environmentPayload.version !== 1 || !environmentPayload.variables
        || typeof environmentPayload.variables !== 'object'
        || Array.isArray(environmentPayload.variables)
        || Object.keys(environmentPayload.variables).length !== input.environmentSecretCount
        || environmentEntries.reduce((total, [, value]) => (
          total + (typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0)
        ), 0) > 256 * 1024
        || environmentEntries.some(([name, value]) => (
          !ENVIRONMENT_SECRET_NAME_PATTERN.test(name)
          || isReservedEnvironmentSecretName(name)
          || typeof value !== 'string' || value.length < 1 || value.includes('\0')
          || Buffer.byteLength(value, 'utf8') > 16 * 1024
        ))) {
        fail('Bot environment secret materialization is invalid', 'bot_runtime_scoped_file_invalid');
      }
    } catch (error) {
      if (error instanceof BotRuntimeManagerError) throw error;
      fail('Bot compiled revision manifest is invalid', 'bot_runtime_scoped_file_invalid');
    } finally {
      await Promise.all([
        revisionHandle?.close(),
        configHandle?.close(),
        authHandle?.close(),
        environmentHandle?.close(),
      ]);
    }
  };

  const probeDocker = async (deadlineAt = null) => {
    publishProgress({ phase: 'checking' });
    const dockerPath = await resolveDocker();
    if (!dockerPath) return { status: dockerNotInstalledStatus(), dockerPath: null };
    if (!path.isAbsolute(dockerPath) || !['docker', 'docker.exe'].includes(path.basename(dockerPath))) {
      return { status: dockerNotInstalledStatus(), dockerPath: null };
    }
    const version = await run(
      dockerPath,
      ['version', '--format', '{{json .}}'],
      baseEnvironment,
      deadlineAt,
    );
    if (version.exitCode !== 0) return { status: dockerUnavailableStatus(), dockerPath };
    return { status: null, dockerPath };
  };

  // Best-effort preflight: read the engine's total memory once per TTL and
  // turn a too-small Docker Desktop VM into status warnings. Any probe
  // failure other than the caller's deadline yields no warning at all.
  let engineMemoryProbe = null;
  const probeEngineMemoryWarnings = async (dockerPath, deadlineAt = null) => {
    if (engineMemoryProbe && now() - engineMemoryProbe.at < ENGINE_MEMORY_PROBE_TTL_MS) {
      return engineMemoryProbe.warnings;
    }
    let warnings = [];
    try {
      const result = await run(dockerPath, ['info', '--format', '{{.MemTotal}}'], baseEnvironment, deadlineAt);
      const memTotalBytes = result.exitCode === 0
        ? Number.parseInt(String(result.stdout ?? '').trim(), 10)
        : Number.NaN;
      warnings = evaluateBotRuntimeEngineMemory(memTotalBytes);
    } catch (error) {
      if (error instanceof BotRuntimeManagerError) throw error;
    }
    engineMemoryProbe = { at: now(), warnings };
    return warnings;
  };

  const requireDocker = async (deadlineAt = null) => {
    const probe = await probeDocker(deadlineAt);
    if (!probe.status) return probe.dockerPath;
    fail(
      probe.status.state === 'docker_not_installed'
        ? 'Docker is not installed'
        : 'Docker is installed but unavailable',
      probe.status.code,
    );
  };

  const resolveSupervisorContext = async ({ includeEgress = false } = {}) => {
    const dockerPath = await requireDocker();
    const desiredManifest = await loadManifest();
    const currentState = await readInstallationState(desiredManifest);
    if (!currentState?.current) {
      fail('Bot runtime setup is required', 'bot_runtime_setup_required');
    }
    if (currentState.current.fingerprint !== desiredManifest.fingerprint) {
      fail('Bot runtime update is required', 'bot_runtime_update_required');
    }
    const environment = await composeEnvironment(currentState.current);
    if (!hostRuntimeRoot || environment.DEVRYAN_BOT_HOST_RUNTIME_ROOT !== hostRuntimeRoot) {
      fail('Bot runtime host root does not match Electron state', 'bot_runtime_scoped_file_invalid');
    }
    const [portResult, egressPortResult] = await Promise.all([
      run(
        dockerPath,
        composeArgs(composePath, ['port', 'supervisor', SUPERVISOR_PORT]),
        environment,
      ),
      includeEgress
        ? run(
            dockerPath,
            composeArgs(composePath, ['port', 'egress', EGRESS_PORT]),
            environment,
          )
        : null,
    ]);
    if (portResult.exitCode !== 0) {
      throw new BotRuntimeManagerError('Bot supervisor is unavailable', 'bot_runtime_supervisor_unavailable', {
        stage: 'supervisor_port', reason: 'docker_command_failed',
      });
    }
    if (includeEgress && egressPortResult.exitCode !== 0) {
      fail('Bot model egress is unavailable', 'bot_runtime_egress_unavailable');
    }
    return Object.freeze({
      endpoint: parseLoopbackComposeEndpoint(portResult.stdout, 'supervisor'),
      token: environment.DEVRYAN_BOT_SUPERVISOR_TOKEN,
      deploymentId: environment.DEVRYAN_BOT_DEPLOYMENT_ID,
      egressSigningKey: environment.DEVRYAN_BOT_EGRESS_SIGNING_KEY,
      egressControlToken: environment.DEVRYAN_BOT_EGRESS_CONTROL_TOKEN,
      egressEndpoint: includeEgress
        ? parseLoopbackComposeEndpoint(egressPortResult.stdout, 'egress')
        : null,
    });
  };

  const resolveIndexerContext = async () => {
    const dockerPath = await requireDocker();
    const desiredManifest = await loadManifest();
    const currentState = await readInstallationState(desiredManifest);
    if (!currentState?.current) {
      fail('Bot runtime setup is required', 'bot_runtime_setup_required');
    }
    if (currentState.current.fingerprint !== desiredManifest.fingerprint) {
      fail('Bot runtime update is required', 'bot_runtime_update_required');
    }
    const environment = await composeEnvironment(currentState.current);
    const portResult = await run(
      dockerPath,
      composeArgs(composePath, ['port', 'indexer', INDEXER_PORT]),
      environment,
    );
    if (portResult.exitCode !== 0) {
      fail('Bot indexer is unavailable', 'bot_runtime_indexer_unavailable');
    }
    return Object.freeze({
      endpoint: parseLoopbackComposeEndpoint(portResult.stdout, 'indexer'),
      token: environment.DEVRYAN_BOT_INDEXER_TOKEN,
    });
  };

  const probeComputerIsolation = async (input) => {
    if (!exactObject(input, ['isolationTier'])
      || !['standard', 'runsc'].includes(input.isolationTier)) {
      fail('Bot computer isolation probe is invalid', 'bot_runtime_request_invalid');
    }
    if (input.isolationTier === 'standard') {
      return Object.freeze({
        isolationTier: 'standard',
        available: true,
        runtimeDeclared: true,
        smokePassed: true,
      });
    }

    const dockerPath = await requireDocker();
    const desiredManifest = await loadManifest();
    const currentState = await readInstallationState(desiredManifest);
    if (!currentState?.current || currentState.current.fingerprint !== desiredManifest.fingerprint) {
      fail('Bot runtime setup or update is required', 'bot_runtime_update_required');
    }
    const environment = await composeEnvironment(currentState.current);
    const runtimeResult = await run(
      dockerPath,
      ['info', '--format', '{{json .Runtimes}}'],
      environment,
    );
    let runtimes = null;
    try {
      runtimes = runtimeResult.exitCode === 0 ? JSON.parse(runtimeResult.stdout.trim()) : null;
    } catch {
      runtimes = null;
    }
    if (!runtimes || typeof runtimes !== 'object' || Array.isArray(runtimes)
      || !Object.hasOwn(runtimes, 'runsc')) {
      return Object.freeze({
        isolationTier: 'runsc',
        available: false,
        runtimeDeclared: false,
        smokePassed: false,
        code: 'bot_runtime_runsc_unavailable',
      });
    }

    const probeName = `devryan-bot-runsc-probe-${crypto.randomBytes(8).toString('hex')}`;
    const image = currentState.current.images.computer.reference;
    const smoke = await run(dockerPath, [
      'run', '--rm', '--name', probeName,
      '--runtime', 'runsc',
      '--network', 'none',
      '--read-only',
      '--memory', '64m',
      '--cpus', '0.25',
      '--pids-limit', '32',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--label', 'devryan.runtime=production-bots',
      '--label', `devryan.deployment=${environment.DEVRYAN_BOT_DEPLOYMENT_ID}`,
      '--label', 'devryan.kind=runsc-probe',
      '--entrypoint', '/bin/true',
      image,
    ], environment);
    return Object.freeze({
      isolationTier: 'runsc',
      available: smoke.exitCode === 0,
      runtimeDeclared: true,
      smokePassed: smoke.exitCode === 0,
      ...(smoke.exitCode === 0 ? {} : { code: 'bot_runtime_runsc_smoke_failed' }),
    });
  };

  const inspectProfileVolume = async (context, botId, scopeKey) => {
    const identity = browserProfileIdentity(context.deploymentId, botId, scopeKey);
    const inspected = await run(context.dockerPath, [
      'volume',
      'inspect',
      '--format',
      '{{json .Labels}}',
      identity.volumeName,
    ], context.environment);
    if (inspected.exitCode !== 0) {
      if (/no such volume/i.test(`${inspected.stderr}\n${inspected.stdout}`)) {
        return { identity, exists: false };
      }
      fail('Bot browser profile inventory failed', 'bot_runtime_profile_archive_failed');
    }
    let labels;
    try {
      labels = JSON.parse(inspected.stdout.trim());
    } catch {
      fail('Bot browser profile volume metadata is invalid', 'bot_runtime_profile_archive_invalid');
    }
    if (!labels || Object.entries(identity.labels).some(([key, value]) => labels[key] !== value)) {
      fail('Bot browser profile volume ownership is invalid', 'bot_runtime_profile_archive_invalid');
    }
    return { identity, exists: true };
  };

  const inspectListedProfileVolume = async (context, botId, volumeName) => {
    const match = BROWSER_PROFILE_VOLUME_PATTERN.exec(volumeName);
    if (!match) {
      fail('Bot browser profile inventory is invalid', 'bot_runtime_profile_archive_invalid');
    }
    const inspected = await run(context.dockerPath, [
      'volume',
      'inspect',
      '--format',
      '{{json .Labels}}',
      volumeName,
    ], context.environment);
    if (inspected.exitCode !== 0) {
      fail('Bot browser profile inventory failed', 'bot_runtime_profile_archive_failed');
    }
    let labels;
    try {
      labels = JSON.parse(inspected.stdout.trim());
    } catch {
      fail('Bot browser profile volume metadata is invalid', 'bot_runtime_profile_archive_invalid');
    }
    const scopeDigest = labels?.['devryan.scope'];
    if (labels?.['devryan.runtime'] !== 'production-bots'
      || labels?.['devryan.deployment'] !== context.deploymentId
      || labels?.['devryan.bot'] !== botId
      || labels?.['devryan.kind'] !== 'computer'
      || labels?.['devryan.volume-role'] !== 'profile'
      || typeof scopeDigest !== 'string'
      || !/^sha256:[0-9a-f]{64}$/.test(scopeDigest)
      || scopeDigest.slice('sha256:'.length, 'sha256:'.length + 24) !== match[1]) {
      fail('Bot browser profile volume ownership is invalid', 'bot_runtime_profile_archive_invalid');
    }
  };

  const resolveProfileRecoveryContext = async () => {
    const supervisor = await resolveSupervisorContext();
    const dockerPath = await requireDocker();
    const desiredManifest = await loadManifest();
    const currentState = await readInstallationState(desiredManifest);
    if (!currentState?.current || currentState.current.fingerprint !== desiredManifest.fingerprint) {
      fail('Bot runtime update is required', 'bot_runtime_update_required');
    }
    const environment = await composeEnvironment(currentState.current);
    return Object.freeze({
      ...supervisor,
      dockerPath,
      environment,
      computerImage: currentState.current.images.computer.reference,
    });
  };

  const createRecoveryDirectory = async () => {
    if (!hostRuntimeRoot) {
      fail('Bot runtime recovery storage is unavailable', 'bot_runtime_profile_archive_invalid');
    }
    const root = path.join(hostRuntimeRoot, 'recovery');
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.chmod(root, 0o700);
    const directory = await fs.mkdtemp(path.join(root, 'profile-'));
    // Only the 0700 parent is host-visible. The mounted child must be writable
    // by the fixed non-root container UID used by the signed computer image.
    await fs.chmod(directory, 0o777);
    return directory;
  };

  const profileTarContainerArgs = (context, directory) => ([
    'run', '--rm', '--network', 'none', '--read-only',
    '--memory', '512m', '--cpus', '1', '--pids-limit', '64',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--user', '10001:10001',
    '--volume', `${directory}:/archive:ro`,
    '--entrypoint', '/bin/tar',
    context.computerImage,
  ]);

  const validateProfileTar = async (context, directory) => {
    const namesResult = await run(context.dockerPath, [
      ...profileTarContainerArgs(context, directory),
      '--list', '--gzip', '--file', '/archive/profile.tgz', '--quoting-style=escape',
    ], context.environment);
    if (namesResult.exitCode !== 0) {
      fail('Bot browser profile archive is invalid', 'bot_runtime_profile_archive_invalid');
    }
    const names = namesResult.stdout.split(/\r?\n/).filter(Boolean);
    if (names.length < 1 || names.length > BROWSER_PROFILE_ENTRY_LIMIT || names.some((name) => {
      if (name.length > 4_096 || (name !== '.' && name !== './' && !name.startsWith('./'))) {
        return true;
      }
      return name.split('/').some((segment) => segment === '..');
    })) {
      fail('Bot browser profile archive paths are invalid', 'bot_runtime_profile_archive_invalid');
    }

    const metadataResult = await run(context.dockerPath, [
      ...profileTarContainerArgs(context, directory),
      '--list', '--gzip', '--verbose', '--numeric-owner',
      '--file', '/archive/profile.tgz', '--quoting-style=escape',
    ], context.environment);
    if (metadataResult.exitCode !== 0) {
      fail('Bot browser profile archive is invalid', 'bot_runtime_profile_archive_invalid');
    }
    const entries = metadataResult.stdout.split(/\r?\n/).filter(Boolean);
    let expandedBytes = 0;
    if (entries.length !== names.length || entries.some((entry) => {
      const fields = entry.trim().split(/\s+/);
      if (!/^[d-][rwxStTs-]{9}$/.test(fields[0] || '') || !/^\d+$/.test(fields[2] || '')) {
        return true;
      }
      expandedBytes += Number(fields[2]);
      return !Number.isSafeInteger(expandedBytes) || expandedBytes > BROWSER_PROFILE_EXPANDED_LIMIT;
    })) {
      fail('Bot browser profile archive contents are invalid', 'bot_runtime_profile_archive_invalid');
    }
  };

  const runProfileTar = async ({ context, identity, directory, operation }) => {
    const archivePath = path.join(directory, 'profile.tgz');
    const exporting = operation === 'export';
    const argumentsList = [
      'run', '--rm', '--network', 'none', '--read-only',
      '--memory', '512m', '--cpus', '1', '--pids-limit', '64',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--user', '10001:10001',
      '--volume', `${identity.volumeName}:/data/chromium:${exporting ? 'ro' : 'rw'}`,
      '--volume', `${directory}:/archive:${exporting ? 'rw' : 'ro'}`,
      '--entrypoint', '/bin/tar',
      context.computerImage,
      ...(exporting
        ? ['-czf', '/archive/profile.tgz', '--numeric-owner', '-C', '/data/chromium', '.']
        : ['-xzf', '/archive/profile.tgz', '--no-same-owner', '--no-same-permissions',
            '--no-overwrite-dir', '-C', '/data/chromium']),
    ];
    const result = await run(context.dockerPath, argumentsList, context.environment);
    if (result.exitCode !== 0) {
      fail(
        exporting ? 'Bot browser profile export failed' : 'Bot browser profile restore failed',
        'bot_runtime_profile_archive_failed',
      );
    }
    return archivePath;
  };

  const exportBrowserProfilesInternal = async (botId, rawScopes) => {
    const scopes = normalizeBrowserProfileScopes(botId, rawScopes);
    const context = await resolveProfileRecoveryContext();
    const profiles = [];
    let totalBytes = 0;
    try {
      for (const scopeKey of scopes) {
        const inspected = await inspectProfileVolume(context, botId, scopeKey);
        if (!inspected.exists) continue;
        await postSupervisor(context, SUPERVISOR_OPERATIONS.stop, {
          kind: 'computer', botId, scopeKey,
        });
        const directory = await createRecoveryDirectory();
        try {
          const archivePath = await runProfileTar({
            context,
            identity: inspected.identity,
            directory,
            operation: 'export',
          });
          const stat = await fs.lstat(archivePath);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1
            || stat.size > BROWSER_PROFILE_RAW_LIMIT - totalBytes) {
            fail('Bot browser profile export is too large', 'bot_runtime_profile_archive_invalid');
          }
          const archive = await fs.readFile(archivePath);
          try {
            totalBytes += archive.byteLength;
            profiles.push({
              scopeKey,
              sha256: crypto.createHash('sha256').update(archive).digest('hex'),
              size: archive.byteLength,
              archiveBase64: archive.toString('base64'),
            });
          } finally {
            archive.fill(0);
          }
        } finally {
          await fs.rm(directory, { recursive: true, force: true });
        }
      }
      const bytes = Buffer.from(JSON.stringify({
        format: BROWSER_PROFILE_ARCHIVE_FORMAT,
        version: BROWSER_PROFILE_ARCHIVE_VERSION,
        botId,
        profiles,
      }), 'utf8');
      if (bytes.byteLength > BROWSER_PROFILE_ARCHIVE_LIMIT) {
        bytes.fill(0);
        fail('Bot browser profile export is too large', 'bot_runtime_profile_archive_invalid');
      }
      return bytes;
    } finally {
      for (const profile of profiles) profile.archiveBase64 = '';
    }
  };

  const inspectBrowserProfilesInternal = async (botId, bytes) => {
    const profiles = parseBrowserProfileArchive(botId, bytes);
    try {
      const context = await resolveProfileRecoveryContext();
      for (const profile of profiles) {
        const inspected = await inspectProfileVolume(context, botId, profile.scopeKey);
        if (inspected.exists) {
          fail('Bot browser profile restore would overwrite a volume', 'bot_recovery_collision');
        }
        const directory = await createRecoveryDirectory();
        const archivePath = path.join(directory, 'profile.tgz');
        let handle;
        try {
          handle = await fs.open(archivePath, 'wx', 0o644);
          await handle.writeFile(profile.archive);
          await handle.chmod(0o644);
          await handle.sync();
          await handle.close();
          handle = null;
          await validateProfileTar(context, directory);
        } finally {
          await handle?.close().catch(() => undefined);
          await fs.rm(directory, { recursive: true, force: true });
        }
      }
      return Object.freeze({ profileCount: profiles.length });
    } finally {
      for (const profile of profiles) profile.archive.fill(0);
    }
  };

  const restoreBrowserProfilesInternal = async (botId, bytes) => {
    await inspectBrowserProfilesInternal(botId, bytes);
    const profiles = parseBrowserProfileArchive(botId, bytes);
    const context = await resolveProfileRecoveryContext();
    const createdVolumes = [];
    try {
      for (const profile of profiles) {
        const identity = browserProfileIdentity(context.deploymentId, botId, profile.scopeKey);
        const createArgs = ['volume', 'create'];
        for (const [key, value] of Object.entries(identity.labels)) {
          createArgs.push('--label', `${key}=${value}`);
        }
        createArgs.push(identity.volumeName);
        const created = await run(context.dockerPath, createArgs, context.environment);
        if (created.exitCode !== 0) {
          fail('Bot browser profile volume could not be created', 'bot_runtime_profile_archive_failed');
        }
        createdVolumes.push(identity.volumeName);
        await inspectProfileVolume(context, botId, profile.scopeKey);
        const directory = await createRecoveryDirectory();
        const archivePath = path.join(directory, 'profile.tgz');
        let handle;
        try {
          handle = await fs.open(archivePath, 'wx', 0o644);
          await handle.writeFile(profile.archive);
          await handle.chmod(0o644);
          await handle.sync();
          await handle.close();
          handle = null;
          await validateProfileTar(context, directory);
          await runProfileTar({ context, identity, directory, operation: 'import' });
        } finally {
          await handle?.close().catch(() => undefined);
          await fs.rm(directory, { recursive: true, force: true });
        }
      }
      return Object.freeze({ restoredCount: profiles.length });
    } catch (error) {
      for (const volumeName of createdVolumes.reverse()) {
        await run(context.dockerPath, ['volume', 'rm', volumeName], context.environment)
          .catch(() => undefined);
      }
      throw error;
    } finally {
      for (const profile of profiles) profile.archive.fill(0);
    }
  };

  const deleteBrowserProfilesInternal = async (botId) => {
    if (!UUID_PATTERN.test(botId)) fail('Bot identity is invalid', 'bot_runtime_request_invalid');
    const context = await resolveProfileRecoveryContext();
    const listed = await run(context.dockerPath, [
      'volume', 'ls', '--quiet',
      '--filter', 'label=devryan.runtime=production-bots',
      '--filter', `label=devryan.deployment=${context.deploymentId}`,
      '--filter', `label=devryan.bot=${botId}`,
      '--filter', 'label=devryan.kind=computer',
      '--filter', 'label=devryan.volume-role=profile',
    ], context.environment);
    if (listed.exitCode !== 0) {
      fail('Bot browser profile inventory failed', 'bot_runtime_profile_archive_failed');
    }
    const names = listed.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if (new Set(names).size !== names.length
      || names.some((name) => !BROWSER_PROFILE_VOLUME_PATTERN.test(name))) {
      fail('Bot browser profile inventory is invalid', 'bot_runtime_profile_archive_invalid');
    }
    for (const name of names) {
      await inspectListedProfileVolume(context, botId, name);
      const removed = await run(context.dockerPath, ['volume', 'rm', name], context.environment);
      if (removed.exitCode !== 0) {
        fail('Bot browser profile cleanup failed', 'bot_runtime_profile_archive_failed');
      }
    }
    return Object.freeze({ deletedCount: names.length });
  };

  const requestIndexer = async (rawRequest) => {
    if (!rawRequest || typeof rawRequest !== 'object' || Array.isArray(rawRequest)) {
      fail('Bot indexer request is invalid', 'bot_runtime_request_invalid');
    }
    const operation = typeof rawRequest.operation === 'string' ? rawRequest.operation : '';
    const definition = INDEXER_OPERATIONS[operation];
    if (!definition || !exactObject(
      rawRequest,
      operation === 'status' ? ['operation'] : ['operation', 'body'],
    ) || (operation !== 'status'
      && (!rawRequest.body || typeof rawRequest.body !== 'object' || Array.isArray(rawRequest.body)))) {
      fail('Bot indexer request is invalid', 'bot_runtime_request_invalid');
    }
    const encoded = operation === 'status' ? null : JSON.stringify(rawRequest.body);
    if (encoded !== null && Buffer.byteLength(encoded, 'utf8') > INDEXER_REQUEST_LIMIT) {
      fail('Bot indexer request is too large', 'bot_runtime_request_invalid');
    }
    const context = await resolveIndexerContext();
    let response;
    try {
      response = await fetchImpl(`${context.endpoint}${definition.pathname}`, {
        method: definition.method,
        headers: {
          authorization: `Bearer ${context.token}`,
          accept: 'application/json',
          ...(encoded === null ? {} : { 'content-type': 'application/json' }),
        },
        ...(encoded === null ? {} : { body: encoded }),
        redirect: 'error',
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      fail('Bot indexer is unavailable', 'bot_runtime_indexer_unavailable');
    }
    const payload = await readSupervisorResponse(response);
    if (!response.ok || payload?.ok !== true) {
      fail(
        'Bot indexer request failed',
        typeof payload?.error?.code === 'string'
          ? payload.error.code
          : 'bot_runtime_indexer_request_failed',
      );
    }
    const result = operation === 'status' ? payload.status : payload.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      fail('Bot indexer response is invalid', 'bot_runtime_indexer_response_invalid');
    }
    return result;
  };

  const requestAgentEndpoint = async (rawRequest) => {
    if (!rawRequest || typeof rawRequest !== 'object' || Array.isArray(rawRequest)
      || !exactObject(rawRequest, [
        'url', 'method', 'headers', 'body', 'redirect', 'signal', 'maximumBytes',
        'purpose', 'botId', 'revisionId', 'hosts',
      ])
      || rawRequest.purpose !== 'agent'
      || !['HEAD', 'POST'].includes(rawRequest.method)
      || rawRequest.redirect !== 'manual'
      || !UUID_PATTERN.test(rawRequest.botId)
      || (rawRequest.revisionId !== null && !UUID_PATTERN.test(rawRequest.revisionId))
      || !rawRequest.headers || typeof rawRequest.headers !== 'object'
      || Array.isArray(rawRequest.headers)
      || typeof rawRequest.body !== 'string'
      || Buffer.byteLength(rawRequest.body, 'utf8') > AGENT_EGRESS_REQUEST_LIMIT
      || !Number.isSafeInteger(rawRequest.maximumBytes)
      || rawRequest.maximumBytes < 0
      || rawRequest.maximumBytes > AGENT_EGRESS_REQUEST_LIMIT) {
      fail('Bot agent egress request is invalid', 'bot_runtime_request_invalid');
    }
    let target;
    try {
      target = new URL(rawRequest.url);
    } catch {
      fail('Bot agent egress URL is invalid', 'bot_runtime_request_invalid');
    }
    if (target.protocol !== 'https:' || target.username || target.password || target.hash
      || !target.hostname) {
      fail('Bot agent egress URL is invalid', 'bot_runtime_request_invalid');
    }
    const allowedHeaderNames = new Set(['accept', 'content-type', 'authorization']);
    const headers = {};
    for (const [name, value] of Object.entries(rawRequest.headers)) {
      const normalizedName = name.toLowerCase();
      if (!allowedHeaderNames.has(normalizedName) || typeof value !== 'string'
        || value.length > 8_384 || /[\r\n\0]/u.test(value)) {
        fail('Bot agent egress headers are invalid', 'bot_runtime_request_invalid');
      }
      headers[normalizedName] = value;
    }
    const normalizedHosts = normalizeModelHosts(rawRequest.hosts);
    const expectedAuthority = normalizeModelHosts([target.host]);
    if (normalizedHosts.length !== 1 || normalizedHosts[0] !== expectedAuthority[0]) {
      fail('Bot agent egress authority is invalid', 'bot_runtime_request_invalid');
    }
    const context = await resolveSupervisorContext({ includeEgress: true });
    const issuedAt = Date.now();
    const token = createRuntimeToken({
      secret: context.egressSigningKey,
      deploymentId: context.deploymentId,
      botId: rawRequest.botId,
      revisionId: rawRequest.revisionId || rawRequest.botId,
      hosts: normalizedHosts,
      purpose: 'agent',
      activationMode: rawRequest.revisionId === null ? 'connection_health' : 'required',
      issuedAt,
      expiresAt: issuedAt + 60_000,
    });
    const proxy = new URL(context.egressEndpoint);
    return new Promise((resolve, reject) => {
      const request = http.request({
        hostname: proxy.hostname,
        port: Number(proxy.port),
        method: rawRequest.method,
        path: target.href,
        headers: {
          ...headers,
          host: target.host,
          'proxy-authorization': `Bearer ${token}`,
          ...(rawRequest.method === 'POST'
            ? { 'content-length': String(Buffer.byteLength(rawRequest.body, 'utf8')) }
            : {}),
        },
        timeout: 30_000,
      }, (response) => {
        const chunks = [];
        let total = 0;
        response.on('data', (chunk) => {
          total += chunk.byteLength;
          if (total > rawRequest.maximumBytes) {
            response.destroy();
            reject(Object.assign(new Error('Bot agent response is too large'), {
              code: 'bot_ag_ui_response_too_large',
              statusCode: 413,
            }));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.once('end', () => resolve(Object.freeze({
          status: response.statusCode || 502,
          headers: Object.freeze(Object.fromEntries(Object.entries(response.headers)
            .filter(([, value]) => typeof value === 'string'))),
          body: Buffer.concat(chunks).toString('utf8'),
          redirected: false,
        })));
        response.once('error', reject);
      });
      request.once('timeout', () => request.destroy(new Error('Bot agent endpoint timed out')));
      request.once('error', (error) => reject(Object.assign(error, {
        code: error?.code || 'bot_agent_egress_unavailable',
      })));
      const abort = () => request.destroy(Object.assign(new Error('Bot agent request was aborted'), {
        code: 'bot_agent_request_aborted',
      }));
      if (rawRequest.signal?.aborted) abort();
      else rawRequest.signal?.addEventListener?.('abort', abort, { once: true });
      if (rawRequest.method === 'POST') request.end(rawRequest.body);
      else request.end();
    });
  };

  const postSupervisor = async (context, pathname, input) => {
    let response;
    try {
      response = await fetchImpl(`${context.endpoint}${pathname}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${context.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(input),
        redirect: 'error',
        signal: AbortSignal.timeout([
          SUPERVISOR_OPERATIONS.importSharedFile,
          SUPERVISOR_OPERATIONS.exportWorkspaceImage,
        ].includes(pathname) ? 120_000 : 30_000),
      });
    } catch (error) {
      const transportCode = error?.cause?.code || error?.code;
      const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? 'timeout'
        : ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'].includes(transportCode)
          ? transportCode
          : 'transport_error';
      throw new BotRuntimeManagerError('Bot supervisor is unavailable', 'bot_runtime_supervisor_unavailable', {
        stage: 'supervisor_request', reason,
      });
    }
    const payload = await readSupervisorResponse(
      response,
      pathname === SUPERVISOR_OPERATIONS.exportWorkspaceImage
        ? GENERATED_IMAGE_RESPONSE_LIMIT
        : SUPERVISOR_RESPONSE_LIMIT,
    );
    if (!response.ok || payload?.ok !== true || !Object.hasOwn(payload, 'result')) {
      const code = typeof payload?.error?.code === 'string'
        ? payload.error.code
        : 'bot_runtime_supervisor_request_failed';
      fail('Bot supervisor request failed', code);
    }
    return payload.result;
  };

  const rotateComputerEgressCapability = async ({ result, runtimeToken, egressToken }) => {
    const origin = computerRuntimeOrigin(result);
    let lastCode = 'bot_runtime_browser_egress_rotation_failed';
    for (let attempt = 0; attempt < COMPUTER_EGRESS_ROTATION_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetchImpl(`${origin}/v1/egress/rotate`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${runtimeToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ token: egressToken }),
          redirect: 'error',
          signal: AbortSignal.timeout(500),
        });
        const payload = await readSupervisorResponse(response, 16 * 1_024);
        if (response.ok && payload?.ok === true && payload?.result?.rotated === true) return;
        lastCode = typeof payload?.error?.code === 'string'
          ? payload.error.code
          : lastCode;
        if (response.status >= 400 && response.status < 500) break;
      } catch (error) {
        lastCode = typeof error?.code === 'string' ? error.code : lastCode;
      }
      if (attempt + 1 < COMPUTER_EGRESS_ROTATION_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, COMPUTER_EGRESS_ROTATION_INTERVAL_MS));
      }
    }
    fail('Bot browser egress capability could not be rotated', lastCode);
  };

  const activateEgressRevision = async (context, input) => {
    let response;
    try {
      response = await fetchImpl(`${context.egressEndpoint}/v1/revisions/activate`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${context.egressControlToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ botId: input.botId, revisionId: input.revisionId }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      fail('Bot model egress control is unavailable', 'bot_runtime_egress_unavailable');
    }
    const payload = await readSupervisorResponse(response);
    if (!response.ok || payload?.ok !== true) {
      fail('Bot model egress revision could not be activated', 'bot_runtime_egress_unavailable');
    }
  };

  const callSupervisor = async (operation, rawInput) => {
    const pathname = SUPERVISOR_OPERATIONS[operation];
    if (!pathname) fail('Bot supervisor operation is invalid', 'bot_runtime_request_invalid');
    const input = validateSupervisorInput(operation, rawInput);
    if (operation === 'ensureReasoning') await validateReasoningDirectories(input);
    const reasoning = operation === 'ensureReasoning';
    const computer = operation === 'ensureComputer';
    const context = await resolveSupervisorContext({ includeEgress: reasoning || computer });
    let supervisorInput = input;
    if (reasoning) {
      const issuedAt = Date.now();
      const egressToken = createRuntimeToken({
        secret: context.egressSigningKey,
        deploymentId: context.deploymentId,
        botId: input.botId,
        revisionId: input.revisionId,
        hosts: input.egressHosts,
        issuedAt,
        expiresAt: issuedAt + 14 * 60 * 1000,
      });
      const { egressHosts: _egressHosts, ...reasoningInput } = input;
      supervisorInput = { ...reasoningInput, egressToken };
    } else if (computer) {
      const issuedAt = Date.now();
      const egressToken = createRuntimeToken({
        secret: context.egressSigningKey,
        deploymentId: context.deploymentId,
        botId: input.botId,
        revisionId: input.revisionId,
        hosts: input.browserEgressHosts,
        purpose: 'browser',
        networkMode: input.browserNetworkMode,
        issuedAt,
        expiresAt: issuedAt + 14 * 60 * 1_000,
      });
      const {
        browserEgressHosts: _browserEgressHosts,
        browserNetworkMode: _browserNetworkMode,
        ...computerInput
      } = input;
      void _browserEgressHosts;
      void _browserNetworkMode;
      supervisorInput = { ...computerInput, egressToken };
    }
    const rawResult = await postSupervisor(context, pathname, supervisorInput);
    if (computer) {
      try {
        await rotateComputerEgressCapability({
          result: rawResult,
          runtimeToken: input.runtimeToken,
          egressToken: supervisorInput.egressToken,
        });
      } catch (error) {
        await postSupervisor(context, SUPERVISOR_OPERATIONS.stop, {
          kind: 'computer',
          botId: input.botId,
          scopeKey: input.scopeKey,
        }).catch(() => undefined);
        throw error;
      }
    }
    if (operation === 'writeWorkspace') {
      if (!exactObject(rawResult, ['written', 'path', 'bytes', 'sha256'])
        || rawResult.written !== true || rawResult.path !== input.path
        || !Number.isSafeInteger(rawResult.bytes) || rawResult.bytes < 0
        || rawResult.bytes !== Buffer.byteLength(input.content, 'utf8')
        || typeof rawResult.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(rawResult.sha256)) {
        fail('Bot workspace write response is invalid', 'bot_runtime_supervisor_response_invalid');
      }
      return Object.freeze({ ...rawResult });
    }
    if (operation === 'importSharedFile') {
      const expectedPath = input.resourcePath
        ? `/workspace/Resources/${input.resourcePath}`
        : `/workspace/Shared/${input.channelId}/${input.messageId}/${input.filename}`;
      if (!exactObject(rawResult, ['written', 'path', 'bytes', 'sha256'])
        || rawResult.written !== true || rawResult.path !== expectedPath
        || rawResult.bytes !== input.expectedSize || rawResult.sha256 !== input.sha256) {
        fail('Bot Shared import response is invalid', 'bot_runtime_supervisor_response_invalid');
      }
      return Object.freeze({ ...rawResult });
    }
    if (operation === 'exportWorkspaceImage') {
      if (!exactObject(rawResult, [
        'path', 'filename', 'contentType', 'size', 'sha256', 'contentBase64',
      ]) || rawResult.path !== input.path
        || typeof rawResult.filename !== 'string' || rawResult.filename !== input.path.split('/').at(-1)
        || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(rawResult.contentType)
        || !Number.isSafeInteger(rawResult.size) || rawResult.size < 1
        || rawResult.size > 10 * 1024 * 1024
        || typeof rawResult.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(rawResult.sha256)
        || typeof rawResult.contentBase64 !== 'string'
        || rawResult.contentBase64.length > Math.ceil((10 * 1024 * 1024) / 3) * 4) {
        fail('Bot generated image response is invalid', 'bot_runtime_supervisor_response_invalid');
      }
      const bytes = Buffer.from(rawResult.contentBase64, 'base64');
      const canonical = bytes.toString('base64');
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      bytes.fill(0);
      if (canonical !== rawResult.contentBase64 || digest !== rawResult.sha256
        || Buffer.byteLength(rawResult.contentBase64, 'base64') !== rawResult.size) {
        fail('Bot generated image response failed integrity validation', 'bot_runtime_supervisor_response_invalid');
      }
      return Object.freeze({ ...rawResult });
    }
    if (operation === 'listWorkspace') {
      const expectedPath = input.path ?? '';
      if (!exactObject(rawResult, ['path', 'entries', 'truncated', 'state'])
        || rawResult.path !== expectedPath
        || !['running', 'stopped'].includes(rawResult.state)
        || typeof rawResult.truncated !== 'boolean'
        || !Array.isArray(rawResult.entries) || rawResult.entries.length > 500
        || rawResult.entries.some((entry) => (
          !exactObject(entry, ['path', 'name', 'type', 'size', 'mode', 'modifiedAt'])
          || typeof entry.path !== 'string' || typeof entry.name !== 'string'
          || entry.path !== (expectedPath ? `${expectedPath}/${entry.name}` : entry.name)
          || Buffer.byteLength(entry.name, 'utf8') > 255
          || entry.name === '' || entry.name === '.' || entry.name === '..'
          || entry.name.includes('/') || entry.name.includes('\\') || entry.name.includes('\0')
          || !['file', 'dir'].includes(entry.type)
          || !Number.isSafeInteger(entry.size) || entry.size < 0
          || !Number.isSafeInteger(entry.mode) || entry.mode < 0
          || (entry.modifiedAt !== null && typeof entry.modifiedAt !== 'string')
        ))) {
        fail('Bot workspace listing response is invalid', 'bot_runtime_supervisor_response_invalid');
      }
      return Object.freeze({
        state: rawResult.state,
        path: rawResult.path,
        entries: Object.freeze(rawResult.entries.map((entry) => Object.freeze({ ...entry }))),
        truncated: rawResult.truncated,
      });
    }
    if (operation === 'listFilesystem') {
      const expectedPath = input.path ?? '';
      if (!exactObject(rawResult, ['path', 'entries', 'truncated', 'state'])
        || rawResult.path !== expectedPath || Buffer.byteLength(rawResult.path, 'utf8') > 1024
        || !['running', 'stopped'].includes(rawResult.state)
        || typeof rawResult.truncated !== 'boolean'
        || !Array.isArray(rawResult.entries) || rawResult.entries.length > 500
        || rawResult.entries.some((entry) => (
          !exactObject(entry, [
            'path', 'name', 'kind', 'size', 'mode', 'modifiedAt', 'restricted',
          ])
          || typeof entry.path !== 'string' || typeof entry.name !== 'string'
          || entry.path !== (expectedPath ? `${expectedPath}/${entry.name}` : entry.name)
          || Buffer.byteLength(entry.name, 'utf8') > 255
          || entry.name === '' || entry.name === '.' || entry.name === '..'
          || entry.name.includes('/') || entry.name.includes('\\') || entry.name.includes('\0')
          || !['file', 'directory', 'symlink', 'special'].includes(entry.kind)
          || !Number.isSafeInteger(entry.size) || entry.size < 0
          || !Number.isSafeInteger(entry.mode) || entry.mode < 0
          || (entry.modifiedAt !== null && typeof entry.modifiedAt !== 'string')
          || typeof entry.restricted !== 'boolean'
        ))) {
        fail('Bot container listing response is invalid', 'bot_runtime_supervisor_response_invalid');
      }
      return Object.freeze({
        state: rawResult.state,
        path: rawResult.path,
        entries: Object.freeze(rawResult.entries.map((entry) => Object.freeze({ ...entry }))),
        truncated: rawResult.truncated,
      });
    }
    const result = operation === 'ensureReasoning'
      || (operation === 'inspect' && input.kind === 'reasoning')
      ? exposeReasoningProxyEndpoint(context.endpoint, rawResult)
      : rawResult;
    if (reasoning) {
      try {
        await activateEgressRevision(context, input);
      } catch (error) {
        await postSupervisor(context, SUPERVISOR_OPERATIONS.stop, {
          kind: 'reasoning',
          botId: input.botId,
          scopeKey: input.scopeKey,
        }).catch(() => undefined);
        throw error;
      }
    }
    return result;
  };

  const inspectImages = async (dockerPath, manifest, deadlineAt = null) => {
    const issues = [];
    for (const key of BOT_RUNTIME_IMAGE_KEYS) {
      const image = manifest.images[key];
      const result = await run(dockerPath, [
        'image',
        'inspect',
        '--format',
        '{{json .RepoDigests}}',
        image.reference,
      ], baseEnvironment, deadlineAt);
      if (result.exitCode !== 0) {
        issues.push({ code: 'image_missing', image: key, message: `Bot runtime image ${key} is missing` });
        continue;
      }
      if (manifest.channel === 'release'
        && !parseRepoDigests(result.stdout).includes(image.reference)) {
        issues.push({
          code: 'image_digest_mismatch',
          image: key,
          message: `Bot runtime image ${key} does not match its release digest`,
        });
      }
    }
    return issues;
  };

  const inspectServices = async (dockerPath, manifest, deadlineAt = null) => {
    const result = await run(
      dockerPath,
      composeArgs(composePath, ['ps', '--format', 'json']),
      await composeEnvironment(manifest),
      deadlineAt,
    );
    if (result.exitCode !== 0) {
      return [{ code: 'compose_unavailable', message: 'Bot runtime service status is unavailable' }];
    }
    return serviceIssues(parseComposeRows(result.stdout));
  };

  const waitForHealthyServices = async (
    dockerPath,
    manifest,
    failureCode,
    deadlineAt = null,
  ) => {
    publishProgress({ phase: 'verifying_health' });
    const healthDeadline = Math.min(
      deadlineAt ?? Number.POSITIVE_INFINITY,
      now() + DEFAULT_SERVICE_HEALTH_TIMEOUT_MS,
    );
    while (true) {
      let issues;
      try {
        issues = await inspectServices(dockerPath, manifest, healthDeadline);
      } catch (error) {
        if (error?.code === 'bot_runtime_startup_timeout' && now() >= healthDeadline) {
          fail('Bot runtime services did not become healthy before the readiness deadline', failureCode);
        }
        throw error;
      }
      if (issues.length === 0) return;
      const stoppedService = issues.find((issue) => issue.code === 'service_stopped');
      if (stoppedService) fail(stoppedService.message, failureCode);
      const remainingMs = healthDeadline - now();
      if (remainingMs <= 0) {
        fail('Bot runtime services did not become healthy before the readiness deadline', failureCode);
      }
      await wait(Math.min(SERVICE_HEALTH_POLL_INTERVAL_MS, remainingMs));
    }
  };

  const runtimeStatus = async ({
    dockerPath,
    currentState,
    desiredManifest,
    changed,
    deadlineAt = null,
  }) => {
    publishProgress({ phase: 'verifying_images' });
    const imageIssues = await inspectImages(dockerPath, currentState.current, deadlineAt);
    if (imageIssues.some((issue) => issue.code === 'image_digest_mismatch')) {
      return {
        ...baseStatus({
          state: 'runtime_update_required',
          code: 'bot_runtime_update_required',
          currentState,
          desiredManifest,
          issues: imageIssues,
        }),
        changed,
      };
    }
    if (imageIssues.length > 0) {
      return {
        ...baseStatus({
          state: 'degraded',
          code: 'bot_runtime_degraded',
          currentState,
          desiredManifest,
          issues: imageIssues,
        }),
        changed,
      };
    }
    publishProgress({ phase: 'verifying_health' });
    const issues = await inspectServices(dockerPath, currentState.current, deadlineAt);
    const warnings = await probeEngineMemoryWarnings(dockerPath, deadlineAt);
    return {
      ...baseStatus({
        state: issues.length === 0 ? 'healthy' : 'degraded',
        code: issues.length === 0 ? null : 'bot_runtime_degraded',
        currentState,
        desiredManifest,
        issues,
        warnings,
      }),
      changed,
    };
  };

  const pullAndVerify = async (dockerPath, manifest, failureCode, deadlineAt = null) => {
    if (manifest.channel === 'development') {
      publishProgress({ phase: 'verifying_images' });
      const issues = await inspectImages(dockerPath, manifest, deadlineAt);
      if (issues.length > 0) {
        fail('Local development Bot runtime images are missing; build them before setup', failureCode);
      }
      return;
    }
    for (const [index, key] of BOT_RUNTIME_IMAGE_KEYS.entries()) {
      publishProgress({
        phase: 'downloading_image',
        completed: index,
        total: BOT_RUNTIME_IMAGE_KEYS.length,
      });
      const result = await run(
        dockerPath,
        ['pull', manifest.images[key].reference],
        baseEnvironment,
        deadlineAt,
      );
      if (result.exitCode !== 0) {
        fail(classifyImagePullFailure(key, result), failureCode);
      }
    }
    publishProgress({
      phase: 'verifying_images',
      completed: BOT_RUNTIME_IMAGE_KEYS.length,
      total: BOT_RUNTIME_IMAGE_KEYS.length,
    });
    const issues = await inspectImages(dockerPath, manifest, deadlineAt);
    if (issues.length > 0) fail('Pulled Bot runtime images failed verification', failureCode);
  };

  const composeUp = async (dockerPath, manifest, failureCode, deadlineAt = null) => {
    publishProgress({ phase: 'starting_services' });
    const result = await run(
      dockerPath,
      composeArgs(composePath, ['up', '--detach', '--remove-orphans']),
      await composeEnvironment(manifest),
      deadlineAt,
    );
    if (result.exitCode !== 0) fail('Unable to start the Bot runtime', failureCode);
  };

  const activatedStatus = async ({
    dockerPath,
    currentState,
    desiredManifest,
    changed,
    failureCode,
    deadlineAt = null,
  }) => {
    await waitForHealthyServices(
      dockerPath,
      currentState.current,
      failureCode,
      deadlineAt,
    );
    return {
      ...baseStatus({
        state: 'healthy',
        code: null,
        currentState,
        desiredManifest,
        issues: [],
      }),
      changed,
    };
  };

  const setupInternal = async ({ deadlineAt = null } = {}) => {
    const dockerPath = await requireDocker(deadlineAt);
    const desiredManifest = await loadManifest();
    const existing = await readInstallationState(desiredManifest);
    if (existing?.current) {
      const result = await runtimeStatus({
        dockerPath,
        currentState: existing,
        desiredManifest,
        changed: false,
        deadlineAt,
      });
      if (existing.current.fingerprint !== desiredManifest.fingerprint && result.state === 'healthy') {
        return {
          ...baseStatus({
            state: 'runtime_update_required',
            code: 'bot_runtime_update_required',
            currentState: existing,
            desiredManifest,
            issues: [{ code: 'manifest_changed', message: 'A Bot runtime update is available' }],
          }),
          changed: false,
        };
      }
      return result;
    }
    await pullAndVerify(dockerPath, desiredManifest, 'bot_runtime_setup_failed', deadlineAt);
    await composeUp(dockerPath, desiredManifest, 'bot_runtime_setup_failed', deadlineAt);
    const nextState = {
      version: BOT_RUNTIME_STATE_VERSION,
      current: desiredManifest,
      previous: null,
      staged: null,
    };
    const status = await activatedStatus({
      dockerPath,
      currentState: nextState,
      desiredManifest,
      changed: true,
      failureCode: 'bot_runtime_setup_failed',
      deadlineAt,
    });
    await installationState.write(nextState);
    return status;
  };

  const repairInternal = async ({ deadlineAt = null } = {}) => {
    const dockerPath = await requireDocker(deadlineAt);
    const desiredManifest = await loadManifest();
    const currentState = await readInstallationState(desiredManifest);
    if (!currentState?.current) return setupInternal({ deadlineAt });
    publishProgress({ phase: 'verifying_images' });
    const imageIssues = await inspectImages(dockerPath, currentState.current, deadlineAt);
    const services = imageIssues.length === 0
      ? await inspectServices(dockerPath, currentState.current, deadlineAt)
      : [];
    if (imageIssues.length === 0 && services.length === 0 && !currentState.staged) {
      return {
        ...baseStatus({
          state: currentState.current.fingerprint === desiredManifest.fingerprint
            ? 'healthy'
            : 'runtime_update_required',
          code: currentState.current.fingerprint === desiredManifest.fingerprint
            ? null
            : 'bot_runtime_update_required',
          currentState,
          desiredManifest,
          issues: currentState.current.fingerprint === desiredManifest.fingerprint
            ? []
            : [{ code: 'manifest_changed', message: 'A Bot runtime update is available' }],
        }),
        changed: false,
      };
    }
    await pullAndVerify(
      dockerPath,
      currentState.current,
      'bot_runtime_repair_failed',
      deadlineAt,
    );
    await composeUp(dockerPath, currentState.current, 'bot_runtime_repair_failed', deadlineAt);
    const repairedState = { ...currentState, staged: null };
    const status = await activatedStatus({
      dockerPath,
      currentState: repairedState,
      desiredManifest,
      changed: true,
      failureCode: 'bot_runtime_repair_failed',
      deadlineAt,
    });
    await installationState.write(repairedState);
    return status;
  };

  const updateInternal = async ({ deadlineAt = null } = {}) => {
    const dockerPath = await requireDocker(deadlineAt);
    const desiredManifest = await loadManifest();
    const currentState = await readInstallationState(desiredManifest);
    if (!currentState?.current) return setupInternal({ deadlineAt });
    if (currentState.current.fingerprint === desiredManifest.fingerprint) {
      return repairInternal({ deadlineAt });
    }

    const stagedState = { ...currentState, staged: desiredManifest };
    await installationState.write(stagedState);
    try {
      await pullAndVerify(dockerPath, desiredManifest, 'bot_runtime_update_failed', deadlineAt);
      await composeUp(dockerPath, desiredManifest, 'bot_runtime_update_failed', deadlineAt);
    } catch (error) {
      if (error instanceof BotRuntimeManagerError) throw error;
      fail('Unable to update the Bot runtime', 'bot_runtime_update_failed');
    }
    const updatedState = {
      version: BOT_RUNTIME_STATE_VERSION,
      current: desiredManifest,
      previous: currentState.current,
      staged: null,
    };
    const status = await activatedStatus({
      dockerPath,
      currentState: updatedState,
      desiredManifest,
      changed: true,
      failureCode: 'bot_runtime_update_failed',
      deadlineAt,
    });
    await installationState.write(updatedState);
    return status;
  };

  const rollbackInternal = async ({ deadlineAt = null } = {}) => {
    const dockerPath = await requireDocker(deadlineAt);
    const desiredManifest = await loadManifest();
    const currentState = await readInstallationState(desiredManifest);
    if (!currentState?.current || (!currentState.previous && !currentState.staged)) {
      fail('No prior Bot runtime release is available', 'bot_runtime_rollback_unavailable');
    }
    const recoveringStagedUpdate = Boolean(currentState.staged);
    const rollbackManifest = recoveringStagedUpdate
      ? currentState.current
      : currentState.previous;
    await pullAndVerify(dockerPath, rollbackManifest, 'bot_runtime_rollback_failed', deadlineAt);
    await composeUp(dockerPath, rollbackManifest, 'bot_runtime_rollback_failed', deadlineAt);
    const rolledBackState = recoveringStagedUpdate
      ? { ...currentState, staged: null }
      : {
          version: BOT_RUNTIME_STATE_VERSION,
          current: rollbackManifest,
          previous: currentState.current,
          staged: null,
        };
    const status = await activatedStatus({
      dockerPath,
      currentState: rolledBackState,
      desiredManifest,
      changed: true,
      failureCode: 'bot_runtime_rollback_failed',
      deadlineAt,
    });
    await installationState.write(rolledBackState);
    return status;
  };

  const serializeMutation = (operation) => {
    const next = mutation.then(operation, operation);
    mutation = next.catch(() => undefined);
    return next;
  };

  const statusInternal = async ({ deadlineAt = null } = {}) => {
    const probe = await probeDocker(deadlineAt);
    if (probe.status) return probe.status;
    let desiredManifest;
    try {
      desiredManifest = await loadManifest();
    } catch (error) {
      return baseStatus({
        state: 'setup_required',
        code: 'bot_runtime_setup_required',
        currentState: null,
        desiredManifest: null,
        issues: [{
          code: error?.code || 'bot_runtime_manifest_invalid',
          message: 'Bot runtime release metadata is unavailable',
        }],
      });
    }
    const currentState = await readInstallationState(desiredManifest);
    if (!currentState?.current) {
      return baseStatus({
        state: 'setup_required',
        code: 'bot_runtime_setup_required',
        currentState,
        desiredManifest,
        issues: currentState?.invalid
          ? [currentState.invalid]
          : [{ code: 'setup_required', message: 'Bot runtime setup is required' }],
      });
    }
    if (currentState.staged) {
      return baseStatus({
        state: 'degraded',
        code: 'bot_runtime_degraded',
        currentState,
        desiredManifest,
        issues: [{ code: 'staged_update_incomplete', message: 'A staged Bot runtime update did not complete' }],
      });
    }
    if (currentState.current.fingerprint !== desiredManifest.fingerprint) {
      return baseStatus({
        state: 'runtime_update_required',
        code: 'bot_runtime_update_required',
        currentState,
        desiredManifest,
        issues: [{ code: 'manifest_changed', message: 'A Bot runtime update is available' }],
      });
    }
    return runtimeStatus({
      dockerPath: probe.dockerPath,
      currentState,
      desiredManifest,
      changed: false,
      deadlineAt,
    });
  };

  const lifecycleOptions = (options = {}) => {
    const deadlineMs = Number.isFinite(options?.deadlineMs)
      ? Math.floor(options.deadlineMs)
      : DEFAULT_BOT_RUNTIME_READY_DEADLINE_MS;
    if (deadlineMs < 1 || deadlineMs > DEFAULT_BOT_RUNTIME_READY_DEADLINE_MS) {
      fail('Bot runtime lifecycle deadline is invalid', 'bot_runtime_request_invalid');
    }
    return {
      deadlineAt: now() + deadlineMs,
      onProgress: typeof options?.onProgress === 'function' ? options.onProgress : null,
    };
  };

  const runLifecycle = (action, operation, options = {}) => {
    const normalized = lifecycleOptions(options);
    if (activeLifecycleOperation) {
      if (activeLifecycleOperation.action !== action) {
        fail('Another Bot runtime lifecycle action is already running', 'bot_runtime_operation_busy');
      }
      if (normalized.onProgress) {
        activeLifecycleOperation.listeners.add(normalized.onProgress);
        normalized.onProgress(operationSnapshot());
      }
      return activeLifecycleOperation.promise;
    }

    const record = {
      id: crypto.randomUUID(),
      action,
      phase: 'checking',
      completed: null,
      total: null,
      code: null,
      startedAt: new Date().toISOString(),
      listeners: new Set(normalized.onProgress ? [normalized.onProgress] : []),
      promise: null,
    };
    activeLifecycleOperation = record;
    publishProgress({ phase: 'checking' });
    record.promise = serializeMutation(async () => {
      try {
        const result = await operation({ deadlineAt: normalized.deadlineAt });
        if (result?.state !== 'healthy') {
          fail(
            result?.issues?.[0]?.message || 'Bot runtime operation did not become healthy',
            result?.code || 'bot_runtime_operation_failed',
          );
        }
        publishProgress({ phase: 'ready' });
        return result;
      } catch (error) {
        publishProgress({
          phase: 'failed',
          code: typeof error?.code === 'string' ? error.code : 'bot_runtime_operation_failed',
        });
        throw error;
      } finally {
        if (activeLifecycleOperation === record) activeLifecycleOperation = null;
      }
    });
    return record.promise;
  };

  const ensureReadyInternal = async ({ deadlineAt }) => {
    let status = await statusInternal({ deadlineAt });
    for (let transition = 0; transition < MAX_READY_TRANSITIONS; transition += 1) {
      if (status.state === 'healthy') {
        publishProgress({ phase: 'ready' });
        return { ...status, changed: transition > 0 };
      }
      if (status.state === 'setup_required') {
        await setupInternal({ deadlineAt });
      } else if (status.state === 'runtime_update_required') {
        await updateInternal({ deadlineAt });
      } else if (status.state === 'degraded') {
        await repairInternal({ deadlineAt });
      } else {
        fail(
          status.issues?.[0]?.message || 'Bot runtime is unavailable',
          status.code || 'bot_runtime_unavailable',
        );
      }
      status = await statusInternal({ deadlineAt });
    }
    if (status.state === 'healthy') {
      publishProgress({ phase: 'ready' });
      return { ...status, changed: true };
    }
    fail(
      status.issues?.[0]?.message || 'Bot runtime did not become healthy',
      status.code || 'bot_runtime_degraded',
    );
  };

  return Object.freeze({
    status: () => statusInternal(),
    operationStatus: () => operationSnapshot(),
    ensureReady: (options) => runLifecycle('ensure_ready', ensureReadyInternal, options),
    setup: (options) => runLifecycle('setup', setupInternal, options),
    repair: (options) => runLifecycle('repair', repairInternal, options),
    update: (options) => runLifecycle('update', updateInternal, options),
    rollback: (options) => runLifecycle('rollback', rollbackInternal, options),
    ensureReasoning: (input) => callSupervisor('ensureReasoning', input),
    ensureComputer: (input) => callSupervisor('ensureComputer', input),
    inspect: (input) => callSupervisor('inspect', input),
    stop: (input) => callSupervisor('stop', input),
    reset: (input) => callSupervisor('reset', input),
    writeWorkspace: (input) => callSupervisor('writeWorkspace', input),
    importSharedFile: (input) => callSupervisor('importSharedFile', input),
    exportWorkspaceImage: (input) => callSupervisor('exportWorkspaceImage', input),
    listWorkspace: (input) => callSupervisor('listWorkspace', input),
    listFilesystem: (input) => callSupervisor('listFilesystem', input),
    exportBrowserProfiles: (botId, scopes) => serializeMutation(
      () => exportBrowserProfilesInternal(botId, scopes),
    ),
    inspectBrowserProfiles: (botId, bytes) => inspectBrowserProfilesInternal(botId, bytes),
    restoreBrowserProfiles: (botId, bytes) => serializeMutation(
      () => restoreBrowserProfilesInternal(botId, bytes),
    ),
    deleteBrowserProfiles: (botId) => serializeMutation(
      () => deleteBrowserProfilesInternal(botId),
    ),
    requestIndexer,
    requestAgentEndpoint,
    probeComputerIsolation,
    paths: Object.freeze({
      composePath,
      statePath: installationState.path || null,
      runtimeRoot: hostRuntimeRoot,
    }),
  });
}
