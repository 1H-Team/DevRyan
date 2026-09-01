import path from 'node:path';
import fs from 'node:fs';
import { spawn as spawnChild } from 'node:child_process';

import { tool } from '@opencode-ai/plugin';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_BYTES = 8 * 1024;
const CLEANUP_TIMEOUT_MS = 3_000;
const MAX_CONNECTION_ENTRIES = 100;
const TURN_MESSAGE_LOOKUP_LIMIT = 200;
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);
const NO_PREVIEW_HANDOFF_MESSAGE = 'No branch preview is configured for this branch. Start or identify the local site, then retry open with its full loopback URL.';
const RETRYABLE_TRANSPORT_STATUS_CODES = new Set([502, 503, 504]);
const BROWSER_ERROR_CODES = Object.freeze({
  inputInvalid: 'DEVRYAN_BROWSER_INPUT_INVALID',
  configInvalid: 'DEVRYAN_BROWSER_CONFIG_INVALID',
  configUnavailable: 'DEVRYAN_BROWSER_CONFIG_UNAVAILABLE',
  turnLookupFailed: 'DEVRYAN_BROWSER_TURN_LOOKUP_FAILED',
  leaseAcquireFailed: 'DEVRYAN_BROWSER_LEASE_ACQUIRE_FAILED',
  leaseResponseInvalid: 'DEVRYAN_BROWSER_LEASE_RESPONSE_INVALID',
  leaseTouchFailed: 'DEVRYAN_BROWSER_LEASE_TOUCH_FAILED',
  leaseReleaseFailed: 'DEVRYAN_BROWSER_LEASE_RELEASE_FAILED',
  connectionFailed: 'DEVRYAN_BROWSER_CONNECTION_FAILED',
  commandFailed: 'DEVRYAN_BROWSER_COMMAND_FAILED',
  evalError: 'DEVRYAN_BROWSER_EVAL_ERROR',
  inspectionFailed: 'DEVRYAN_BROWSER_INSPECTION_FAILED',
  commandTimeout: 'DEVRYAN_BROWSER_COMMAND_TIMEOUT',
  commandAborted: 'DEVRYAN_BROWSER_COMMAND_ABORTED',
  branchPreviewAuthFailed: 'branch_preview_auth_failed',
});
// agent-browser 0.33.2 parses this global option before the command and accepts
// human-readable s/m/h values, normalizing them internally to milliseconds.
const MANAGED_IDLE_TIMEOUT = '2m';
const MANAGED_CONFIG_FILE = 'devryan-agent-browser.json';
const SAFE_ENVIRONMENT_KEYS = [
  'APPDATA',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WINDIR',
  'XDG_RUNTIME_DIR',
];
const ALLOWED_COMMANDS = new Set([
  'a11y',
  'back',
  'check',
  'click',
  'clipboard',
  'close',
  'console',
  'cookies',
  'dblclick',
  'diff',
  'download',
  'drag',
  'errors',
  'eval',
  'fill',
  'find',
  'focus',
  'forward',
  'get',
  'highlight',
  'hover',
  'inspect',
  'is',
  'keyboard',
  'mouse',
  'network',
  'open',
  'pdf',
  'press',
  'profiler',
  'pushstate',
  'react',
  'read',
  'record',
  'reload',
  'screenshot',
  'scroll',
  'scrollintoview',
  'select',
  'set',
  'snapshot',
  'storage',
  'tab',
  'trace',
  'type',
  'uncheck',
  'upload',
  'vitals',
  'wait',
]);
const FORBIDDEN_COMMANDS = new Set([
  'auth',
  'batch',
  'chat',
  'connect',
  'daemon',
  'dashboard',
  'doctor',
  'install',
  'launch',
  'mcp',
  'plugin',
  'profiles',
  'quit',
  'session',
  'stream',
  'upgrade',
  'exit',
]);
const FORBIDDEN_FLAGS = new Set([
  '--action-policy',
  '--allow-file-access',
  '--args',
  '--auto-connect',
  '--cdp',
  '--config',
  '--connect',
  '--daemon',
  '--debug-port',
  '--enable',
  '--engine',
  '--executable-path',
  '--extension',
  '--headed',
  '--idle-timeout',
  '--init-script',
  '--model',
  '--namespace',
  '--port',
  '--profile',
  '--provider',
  '--proxy',
  '--proxy-bypass',
  '--remote-debugging-port',
  '--restore',
  '--restore-save',
  '--session',
  '--session-name',
  '--state',
  '--user-data-dir',
]);

const browserError = (code, message, { cause = null, statusCode = null, retryable = false } = {}) => {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  if (cause) error.cause = cause;
  if (Number.isInteger(statusCode)) error.statusCode = statusCode;
  error.retryable = retryable === true;
  return error;
};

const requireText = (value, field, code = BROWSER_ERROR_CODES.inputInvalid) => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw browserError(code, `${field} is required`);
  return normalized;
};

const getManagedEnvironment = () => {
  const discoveryUrl = process.env.DEVRYAN_BROWSER_CDP_DISCOVERY_URL;
  const token = process.env.DEVRYAN_BROWSER_CDP_TOKEN;
  const binaryPath = process.env.DEVRYAN_AGENT_BROWSER_BIN;
  if (!discoveryUrl || !token || !binaryPath) return null;

  let parsed;
  try {
    parsed = new URL(discoveryUrl);
  } catch {
    throw browserError(BROWSER_ERROR_CODES.configInvalid, 'DevRyan agent browser discovery URL is invalid');
  }
  if (
    parsed.protocol !== 'http:'
    || parsed.hostname !== '127.0.0.1'
    || !parsed.port
    || parsed.pathname !== '/api/desktop/browser-cdp'
    || parsed.search
    || parsed.hash
  ) {
    throw browserError(
      BROWSER_ERROR_CODES.configInvalid,
      'DevRyan agent browser discovery must use the private IPv4 loopback endpoint',
    );
  }
  if (!path.isAbsolute(binaryPath)) {
    throw browserError(BROWSER_ERROR_CODES.configInvalid, 'DevRyan agent browser binary path must be absolute');
  }
  const packageRoot = path.dirname(path.dirname(binaryPath));
  const nodeModulesRoot = path.dirname(packageRoot);
  if (path.basename(packageRoot) !== 'agent-browser' || path.basename(nodeModulesRoot) !== 'node_modules') {
    throw browserError(
      BROWSER_ERROR_CODES.configInvalid,
      'DevRyan agent browser binary is outside the managed install layout',
    );
  }
  const configPath = path.join(path.dirname(nodeModulesRoot), MANAGED_CONFIG_FILE);
  const installRoot = path.dirname(nodeModulesRoot);
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).length !== 0) {
      throw new Error('invalid config');
    }
  } catch {
    throw browserError(
      BROWSER_ERROR_CODES.configUnavailable,
      'DevRyan managed agent browser config is unavailable',
    );
  }
  return {
    leasesUrl: new URL('/api/desktop/browser-leases', parsed.origin).toString(),
    token,
    binaryPath,
    configPath,
    installRoot,
  };
};

const normalizeArguments = (value) => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw browserError(BROWSER_ERROR_CODES.inputInvalid, 'args must be an array of strings');
  if (value.length > MAX_ARGUMENTS) {
    throw browserError(BROWSER_ERROR_CODES.inputInvalid, `args cannot contain more than ${MAX_ARGUMENTS} entries`);
  }
  return value.map((argument, index) => {
    if (typeof argument !== 'string') {
      throw browserError(BROWSER_ERROR_CODES.inputInvalid, `args[${index}] must be a string`);
    }
    if (Buffer.byteLength(argument) > MAX_ARGUMENT_BYTES) {
      throw browserError(BROWSER_ERROR_CODES.inputInvalid, `args[${index}] is too large`);
    }
    if (argument.includes('\0')) {
      throw browserError(BROWSER_ERROR_CODES.inputInvalid, `args[${index}] contains an invalid null byte`);
    }
    return argument;
  });
};

/**
 * agent-browser evaluates an `eval` snippet as a bare expression, so a snippet
 * using `await` fails with "await is only valid in async functions" and one
 * using `return` fails with "Illegal return statement". Three of the four
 * browser tool failures on 2026-08-21 were exactly these two errors.
 *
 * Wrapping in an async IIFE makes both work while leaving a plain expression
 * (the common case) evaluating to the same value.
 */
const ASYNC_WRAP_REQUIRED_PATTERN = /(?:^|[^.\w$])(?:await|return)\s/;
const ALREADY_WRAPPED_PATTERN = /^\s*\(\s*(?:async\s*)?(?:function\b|\()/;

export const wrapBrowserEvalSnippet = (snippet) => {
  if (typeof snippet !== 'string') return snippet;
  const trimmed = snippet.trim();
  if (!trimmed) return snippet;
  if (!ASYNC_WRAP_REQUIRED_PATTERN.test(trimmed)) return snippet;
  if (ALREADY_WRAPPED_PATTERN.test(trimmed)) return snippet;
  return `(async () => { ${trimmed} })()`;
};

const normalizeInspectionText = (value, field) => {
  const text = requireText(value, field);
  if (Buffer.byteLength(text) > MAX_ARGUMENT_BYTES || text.includes('\0')) {
    throw browserError(BROWSER_ERROR_CODES.inputInvalid, `${field} is too large or contains a null byte`);
  }
  return text;
};

const normalizeInspectionNames = (value, field) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ARGUMENTS) {
    throw browserError(BROWSER_ERROR_CODES.inputInvalid, `${field} must be an array of at most ${MAX_ARGUMENTS} strings`);
  }
  return [...new Set(value.map((name, index) => normalizeInspectionText(name, `${field}[${index}]`)))];
};

const normalizeInspection = (command, args, input) => {
  const fields = ['selector', 'styles', 'attributes'];
  if (command !== 'inspect') {
    if (fields.some((field) => Object.hasOwn(input, field))) {
      throw browserError(BROWSER_ERROR_CODES.inputInvalid, 'selector, styles, and attributes are only available with inspect');
    }
    return null;
  }
  if (args.length > 0) {
    throw browserError(BROWSER_ERROR_CODES.inputInvalid, 'inspect uses selector, styles, and attributes instead of args');
  }
  const inspection = {
    selector: normalizeInspectionText(input.selector, 'selector'),
    styles: normalizeInspectionNames(input.styles, 'styles'),
    attributes: normalizeInspectionNames(input.attributes, 'attributes'),
  };
  if (Buffer.byteLength(JSON.stringify(inspection)) > MAX_ARGUMENT_BYTES) {
    throw browserError(BROWSER_ERROR_CODES.inputInvalid, 'inspect request is too large');
  }
  return inspection;
};

// A single synchronous evaluation keeps the queried element and its styles in
// the same DOM snapshot. Caller strings are JSON data, never executable source.
const buildBrowserInspectionScript = (inspection) => `(() => {
  const request = ${JSON.stringify(inspection)};
  let matches;
  try {
    matches = document.querySelectorAll(request.selector);
  } catch (error) {
    if (error?.name === 'SyntaxError') return { error: 'invalid_selector' };
    throw error;
  }
  let status = 'ambiguous';
  if (matches.length === 0) status = 'missing';
  else if (matches.length === 1) status = 'found';
  const result = {
    status,
    selector: request.selector,
    matchCount: matches.length,
    styles: {},
    attributes: {},
  };
  if (matches.length !== 1) return result;
  const element = matches[0];
  if (request.styles.length > 0) {
    const computed = getComputedStyle(element);
    result.styles = Object.fromEntries(request.styles.map(name => [name, computed.getPropertyValue(name)]));
  }
  result.attributes = Object.fromEntries(request.attributes.map(name => [name, element.getAttribute(name)]));
  return result;
})()`;

const isInspectionMap = (value, names, allowNull = false) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length
  && names.every((name) => Object.hasOwn(value, name)
    && (typeof value[name] === 'string' || (allowNull && value[name] === null)))
);

const parseBrowserInspectionResult = (output, inspection, sensitiveValues = []) => {
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    throw browserError(BROWSER_ERROR_CODES.inspectionFailed, 'Browser inspection returned invalid or truncated JSON');
  }
  if (result?.error === 'invalid_selector' && Object.keys(result).length === 1) {
    throw browserError(BROWSER_ERROR_CODES.inputInvalid, 'inspect selector is not valid CSS; correct it before trying again');
  }
  let validStatus = false;
  if (result?.status === 'found') validStatus = result.matchCount === 1;
  else if (result?.status === 'missing') validStatus = result.matchCount === 0;
  else if (result?.status === 'ambiguous') validStatus = result.matchCount > 1;
  if (!validStatus || !Number.isSafeInteger(result.matchCount)
    || result.selector !== sanitizeSensitiveText(inspection.selector, sensitiveValues)
    || !isInspectionMap(result.styles, result.status === 'found' ? inspection.styles : [])
    || !isInspectionMap(result.attributes, result.status === 'found' ? inspection.attributes : [], true)) {
    throw browserError(BROWSER_ERROR_CODES.inspectionFailed, 'Browser inspection returned an invalid result');
  }
  return result;
};

const validateInvocation = (commandInput, argsInput) => {
  const command = requireText(commandInput, 'command').toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(command)) {
    throw browserError(BROWSER_ERROR_CODES.inputInvalid, 'command must be one agent-browser command name');
  }
  if (FORBIDDEN_COMMANDS.has(command)) {
    throw browserError(
      BROWSER_ERROR_CODES.inputInvalid,
      `The ${command} command is managed by DevRyan and cannot be invoked directly`,
    );
  }
  if (!ALLOWED_COMMANDS.has(command)) {
    throw browserError(
      BROWSER_ERROR_CODES.inputInvalid,
      `The ${command} command is not available through DevRyan browser leases`,
    );
  }
  const args = normalizeArguments(argsInput);
  for (const argument of args) {
    const normalized = argument.toLowerCase();
    const flag = normalized.split('=', 1)[0];
    if (FORBIDDEN_FLAGS.has(flag) || flag === '-p') {
      throw browserError(
        BROWSER_ERROR_CODES.inputInvalid,
        `The ${flag} option is managed by DevRyan and cannot be overridden`,
      );
    }
    if (command === 'close' && (normalized === '--all' || normalized.startsWith('--all='))) {
      throw browserError(
        BROWSER_ERROR_CODES.inputInvalid,
        'close --all is not allowed; close releases only the current browser lease',
      );
    }
  }
  // The first non-flag argument to `eval` is the snippet itself.
  if (command === 'eval') {
    const snippetIndex = args.findIndex((argument) => !argument.startsWith('-'));
    if (snippetIndex >= 0) args[snippetIndex] = wrapBrowserEvalSnippet(args[snippetIndex]);
  }

  return { command, args };
};

const normalizeConfiguredPreviewUrl = (value) => {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return '';
    return parsed.toString();
  } catch {
    return '';
  }
};

const resolveOpenCommandArguments = (args, previewUrl) => {
  const configuredPreview = normalizeConfiguredPreviewUrl(previewUrl);
  if (args.length === 0) {
    if (configuredPreview) return [configuredPreview];
    return null;
  }
  if (!configuredPreview) return args;

  const urlIndex = args.findIndex((argument) => !argument.startsWith('-'));
  if (urlIndex < 0) return args;
  let requested;
  try {
    requested = new URL(args[urlIndex]);
  } catch {
    return args;
  }
  if (
    (requested.protocol !== 'http:' && requested.protocol !== 'https:')
    || !LOOPBACK_HOSTNAMES.has(requested.hostname.toLowerCase())
  ) return args;

  const previewOrigin = new URL(configuredPreview).origin;
  const mapped = new URL(`${requested.pathname}${requested.search}${requested.hash}`, previewOrigin);
  const next = [...args];
  next[urlIndex] = mapped.toString();
  return next;
};

const normalizeTimeout = (value) => {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(value)) {
    throw browserError(BROWSER_ERROR_CODES.inputInvalid, 'timeout_ms must be a finite number');
  }
  return Math.max(1, Math.min(MAX_TIMEOUT_MS, Math.trunc(value)));
};

const scrubAgentBrowserEnvironment = () => {
  const next = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    if (typeof process.env[key] === 'string') next[key] = process.env[key];
  }
  next.NO_COLOR = '1';
  return next;
};

const sanitizeSensitiveText = (value, sensitiveValues) => {
  let sanitized = typeof value === 'string' ? value : '';
  for (const sensitive of sensitiveValues) {
    if (typeof sensitive === 'string' && sensitive) sanitized = sanitized.split(sensitive).join('<redacted>');
  }
  return sanitized;
};

const runBinary = ({
  binaryPath,
  args,
  timeoutMs,
  signal,
  spawnImpl,
  sensitiveValues,
  cwd,
  errorCode = BROWSER_ERROR_CODES.commandFailed,
  callerEval = false,
}) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(browserError(BROWSER_ERROR_CODES.commandAborted, 'Agent browser command was aborted'));
    return;
  }

  let child;
  try {
    child = spawnImpl(binaryPath, args, {
      cwd,
      env: scrubAgentBrowserEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    reject(browserError(errorCode, 'Agent browser command could not be started', { cause: error }));
    return;
  }

  let settled = false;
  let capturedBytes = 0;
  let truncated = false;
  let stdout = '';
  let stderr = '';

  const capture = (target, chunk) => {
    const buffer = Buffer.from(chunk);
    const remaining = Math.max(0, MAX_OUTPUT_BYTES - capturedBytes);
    const accepted = buffer.subarray(0, remaining);
    capturedBytes += accepted.byteLength;
    if (accepted.byteLength < buffer.byteLength) truncated = true;
    if (target === 'stdout') stdout += accepted.toString('utf8');
    else stderr += accepted.toString('utf8');
  };
  child.stdout?.on('data', (chunk) => capture('stdout', chunk));
  child.stderr?.on('data', (chunk) => capture('stderr', chunk));

  let forceKillTimer = null;
  const stopChild = () => {
    try {
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, 1_000);
      forceKillTimer.unref?.();
    } catch {
    }
  };
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    stopChild();
    cleanup({ keepEscalation: true });
    reject(browserError(BROWSER_ERROR_CODES.commandTimeout, `Agent browser command timed out after ${timeoutMs} ms`));
  }, timeoutMs);
  timeout.unref?.();
  const onAbort = () => {
    if (settled) return;
    settled = true;
    stopChild();
    cleanup({ keepEscalation: true });
    reject(browserError(BROWSER_ERROR_CODES.commandAborted, 'Agent browser command was aborted'));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const cleanup = ({ keepEscalation = false } = {}) => {
    clearTimeout(timeout);
    if (!keepEscalation && forceKillTimer) clearTimeout(forceKillTimer);
    signal?.removeEventListener('abort', onAbort);
  };

  child.once('error', () => {
    if (settled) {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      return;
    }
    settled = true;
    cleanup();
    reject(browserError(errorCode, 'Agent browser command failed to execute'));
  });
  child.once('close', (code) => {
    if (settled) {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      return;
    }
    settled = true;
    cleanup();
    const combined = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n');
    const safeOutput = sanitizeSensitiveText(combined, sensitiveValues);
    const suffix = truncated ? '\n[output truncated at 65536 bytes]' : '';
    if (code !== 0) {
      // Only the pinned CLI's explicit evaluation exception envelope identifies
      // caller JavaScript misuse. Connection/process failures and our generated
      // inspect script retain their actionable runtime error codes.
      if (callerEval && /^(?:✗\s*)?Evaluation error:\s*(?:TypeError|ReferenceError|SyntaxError):/.test(safeOutput)) {
        reject(browserError(
          BROWSER_ERROR_CODES.evalError,
          `${safeOutput}${suffix}\nUse inspect for DOM/style checks, or check that an element exists before calling DOM APIs.`,
        ));
        return;
      }
      reject(browserError(
        errorCode,
        safeOutput ? `Agent browser command failed: ${safeOutput}${suffix}` : 'Agent browser command failed',
      ));
      return;
    }
    resolve(`${safeOutput}${suffix}`.trim() || 'Agent browser command completed.');
  });
});

const requestJson = async ({ environment, url, method, body, signal, errorCode }) => {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${environment.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    const aborted = signal?.aborted || error?.name === 'AbortError';
    const message = aborted
      ? 'Agent browser lease request was aborted'
      : error instanceof Error && error.message
        ? error.message
        : 'Agent browser lease request failed';
    throw browserError(
      errorCode,
      sanitizeSensitiveText(message, [environment.token, environment.binaryPath]),
      { cause: error, retryable: !aborted },
    );
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const remoteCode = typeof payload?.error?.code === 'string' ? payload.error.code.trim() : '';
    const message = typeof payload?.error?.message === 'string' && payload.error.message.trim()
      ? payload.error.message.trim()
      : `Agent browser lease request failed (${response.status})`;
    throw browserError(
      remoteCode === BROWSER_ERROR_CODES.branchPreviewAuthFailed
        ? BROWSER_ERROR_CODES.branchPreviewAuthFailed
        : errorCode,
      sanitizeSensitiveText(message, [environment.token, environment.binaryPath]),
      {
        statusCode: response.status,
        retryable: RETRYABLE_TRANSPORT_STATUS_CODES.has(response.status),
      },
    );
  }
  return payload;
};

const retryOnceOnTransportFailure = async (operation) => {
  try {
    return await operation();
  } catch (error) {
    if (error?.retryable !== true) throw error;
    return operation();
  }
};

const buildScope = (context) => ({
  opencodeSessionID: requireText(context?.sessionID, 'context.sessionID'),
  messageID: requireText(context?.messageID, 'context.messageID'),
  directory: requireText(context?.directory, 'context.directory'),
  agent: typeof context?.agent === 'string' && context.agent.trim() ? context.agent.trim() : null,
});

const unwrapResponseData = (response) => (
  response && typeof response === 'object' && 'data' in response
    ? response.data
    : response
);

const transportStatusCode = (value) => {
  const candidate = value?.statusCode
    ?? value?.status
    ?? value?.data?.statusCode
    ?? value?.data?.status
    ?? value?.error?.statusCode
    ?? value?.error?.status;
  const status = Number(candidate);
  return Number.isInteger(status) ? status : null;
};

const turnLookupError = (
  error,
  fallback = 'Cannot resolve the current browser turn',
  { retryUnknownTransport = false } = {},
) => {
  if (error?.code === BROWSER_ERROR_CODES.turnLookupFailed) return error;
  const statusCode = transportStatusCode(error);
  const aborted = error?.name === 'AbortError';
  const detail = error instanceof Error && error.message ? `${fallback}: ${error.message}` : fallback;
  return browserError(BROWSER_ERROR_CODES.turnLookupFailed, detail, {
    cause: error,
    statusCode,
    retryable: !aborted && (
      RETRYABLE_TRANSPORT_STATUS_CODES.has(statusCode)
      || (retryUnknownTransport && statusCode === null)
    ),
  });
};

const resolveTurnMessageID = async (scope, client) => {
  if (!client?.session || typeof client.session.messages !== 'function') return scope.messageID;

  const response = await retryOnceOnTransportFailure(async () => {
    let result;
    try {
      result = await client.session.messages({
        path: { id: scope.opencodeSessionID },
        query: {
          directory: scope.directory,
          limit: TURN_MESSAGE_LOOKUP_LIMIT,
        },
      });
    } catch (error) {
      throw turnLookupError(error, undefined, { retryUnknownTransport: true });
    }
    if (result?.error) throw turnLookupError(result.error);
    return result;
  });
  const records = unwrapResponseData(response);
  if (!Array.isArray(records)) {
    throw browserError(BROWSER_ERROR_CODES.turnLookupFailed, 'Cannot resolve the current browser turn');
  }

  const current = records.find((record) => record?.info?.id === scope.messageID);
  if (current?.info?.role === 'user') return scope.messageID;
  const parentID = typeof current?.info?.parentID === 'string'
    ? current.info.parentID.trim()
    : '';
  const parent = parentID
    ? records.find((record) => record?.info?.role === 'user' && record.info.id === parentID)
    : null;
  if (!parent) throw browserError(BROWSER_ERROR_CODES.turnLookupFailed, 'Cannot resolve the current browser turn');
  return parentID;
};

export const DevRyanBrowserPlugin = async (pluginContext = {}) => {
  const environment = getManagedEnvironment();
  if (!environment) return {};
  const spawnImpl = pluginContext.spawnImpl ?? spawnChild;
  const client = pluginContext.client;
  const connections = new Map();
  const connectionAttempts = new Map();
  const failedAcquisitionKeys = new Set();

  const rememberFailedAcquisition = (reuseKey) => {
    failedAcquisitionKeys.delete(reuseKey);
    failedAcquisitionKeys.add(reuseKey);
    while (failedAcquisitionKeys.size > MAX_CONNECTION_ENTRIES) {
      failedAcquisitionKeys.delete(failedAcquisitionKeys.values().next().value);
    }
  };

  const acquire = async (scope, signal) => retryOnceOnTransportFailure(() => requestJson({
    environment,
    url: environment.leasesUrl,
    method: 'POST',
    body: scope,
    signal,
    errorCode: BROWSER_ERROR_CODES.leaseAcquireFailed,
  }));

  const touch = async (leaseId, scope, signal) => requestJson({
    environment,
    url: `${environment.leasesUrl}/${encodeURIComponent(leaseId)}/touch`,
    method: 'POST',
    body: scope,
    signal,
    errorCode: BROWSER_ERROR_CODES.leaseTouchFailed,
  });

  const release = async (leaseId, scope, signal) => requestJson({
    environment,
    url: `${environment.leasesUrl}/${encodeURIComponent(leaseId)}`,
    method: 'DELETE',
    body: scope,
    signal,
    errorCode: BROWSER_ERROR_CODES.leaseReleaseFailed,
  });

  const withCleanupSignal = async (operation) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error('Agent browser cleanup timed out'));
    }, CLEANUP_TIMEOUT_MS);
    timeout.unref?.();
    try {
      return await operation(controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  };

  const releaseForCleanup = (leaseId, scope) => withCleanupSignal(
    (signal) => release(leaseId, scope, signal),
  );

  const hasConnectedLease = (reuseKey, leaseId) => {
    const cached = connections.get(reuseKey);
    if (cached?.leaseId !== leaseId) {
      if (cached) connections.delete(reuseKey);
      return false;
    }
    // Refresh insertion order so the bounded map behaves as an LRU.
    connections.delete(reuseKey);
    connections.set(reuseKey, cached);
    return true;
  };

  const rememberConnectedLease = (reuseKey, leaseId) => {
    connections.delete(reuseKey);
    connections.set(reuseKey, { leaseId });
    while (connections.size > MAX_CONNECTION_ENTRIES) {
      connections.delete(connections.keys().next().value);
    }
  };

  const connectLease = ({
    reuseKey,
    leaseId,
    wsUrl,
    prefix,
    timeoutMs,
    signal,
    sensitiveValues,
  }) => {
    if (hasConnectedLease(reuseKey, leaseId)) return Promise.resolve();

    const activeAttempt = connectionAttempts.get(reuseKey);
    if (activeAttempt?.leaseId === leaseId) return activeAttempt.promise;
    if (activeAttempt) {
      return activeAttempt.promise
        .catch(() => undefined)
        .then(() => connectLease({
          reuseKey,
          leaseId,
          wsUrl,
          prefix,
          timeoutMs,
          signal,
          sensitiveValues,
        }));
    }

    const promise = runBinary({
      binaryPath: environment.binaryPath,
      args: [...prefix, 'connect', wsUrl],
      timeoutMs,
      signal,
      spawnImpl,
      sensitiveValues,
      cwd: environment.installRoot,
      errorCode: BROWSER_ERROR_CODES.connectionFailed,
    }).then(() => {
      rememberConnectedLease(reuseKey, leaseId);
    }).finally(() => {
      if (connectionAttempts.get(reuseKey)?.promise === promise) {
        connectionAttempts.delete(reuseKey);
      }
    });
    connectionAttempts.set(reuseKey, { leaseId, promise });
    return promise;
  };

  return {
    tool: {
      devryan_browser: tool({
        description: 'Drive a temporary DevRyan in-app browser lease for website inspection and visual verification. Prefer inspect with a CSS selector and optional styles/attributes for safe DOM checks; it reports found, missing, or ambiguous without changing the page. A missing result is not successful visual verification. Call open without a URL first: the assigned branch preview opens when configured, otherwise DevRyan returns successful guidance to start or identify the local site and retry with its full loopback URL. Explicit loopback URLs are mapped to the assigned preview when configured. DevRyan owns connection, process, profile, namespace, and session options. Always call close when verification is finished.',
        args: {
          command: tool.schema.string().describe('One browser command, such as open, snapshot, inspect, click, fill, reload, screenshot, or close.'),
          args: tool.schema.array(tool.schema.string()).optional().describe('Command arguments as an ordered string array. Do not pass connection, process, profile, namespace, session, or daemon options.'),
          selector: tool.schema.string().optional().describe('Required only for inspect: a CSS selector. Exactly one match is needed to read values.'),
          styles: tool.schema.array(tool.schema.string()).optional().describe('Inspect only: CSS property names, such as animation-duration or --accent. Defaults to an empty array.'),
          attributes: tool.schema.array(tool.schema.string()).optional().describe('Inspect only: attribute names, such as data-state. Defaults to an empty array; absent values are null.'),
          timeout_ms: tool.schema.number().int().min(1).max(MAX_TIMEOUT_MS).optional().describe('Command timeout in milliseconds. Defaults to 30000 and is capped at 120000.'),
        },
        async execute(input, context) {
          const { command, args } = validateInvocation(input?.command, input?.args);
          const inspection = normalizeInspection(command, args, input);
          const timeoutMs = normalizeTimeout(input?.timeout_ms);
          const invocationScope = buildScope(context);
          const scope = {
            ...invocationScope,
            // OpenCode creates a fresh assistant message after every tool step.
            // Its parent user message is the stable turn identity needed to keep
            // sequential commands on one lease and one agent-browser daemon.
            messageID: await resolveTurnMessageID(invocationScope, client),
          };
          const reuseKey = `${scope.opencodeSessionID}\u0000${scope.messageID}`;
          if (command === 'close' && failedAcquisitionKeys.has(reuseKey)) {
            return 'Browser lease already closed.';
          }
          let lease;
          try {
            lease = await acquire(scope, context?.abort);
            failedAcquisitionKeys.delete(reuseKey);
          } catch (error) {
            rememberFailedAcquisition(reuseKey);
            throw error;
          }
          const leaseId = requireText(
            lease?.leaseId,
            'lease response leaseId',
            BROWSER_ERROR_CODES.leaseResponseInvalid,
          );
          const commandArgs = command === 'open'
            ? resolveOpenCommandArguments(args, lease?.previewUrl)
            : args;
          if (commandArgs === null) {
            if (lease?.created === true) {
              await releaseForCleanup(leaseId, scope).catch(() => undefined);
            }
            return NO_PREVIEW_HANDOFF_MESSAGE;
          }
          const wsUrl = requireText(
            lease?.wsUrl,
            'lease response endpoint',
            BROWSER_ERROR_CODES.leaseResponseInvalid,
          );
          const sensitiveValues = [environment.token, environment.binaryPath, environment.configPath, wsUrl];
          const prefix = [
            '--namespace', 'devryan',
            '--session', leaseId,
            '--config', environment.configPath,
            '--idle-timeout', MANAGED_IDLE_TIMEOUT,
          ];

          try {
            await connectLease({
              reuseKey,
              leaseId,
              wsUrl,
              prefix,
              timeoutMs,
              signal: context?.abort,
              sensitiveValues,
            });
          } catch (error) {
            if (lease?.created === true) {
              await releaseForCleanup(leaseId, scope).catch(() => undefined);
            }
            throw error;
          }

          if (command === 'close') {
            let commandError = null;
            try {
              await withCleanupSignal((signal) => touch(leaseId, scope, signal));
              await runBinary({
                binaryPath: environment.binaryPath,
                args: [...prefix, 'close', ...commandArgs],
                timeoutMs,
                signal: context?.abort,
                spawnImpl,
                sensitiveValues,
                cwd: environment.installRoot,
              });
            } catch (error) {
              commandError = error;
            } finally {
              connections.delete(reuseKey);
              await releaseForCleanup(leaseId, scope).catch((releaseError) => {
                if (!commandError) commandError = releaseError;
              });
            }
            if (commandError) throw commandError;
            return 'Browser lease closed.';
          }

          await touch(leaseId, scope, context?.abort);
          let result;
          let commandError = null;
          try {
            result = await runBinary({
              binaryPath: environment.binaryPath,
              args: inspection
                ? [...prefix, 'eval', buildBrowserInspectionScript(inspection)]
                : [...prefix, command, ...commandArgs],
              timeoutMs,
              signal: context?.abort,
              spawnImpl,
              sensitiveValues,
              cwd: environment.installRoot,
              callerEval: command === 'eval',
              errorCode: inspection ? BROWSER_ERROR_CODES.inspectionFailed : BROWSER_ERROR_CODES.commandFailed,
            });
            if (inspection) parseBrowserInspectionResult(result, inspection, sensitiveValues);
          } catch (error) {
            commandError = error;
          }
          try {
            await touch(leaseId, scope, context?.abort);
          } catch (touchError) {
            if (!commandError) {
              commandError = touchError;
            } else if (commandError.code === BROWSER_ERROR_CODES.evalError
              || commandError.code === BROWSER_ERROR_CODES.inputInvalid) {
              // An expected caller mistake must not hide a simultaneous host
              // failure. Both messages are already sanitized at their source.
              touchError.message += `\nBrowser command also failed: ${commandError.message}`;
              commandError = touchError;
            }
          }
          if (commandError) throw commandError;
          return result;
        },
      }),
    },
  };
};

export default DevRyanBrowserPlugin;

// OpenCode treats every ESM export from a plugin module as a plugin factory and
// rejects the whole module when even one export is not callable. Keep the test
// surface callable (and inert when OpenCode invokes it) while attaching the
// helpers Vitest needs as function properties.
export const __test = Object.assign(() => ({}), {
  BROWSER_ERROR_CODES,
  MANAGED_IDLE_TIMEOUT,
  MAX_CONNECTION_ENTRIES,
  NO_PREVIEW_HANDOFF_MESSAGE,
  getManagedEnvironment,
  buildBrowserInspectionScript,
  parseBrowserInspectionResult,
  normalizeInspection,
  normalizeArguments,
  normalizeTimeout,
  resolveOpenCommandArguments,
  runBinary,
  validateInvocation,
});
