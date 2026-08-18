import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  normalizePlanModeAssistantParts,
  PLAN_MODE_INSTRUCTION_PREFIX,
} from './plan-card-normalize.js';
import {
  configureCursorSdkRipgrep,
  resolveCursorRipgrepPath,
} from './ripgrep-path.js';
import {
  normalizeCursorSdkAgentDefinitions,
  pinCursorSdkSubagentModels,
} from './agent-definitions.js';
import {
  generateCursorSessionTitle,
  normalizeCursorSessionTitle,
} from './title-generation.js';
import { createCursorQuestionRuntime } from './cursor-question-runtime.js';

export const CURSOR_PROVIDER_ID = 'cursor-acp';

const FALLBACK_MODELS = [
  ['auto', 'Auto'],
  ['composer-2.5', 'Composer 2.5'],
  ['composer-2.5-fast', 'Composer 2.5 Fast'],
  ['composer-2', 'Composer 2'],
  ['composer-2-fast', 'Composer 2 Fast'],
  ['claude-4.6-sonnet', 'Claude 4.6 Sonnet'],
  ['claude-4.5-sonnet', 'Claude 4.5 Sonnet'],
  ['gpt-5.5', 'GPT-5.5'],
  ['gpt-5.4', 'GPT-5.4'],
  ['gpt-5.3-codex', 'GPT-5.3 Codex'],
  ['gemini-3-pro', 'Gemini 3 Pro'],
];

const COMPATIBILITY_MODEL_PAIRS = [
  ['composer-2.5', 'Composer 2.5', 'composer-2.5-fast', 'Composer 2.5 Fast'],
  ['composer-2', 'Composer 2', 'composer-2-fast', 'Composer 2 Fast'],
];

const CURSOR_MODEL_PARAM_FAST = 'fast';
const CURSOR_MODEL_PARAM_THINKING = 'thinking';
const CURSOR_MODEL_PARAM_REASONING = 'reasoning';
const CURSOR_MODEL_PARAM_EFFORT = 'effort';
const CURSOR_MODEL_PARAM_CONTEXT = 'context';
const CURSOR_MODEL_TRUE_VALUE = 'true';
const DEFAULT_MODEL_DISCOVERY_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 1500;
const CURSOR_NATIVE_ULTRA_MODEL_IDS = new Set([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
]);

const CURSOR_MODEL_EFFORT_ALIASES = new Map([
  ['none', 'none'],
  ['minimal', 'minimal'],
  ['min', 'minimal'],
  ['low', 'low'],
  ['medium', 'medium'],
  ['high', 'high'],
  ['xhigh', 'extra-high'],
  ['extra-high', 'extra-high'],
  ['max', 'max'],
  ['ultra', 'ultra'],
]);

const CURSOR_MODEL_EFFORT_DEFAULT_SCORES = new Map([
  ['medium', 50],
  ['high', 45],
  ['low', 40],
  ['extra-high', 35],
  ['max', 30],
  ['ultra', 25],
  ['minimal', 20],
  ['none', 10],
]);

const createCursorModelCapabilities = () => ({
  attachment: true,
  input: {
    text: true,
    audio: false,
    image: true,
    video: false,
    pdf: false,
  },
  output: {
    text: true,
    audio: false,
    image: false,
    video: false,
    pdf: false,
  },
});

const now = () => Date.now();

const isPlainObject = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const SYNTHETIC_WORKSPACE_PATCH_METADATA_KEY = 'syntheticWorkspacePatch';

const sanitizeProviderToolMetadata = (value) => {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== SYNTHETIC_WORKSPACE_PATCH_METADATA_KEY),
  );
};

const importRuntimeModule = (specifier) => {
  const importer = new Function('specifier', 'return import(specifier)');
  return importer(specifier);
};

const trimString = (value) => (typeof value === 'string' ? value.trim() : '');

const escapeXmlAttribute = (value) => trimString(value)
  .replaceAll('&', '&amp;')
  .replaceAll('"', '&quot;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;');

let lastIdTimestamp = 0;
let idCounter = 0;
const ID_RANDOM_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ID_RANDOM_LENGTH = 14;

const createRandomIdSuffix = () => {
  const bytes = new Uint8Array(ID_RANDOM_LENGTH);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => ID_RANDOM_CHARS[byte % ID_RANDOM_CHARS.length]).join('');
};

const createId = (prefix) => {
  const timestamp = Date.now();
  if (timestamp !== lastIdTimestamp) {
    lastIdTimestamp = timestamp;
    idCounter = 0;
  }
  idCounter += 1;

  const sortable = BigInt(timestamp) * 0x1000n + BigInt(idCounter);
  const bytes = new Uint8Array(6);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number((sortable >> BigInt(40 - 8 * index)) & 0xffn);
  }
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex}${createRandomIdSuffix()}`;
};

const createAssistantMessageId = (userMessageID) => `${userMessageID}_assistant`;

const normalizeFinish = (status) => {
  if (status === 'success') return 'stop';
  return status;
};

const finalStatusFromSdkStatus = (status) => {
  const normalized = trimString(status).toUpperCase();
  if (normalized === 'FINISHED' || normalized === 'FINISH' || normalized === 'SUCCESS' || normalized === 'STOP' || normalized === 'COMPLETED') return 'success';
  if (normalized === 'ERROR' || normalized === 'FAILED' || normalized === 'FAILURE') return 'error';
  if (normalized === 'CANCELLED' || normalized === 'CANCELED' || normalized === 'EXPIRED') return 'cancelled';
  return null;
};

const sdkStatusFromRunStatus = (status) => {
  const normalized = trimString(status).toLowerCase();
  if (normalized === 'finished' || normalized === 'complete' || normalized === 'completed' || normalized === 'done') return 'FINISHED';
  if (normalized === 'error' || normalized === 'failed' || normalized === 'failure') return 'ERROR';
  if (normalized === 'cancelled' || normalized === 'canceled') return 'CANCELLED';
  return trimString(status);
};

const finishToToolStatus = (finish) => {
  if (finish === 'error') return 'error';
  if (finish === 'cancelled') return 'cancelled';
  return 'completed';
};

const normalizeToolCallStatus = (status) => {
  const normalized = trimString(status).toLowerCase();
  if (normalized === 'completed' || normalized === 'complete' || normalized === 'done' || normalized === 'success' || normalized === 'finished') return 'completed';
  if (normalized === 'error' || normalized === 'failed' || normalized === 'failure') return 'error';
  if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled';
  if (normalized === 'pending') return 'pending';
  return 'running';
};

const isBunRuntime = () => typeof globalThis.Bun !== 'undefined';

const isDesktopRuntimeEnv = (env) => trimString(env?.OPENCHAMBER_RUNTIME).toLowerCase() === 'desktop';

const normalizeWorkerEnv = (value) => {
  if (!isPlainObject(value)) return {};
  const normalized = {};
  for (const [key, entry] of Object.entries(value)) {
    const envKey = trimString(key);
    if (!envKey || entry === undefined || entry === null) continue;
    normalized[envKey] = String(entry);
  }
  return normalized;
};

export const resolveCursorSdkWorkerRuntimeConfig = ({
  env = process.env,
  hasInjectedLoadSdk = false,
  isBunRuntime: bunRuntime = isBunRuntime(),
  isElectronRuntime = Boolean(process.versions?.electron),
  execPath = process.execPath,
  resourcesPath = process.resourcesPath,
  nodeBinaryEnv = process.env.NODE_BINARY,
  requestedNodeBinary = '',
  requestedUseNodeWorkerForPrompts,
  requestedWorkerCwd = '',
  requestedWorkerEnv,
  workerPath = '',
  ripgrepPath = '',
} = {}) => {
  const useNodeWorkerForPrompts = typeof requestedUseNodeWorkerForPrompts === 'boolean'
    ? requestedUseNodeWorkerForPrompts
    : (Boolean(bunRuntime) || isDesktopRuntimeEnv(env)) && !hasInjectedLoadSdk;
  const nodeBinary = trimString(requestedNodeBinary)
    || trimString(nodeBinaryEnv)
    || (isElectronRuntime ? trimString(execPath) : '')
    || 'node';
  const resolvedRipgrep = resolveCursorRipgrepPath({
    explicitRipgrepPath: ripgrepPath,
    env,
    resourcesPath,
  });
  const defaultWorkerEnv = {
    ...(isElectronRuntime ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    ...(resolvedRipgrep.path ? { CURSOR_SDK_RIPGREP_PATH: resolvedRipgrep.path } : {}),
  };
  const normalizedWorkerPath = trimString(workerPath);
  const workerCwd = trimString(requestedWorkerCwd)
    || (isElectronRuntime && trimString(resourcesPath)
      ? trimString(resourcesPath)
      : normalizedWorkerPath
        ? path.dirname(normalizedWorkerPath)
        : process.cwd());

  return {
    useNodeWorkerForPrompts,
    nodeBinary,
    workerCwd,
    workerEnv: {
      ...defaultWorkerEnv,
      ...normalizeWorkerEnv(requestedWorkerEnv),
    },
  };
};

const isMissingCursorAgentError = (error) => /Agent .* not found/i.test(error instanceof Error ? error.message : String(error || ''));

const safeJson = (value) => {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const readToolFailureReason = (result) => {
  if (typeof result === 'string') return trimString(result);
  if (!isPlainObject(result)) return '';
  const candidate = result.error ?? result.message ?? result.reason;
  if (typeof candidate === 'string') return trimString(candidate);
  if (isPlainObject(candidate)) {
    const nested = candidate.message ?? candidate.error ?? candidate.reason;
    if (typeof nested === 'string') return trimString(nested);
  }
  return candidate === undefined || candidate === null ? '' : trimString(safeJson(candidate));
};

const areRuntimeValuesEqual = (left, right) => left === right || safeJson(left) === safeJson(right);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const readTokenCount = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);

const parseSettingSourcesFlag = (raw) => {
  const v = trimString(raw);
  if (!v) return undefined;
  if (v.toLowerCase() === 'none') return [];
  const allowed = new Set(['project', 'user', 'team', 'mdm', 'plugins', 'all']);
  const parsed = v.split(',').map((s) => s.trim()).filter((s) => allowed.has(s));
  return parsed.length ? parsed : undefined;
};

// DevRyan cursor context trim (default OFF). OPENCHAMBER_CURSOR_SETTING_SOURCES = comma
// list of cursor setting layers (project,user,team,mdm,plugins,all) or "none" to load
// none — trims ambient rules/settings context the cursor-agent assembles per turn.
const CURSOR_SETTING_SOURCES = parseSettingSourcesFlag(process.env.OPENCHAMBER_CURSOR_SETTING_SOURCES);

const firstStringValue = (...candidates) => {
  for (const candidate of candidates) {
    if (typeof candidate === 'string') return candidate;
  }
  return '';
};

export const normalizeInteractionUpdateToSdkMessage = (input) => {
  const update = isPlainObject(input?.update) ? input.update : input;
  if (!isPlainObject(update)) return null;

  if (update.type === 'text-delta' || update.type === 'token-delta') {
    const text = firstStringValue(update.text, update.delta, update.token);
    return text
      ? {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text }],
          },
        }
      : null;
  }

  if (update.type === 'thinking-delta') {
    const text = firstStringValue(update.text, update.delta);
    return text ? { type: 'thinking', text } : null;
  }

  if (
    update.type === 'thinking-completed'
    || update.type === 'thinking_completed'
    || update.type === 'thinking-complete'
  ) {
    return { type: 'thinking_completed' };
  }

  if (
    update.type === 'tool-call-started'
    || update.type === 'partial-tool-call'
    || update.type === 'tool-call-completed'
  ) {
    const toolCall = isPlainObject(update.toolCall) ? update.toolCall : {};
    const callID = trimString(update.callId ?? update.call_id ?? toolCall.callId ?? toolCall.call_id ?? toolCall.id);
    const name = trimString(toolCall.name ?? toolCall.type ?? update.name) || 'tool';
    const explicitStatus = trimString(update.status);
    const status = explicitStatus
      ? normalizeToolCallStatus(explicitStatus)
      : update.type === 'tool-call-completed'
        ? 'completed'
        : 'running';
    return {
      type: 'tool_call',
      call_id: callID,
      name,
      status,
      ...(hasOwn(toolCall, 'args') ? { args: toolCall.args } : {}),
      ...(hasOwn(toolCall, 'result') ? { result: toolCall.result } : {}),
      ...(isPlainObject(toolCall.truncated) ? { truncated: toolCall.truncated } : {}),
    };
  }

  if (update.type === 'summary') {
    const text = trimString(update.summary ?? update.text);
    return text ? { type: 'task', text } : null;
  }

  if (update.type === 'turn-ended') {
    const usage = isPlainObject(update.usage) ? update.usage : null;
    if (!usage) return null;
    const tokens = {
      input: readTokenCount(usage.inputTokens),
      output: readTokenCount(usage.outputTokens),
      reasoning: 0,
      cache: { read: readTokenCount(usage.cacheReadTokens), write: readTokenCount(usage.cacheWriteTokens) },
    };
    const hasUsage = tokens.input || tokens.output || tokens.cache.read || tokens.cache.write;
    return hasUsage ? { type: 'usage', tokens } : null;
  }

  return null;
};

const mergeToolDataIntoState = (part) => {
  if (!isPlainObject(part) || part.type !== 'tool') {
    return { part, changed: false };
  }

  const state = isPlainObject(part.state) ? part.state : {};
  let nextState = state;
  let changed = !isPlainObject(part.state);

  const assignStateValue = (key, value, shouldAssign) => {
    if (!shouldAssign || hasOwn(nextState, key)) {
      return;
    }
    if (nextState === state) {
      nextState = { ...state };
    }
    nextState[key] = value;
    changed = true;
  };

  assignStateValue('input', part.input, isPlainObject(part.input));
  assignStateValue('output', part.output, hasOwn(part, 'output'));
  assignStateValue('metadata', part.metadata, isPlainObject(part.metadata));

  return changed ? { part: { ...part, state: nextState }, changed: true } : { part, changed: false };
};

const mergeTextDelta = (existing, incoming) => {
  const previous = typeof existing === 'string' ? existing : '';
  const next = typeof incoming === 'string' ? incoming : '';
  if (!next) return previous;
  if (!previous) return next;
  if (next.startsWith(previous)) return next;
  const needsSentenceBoundary = /[.!?)]$/.test(previous) && /^[A-Z0-9"`]/.test(next);
  return `${previous}${needsSentenceBoundary ? ' ' : ''}${next}`;
};

export const computeIncrementalTextDelta = (previousText, nextText) => {
  const previous = typeof previousText === 'string' ? previousText : '';
  const next = typeof nextText === 'string' ? nextText : '';
  if (!next || next === previous) return '';
  if (next.length > previous.length && next.startsWith(previous)) {
    return next.slice(previous.length);
  }
  return null;
};

const mergeFinalText = (existing, incoming) => {
  const previous = typeof existing === 'string' ? existing : '';
  const next = typeof incoming === 'string' ? incoming : '';
  if (!next) return previous;
  if (!previous) return next;
  if (next === previous || previous.includes(next)) return previous;
  if (next.startsWith(previous)) return next;
  return mergeTextDelta(previous, next);
};

// Streamed deltas can lose fragments (the SDK delivers text via both the
// delta callback and the stream, and cross-source dedupe occasionally drops a
// legitimate repeat), leaving streamed text that is an in-order subset of the
// final run result. Appending the final text on top of it would show the
// message twice — once garbled, once clean — so that shape must be replaced.
export const isLossyStreamedTextVariant = (streamedText, finalText) => {
  const candidate = typeof streamedText === 'string' ? streamedText : '';
  const full = typeof finalText === 'string' ? finalText : '';
  if (!candidate || !full || candidate.length >= full.length) return false;
  if (candidate.length < 16 || candidate.length * 2 < full.length) return false;
  let index = 0;
  for (const char of full) {
    if (char === candidate[index]) index += 1;
    if (index === candidate.length) return true;
  }
  return false;
};

const getSdkMessageTextFingerprint = (message) => {
  if (!isPlainObject(message)) return '';
  if (message.type === 'assistant') {
    const content = Array.isArray(message.message?.content) ? message.message.content : [];
    const text = content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');
    return text ? `assistant:${text}` : '';
  }
  if (message.type === 'thinking') {
    const text = typeof message.text === 'string' ? message.text : '';
    return text ? `thinking:${text}` : '';
  }
  return '';
};

const createCrossSourceMessageDedupe = (limit = 80) => {
  const recent = [];
  return (source, message) => {
    const fingerprint = getSdkMessageTextFingerprint(message);
    if (!fingerprint) return false;
    const duplicate = recent.some((entry) => (
      entry.fingerprint === fingerprint && entry.source !== source
    ));
    recent.push({ source, fingerprint });
    if (recent.length > limit) {
      recent.splice(0, recent.length - limit);
    }
    return duplicate;
  };
};

const DANGLING_REASONING_LIST_MARKER_PATTERN = /(?:\n\s*)+(?:[-*]|\d+[.)])\s*$/;
const SENTENCE_BOUNDARY_PATTERN = /[.!?][)"'\]]?(?=\s|$)/g;
const TOOL_ONLY_COMPLETION_SUMMARY = 'Completed the requested work. See the tool activity above for details.';
const POST_TASK_EMPTY_FINISH_DIAGNOSTIC = 'Cursor ended the parent run immediately after a subagent task completed, with no parent follow-up. DevRyan preserved the subagent output above.';

const trimDanglingReasoningFragment = (value) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return value;
  }

  const withoutDanglingMarker = value.replace(DANGLING_REASONING_LIST_MARKER_PATTERN, '').trimEnd();
  if (withoutDanglingMarker === value) {
    return value;
  }

  let lastBoundaryEnd = -1;
  for (const match of withoutDanglingMarker.matchAll(SENTENCE_BOUNDARY_PATTERN)) {
    lastBoundaryEnd = match.index + match[0].length;
  }
  if (lastBoundaryEnd > 0 && lastBoundaryEnd < withoutDanglingMarker.length) {
    return withoutDanglingMarker.slice(0, lastBoundaryEnd).trim();
  }

  return withoutDanglingMarker;
};

const withTimeout = async (promise, timeoutMs) => {
  if (!promise) return null;
  const boundedTimeoutMs = Math.max(0, Number(timeoutMs) || 0);
  if (!boundedTimeoutMs) return promise;

  let timeout = null;
  const timeoutPromise = new Promise((resolve) => {
    timeout = setTimeout(() => resolve(null), boundedTimeoutMs);
    timeout.unref?.();
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const createAsyncQueue = () => {
  const values = [];
  const waiters = [];
  let closed = false;

  return {
    push(value) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ done: false, value });
        return;
      }
      values.push(value);
    },
    close() {
      if (closed) return;
      closed = true;
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        waiter?.({ done: true, value: undefined });
      }
    },
    next() {
      if (values.length > 0) {
        return Promise.resolve({ done: false, value: values.shift() });
      }
      if (closed) {
        return Promise.resolve({ done: true, value: undefined });
      }
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
  };
};

const execFileText = (command, args, options = {}) => new Promise((resolve) => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let settled = false;
  const maxOutput = 8 * 1024 * 1024;
  const timeout = setTimeout(() => {
    if (settled) return;
    child.kill('SIGTERM');
  }, options.timeoutMs || 10000);

  const append = (target, chunk) => {
    const next = `${target}${chunk}`;
    return next.length > maxOutput ? next.slice(-maxOutput) : next;
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout = append(stdout, chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr = append(stderr, chunk);
  });
  child.on('error', (error) => {
    settled = true;
    clearTimeout(timeout);
    resolve({ ok: false, stdout, stderr, error });
  });
  child.on('close', (code, signal) => {
    settled = true;
    clearTimeout(timeout);
    resolve({ ok: code === 0, code, signal, stdout, stderr, error: null });
  });
});

const MAX_UNTRACKED_DIFF_FILES = 100;
export const MAX_UNTRACKED_FILE_BYTES = 512 * 1024;
const UNTRACKED_DIFF_CONCURRENCY = 8;
const UNTRACKED_DIFF_CACHE_MAX_ENTRIES = 500;

/** @type {Map<string, string>} */
const untrackedDiffCache = new Map();

export function resetUntrackedDiffCacheForTests() {
  untrackedDiffCache.clear();
}

export function getUntrackedDiffCacheSizeForTests() {
  return untrackedDiffCache.size;
}

const getUntrackedDiffCacheKey = (directory, relativePath, stat) => (
  `${directory}\0${relativePath}\0${stat.mtimeMs}:${stat.size}`
);

const touchUntrackedDiffCache = (key, value) => {
  if (untrackedDiffCache.has(key)) {
    untrackedDiffCache.delete(key);
  }
  untrackedDiffCache.set(key, value);
  while (untrackedDiffCache.size > UNTRACKED_DIFF_CACHE_MAX_ENTRIES) {
    const oldest = untrackedDiffCache.keys().next().value;
    untrackedDiffCache.delete(oldest);
  }
};

const getCachedUntrackedDiff = (key) => {
  if (!untrackedDiffCache.has(key)) return undefined;
  const value = untrackedDiffCache.get(key);
  untrackedDiffCache.delete(key);
  untrackedDiffCache.set(key, value);
  return value;
};

const mapWithConcurrency = async (items, concurrency, fn) => {
  if (items.length === 0) return [];
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index], index);
    }
  }));
  return results;
};

const diffUntrackedFileNoIndex = async (cwd, name) => {
  // `git diff --no-index` exits 1 whenever the files differ; judge by output.
  const fileDiff = await execFileText(
    'git',
    ['diff', '--no-ext-diff', '--no-color', '--binary', '--no-index', '--', '/dev/null', name],
    { cwd, timeoutMs: 10000 },
  );
  return fileDiff.stdout || '';
};

const collectUntrackedFileDiffs = async (cwd, names) => {
  const sections = [];
  const pending = [];

  for (const name of names.slice(0, MAX_UNTRACKED_DIFF_FILES)) {
    let stat;
    try {
      stat = await fs.stat(path.join(cwd, name));
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_UNTRACKED_FILE_BYTES) {
      continue;
    }

    const cacheKey = getUntrackedDiffCacheKey(cwd, name, stat);
    const cached = getCachedUntrackedDiff(cacheKey);
    if (cached !== undefined) {
      if (cached) sections.push(cached);
      continue;
    }
    pending.push({ name, cacheKey });
  }

  const pendingDiffs = await mapWithConcurrency(
    pending,
    UNTRACKED_DIFF_CONCURRENCY,
    async ({ name, cacheKey }) => {
      const diff = await diffUntrackedFileNoIndex(cwd, name);
      touchUntrackedDiffCache(cacheKey, diff);
      return diff;
    },
  );

  for (const diff of pendingDiffs) {
    if (diff) sections.push(diff);
  }
  return sections;
};

export const defaultGetWorkspaceDiff = async (directory) => {
  const cwd = trimString(directory);
  if (!cwd) return '';
  const tracked = await execFileText('git', ['diff', '--no-ext-diff', '--no-color', '--binary'], {
    cwd,
    timeoutMs: 10000,
  });
  if (!tracked.ok) return '';
  // `git diff` never lists untracked files, so files created during a run
  // would be invisible to the synthetic workspace patch without this pass.
  const untracked = await execFileText('git', ['ls-files', '-z', '--others', '--exclude-standard'], {
    cwd,
    timeoutMs: 10000,
  });
  if (!untracked.ok) return tracked.stdout;
  const names = untracked.stdout.split('\0').filter(Boolean);
  const untrackedSections = await collectUntrackedFileDiffs(cwd, names);
  return [tracked.stdout, ...untrackedSections].filter(Boolean).join('');
};

const normalizeDiffSnapshot = (value) => trimString(value).replace(/\r\n/g, '\n');

const parsePatchStats = (patch) => {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
};

const parseUnifiedDiffFiles = (diff) => {
  const files = [];
  const lines = normalizeDiffSnapshot(diff).split('\n');
  let current = null;

  const flush = () => {
    if (!current) return;
    const patch = current.lines.join('\n').trim();
    const stats = parsePatchStats(patch);
    files.push({
      relativePath: current.path,
      filePath: current.path,
      additions: stats.additions,
      deletions: stats.deletions,
      patch,
    });
    current = null;
  };

  for (const line of lines) {
    const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (match) {
      flush();
      current = {
        path: match[2] || match[1],
        lines: [line],
      };
      continue;
    }
    if (current) current.lines.push(line);
  }
  flush();

  return files.filter((file) => trimString(file.relativePath) && trimString(file.patch));
};

// The synthetic workspace patch must only describe changes made during this
// prompt run: the worktree can already hold uncommitted edits from other
// sessions (including chats in the Cursor app itself), and those must not be
// replayed as if this run applied them. A file edited both before and during
// the run keeps its full per-file diff — per-file granularity is the tradeoff.
const filterWorkspaceDiffFilesAgainstBaselineMap = (baselinePatchesByPath, currentDiff) => {
  const currentFiles = parseUnifiedDiffFiles(currentDiff);
  if (currentFiles.length === 0) return currentFiles;
  return currentFiles.filter((file) => baselinePatchesByPath.get(file.relativePath) !== file.patch);
};

export const filterWorkspaceDiffFilesAgainstBaseline = (baselineDiff, currentDiff) => {
  const baselinePatchesByPath = new Map(
    parseUnifiedDiffFiles(baselineDiff).map((file) => [file.relativePath, file.patch]),
  );
  return filterWorkspaceDiffFilesAgainstBaselineMap(baselinePatchesByPath, currentDiff);
};

const buildWorkspaceDiffSummary = (files) => {
  const diffs = (Array.isArray(files) ? files : [])
    .map((file) => ({
      file: trimString(file?.relativePath || file?.filePath),
      additions: Math.max(0, Number(file?.additions) || 0),
      deletions: Math.max(0, Number(file?.deletions) || 0),
    }))
    .filter((file) => file.file);

  return diffs.length > 0 ? { diffs } : null;
};

const getCursorAuthEntry = (auth) => {
  const entry = isPlainObject(auth?.[CURSOR_PROVIDER_ID]) ? auth[CURSOR_PROVIDER_ID] : {};
  return entry;
};

export function getCursorSdkApiKey(options = {}) {
  const env = isPlainObject(options.env) ? options.env : process.env;
  const envKey = trimString(env.CURSOR_API_KEY);
  if (envKey) return envKey;

  const readAuth = typeof options.readAuth === 'function' ? options.readAuth : () => ({});
  const entry = getCursorAuthEntry(readAuth());
  return trimString(entry.key) || trimString(entry.token) || null;
}

export function isCursorUsageAuthConfigured(auth = {}) {
  return Boolean(trimString(getCursorAuthEntry(auth).usageSessionToken));
}

export function saveCursorSdkAuth({ readAuth, writeAuth, key, type = 'api' }) {
  const normalizedKey = trimString(key);
  if (!normalizedKey) {
    throw new Error('Cursor SDK API key is required.');
  }

  const auth = readAuth();
  const existing = getCursorAuthEntry(auth);
  writeAuth({
    ...auth,
    [CURSOR_PROVIDER_ID]: {
      ...existing,
      type,
      key: normalizedKey,
    },
  });
}

export function clearCursorSdkAuth({ readAuth, writeAuth }) {
  const auth = readAuth();
  const existing = getCursorAuthEntry(auth);
  const nextEntry = { ...existing };
  const hadSdkAuth =
    Object.prototype.hasOwnProperty.call(nextEntry, 'key') ||
    Object.prototype.hasOwnProperty.call(nextEntry, 'token') ||
    Object.prototype.hasOwnProperty.call(nextEntry, 'type');
  delete nextEntry.key;
  delete nextEntry.token;
  delete nextEntry.type;

  if (!hadSdkAuth) {
    return false;
  }

  writeAuth({
    ...auth,
    [CURSOR_PROVIDER_ID]: nextEntry,
  });
  return true;
}

const createCursorModelRecord = ({ id, name, description, limit, options, variants }) => ({
  id,
  name,
  ...(trimString(description) ? { description: trimString(description) } : {}),
  ...(Number.isSafeInteger(limit?.context) && limit.context > 0
    ? { limit: { context: limit.context } }
    : {}),
  ...(isPlainObject(options) && Object.keys(options).length > 0 ? { options } : {}),
  ...(isPlainObject(variants) && Object.keys(variants).length > 0 ? { variants } : {}),
  capabilities: createCursorModelCapabilities(),
});

const normalizeModelSelectionParams = (params) => {
  if (!Array.isArray(params)) return [];
  const normalized = [];
  for (const param of params) {
    if (!isPlainObject(param)) continue;
    const id = trimString(param.id);
    const value = trimString(param.value);
    if (!id || !value) continue;
    normalized.push({ id, value });
  }
  return normalized;
};

const createCursorSdkModelSelection = (id, params) => {
  const normalizedId = normalizeModelId(id);
  const normalizedParams = normalizeModelSelectionParams(params);
  return {
    id: normalizedId,
    ...(normalizedParams.length > 0 ? { params: normalizedParams } : {}),
  };
};

const createFallbackCursorSdkModelSelection = (id) => {
  if (id === 'composer-2.5') {
    return createCursorSdkModelSelection('composer-2.5', [{ id: CURSOR_MODEL_PARAM_FAST, value: 'false' }]);
  }
  if (id === 'composer-2.5-fast') {
    return createCursorSdkModelSelection('composer-2.5', [{ id: CURSOR_MODEL_PARAM_FAST, value: CURSOR_MODEL_TRUE_VALUE }]);
  }
  if (id === 'composer-2') {
    return createCursorSdkModelSelection('composer-2', [{ id: CURSOR_MODEL_PARAM_FAST, value: 'false' }]);
  }
  if (id === 'composer-2-fast') {
    return createCursorSdkModelSelection('composer-2', [{ id: CURSOR_MODEL_PARAM_FAST, value: CURSOR_MODEL_TRUE_VALUE }]);
  }
  return createCursorSdkModelSelection(id, []);
};

const fallbackModelRecords = () => Object.fromEntries(
  FALLBACK_MODELS.map(([id, name]) => [id, createCursorModelRecord({
    id,
    name,
    options: { cursorSdkModel: createFallbackCursorSdkModelSelection(id) },
  })]),
);

const cloneCursorSdkModelSelection = (selection) => {
  if (!isPlainObject(selection)) return null;
  const id = normalizeModelId(selection.id);
  if (!id) return null;
  return createCursorSdkModelSelection(id, selection.params);
};

const sortObjectKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortObjectKeys(entry)])
  );
};

const stableJson = (value) => {
  try {
    return JSON.stringify(sortObjectKeys(value));
  } catch {
    return safeJson(value);
  }
};

const cloneCursorSdkAgentDefinitions = (definitions) => {
  const normalized = normalizeCursorSdkAgentDefinitions(definitions);
  return normalized ? sortObjectKeys(normalized) : null;
};

const cloneCursorMcpServers = (servers) => {
  if (!isPlainObject(servers)) return null;
  try {
    return JSON.parse(JSON.stringify(servers));
  } catch {
    return null;
  }
};

const createAgentRuntimeFingerprint = ({ directory, model, agents, mcpServerIdentity }) => stableJson({
  directory: trimString(directory),
  model: cloneCursorSdkModelSelection(model),
  agents: cloneCursorSdkAgentDefinitions(agents),
  mcpServerIdentity: trimString(mcpServerIdentity),
  settingSources: CURSOR_SETTING_SOURCES ?? null,
});

const getModelParamValue = (params, id) => {
  const normalizedId = trimString(id);
  if (!normalizedId) return '';
  for (const param of normalizeModelSelectionParams(params)) {
    if (param.id === normalizedId) return param.value;
  }
  return '';
};

const normalizeCursorModelEffort = (value) => (
  CURSOR_MODEL_EFFORT_ALIASES.get(trimString(value).toLowerCase()) || ''
);

const createCursorVariantKeyFromParams = (params) => {
  const thinkingEnabled = getModelParamValue(params, CURSOR_MODEL_PARAM_THINKING).toLowerCase() === CURSOR_MODEL_TRUE_VALUE;
  const effort = normalizeCursorModelEffort(
    getModelParamValue(params, CURSOR_MODEL_PARAM_REASONING)
    || getModelParamValue(params, CURSOR_MODEL_PARAM_EFFORT)
  );

  if (thinkingEnabled && effort) return `${CURSOR_MODEL_PARAM_THINKING}-${effort}`;
  if (thinkingEnabled) return CURSOR_MODEL_PARAM_THINKING;
  return effort || '';
};

const parseTokenMagnitude = (value) => {
  const normalized = trimString(value).toLowerCase();
  const match = normalized.match(/^(\d+(?:\.\d+)?)([km])$/);
  if (!match) return null;
  const numeric = Number.parseFloat(match[1]);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const magnitude = match[2] === 'm' ? numeric * 1_000_000 : numeric * 1_000;
  return Number.isSafeInteger(magnitude) && magnitude > 0 ? magnitude : null;
};

const getParamMagnitudeScore = (value) => parseTokenMagnitude(value) ?? 0;

const getCursorContextLimitFromParams = (params) => (
  parseTokenMagnitude(getModelParamValue(params, CURSOR_MODEL_PARAM_CONTEXT))
);

const scoreCursorSdkVariant = (sdkVariant) => {
  const params = normalizeModelSelectionParams(sdkVariant?.params);
  const effort = normalizeCursorModelEffort(
    getModelParamValue(params, CURSOR_MODEL_PARAM_REASONING)
    || getModelParamValue(params, CURSOR_MODEL_PARAM_EFFORT)
  );
  return (
    (sdkVariant?.isDefault === true ? 1_000_000_000 : 0)
    + getParamMagnitudeScore(getModelParamValue(params, CURSOR_MODEL_PARAM_CONTEXT))
    + (CURSOR_MODEL_EFFORT_DEFAULT_SCORES.get(effort) || 0)
  );
};

const mergeCursorSdkModelCandidate = (records, candidate) => {
  const id = trimString(candidate.id);
  if (!id) return;

  const existing = records[id];
  const variants = isPlainObject(existing?.variants) ? { ...existing.variants } : {};
  const variantKey = trimString(candidate.variantKey);
  const cursorSdkModel = createCursorSdkModelSelection(candidate.sdkModelId, candidate.params);
  const score = Number.isFinite(candidate.score) ? candidate.score : 0;
  const contextLimit = getCursorContextLimitFromParams(candidate.params);

  if (variantKey) {
    const existingVariant = variants[variantKey];
    const existingScore = Number.isFinite(existingVariant?._cursorSdkScore) ? existingVariant._cursorSdkScore : -1;
    if (!existingVariant || score >= existingScore) {
      variants[variantKey] = {
        cursorSdkModel,
        ...(contextLimit ? { limit: { context: contextLimit } } : {}),
        _cursorSdkScore: score,
      };
    }
  }

  const existingOptions = isPlainObject(existing?.options) ? existing.options : {};
  const existingSelectionScore = Number.isFinite(existingOptions._cursorSdkScore) ? existingOptions._cursorSdkScore : -1;
  const nextOptions = score >= existingSelectionScore
    ? {
        ...existingOptions,
        cursorSdkModel,
        _cursorSdkScore: score,
      }
    : existingOptions;
  const nextLimit = score >= existingSelectionScore
    ? (contextLimit ? { context: contextLimit } : undefined)
    : existing?.limit;

  records[id] = createCursorModelRecord({
    id,
    name: trimString(candidate.name) || existing?.name || id,
    description: candidate.description ?? existing?.description,
    limit: nextLimit,
    options: nextOptions,
    variants,
  });
};

const stripInternalCursorSdkScores = (records) => Object.fromEntries(
  Object.entries(records).map(([id, model]) => {
    if (!isPlainObject(model)) return [id, model];
    const { options: _options, variants: _variants, ...rest } = model;
    const options = isPlainObject(model.options) ? { ...model.options } : null;
    if (options) delete options._cursorSdkScore;
    const variants = isPlainObject(model.variants)
      ? Object.fromEntries(
          Object.entries(model.variants).map(([variantKey, variant]) => {
            if (!isPlainObject(variant)) return [variantKey, variant];
            const nextVariant = { ...variant };
            delete nextVariant._cursorSdkScore;
            return [variantKey, nextVariant];
          })
        )
      : null;
    return [
      id,
      {
        ...rest,
        ...(options && Object.keys(options).length > 0 ? { options } : {}),
        ...(variants && Object.keys(variants).length > 0 ? { variants } : {}),
      },
    ];
  })
);

const addNativeUltraCursorVariants = (records) => {
  for (const [recordId, record] of Object.entries(records)) {
    const baseModelId = recordId.endsWith('-fast') ? recordId.slice(0, -'-fast'.length) : recordId;
    if (!CURSOR_NATIVE_ULTRA_MODEL_IDS.has(baseModelId) || !isPlainObject(record)) continue;

    const variants = isPlainObject(record.variants) ? { ...record.variants } : {};
    if (isPlainObject(variants.ultra)) continue;

    const maxVariant = isPlainObject(variants.max) ? variants.max : null;
    const sourceSelection = cloneCursorSdkModelSelection(
      maxVariant?.cursorSdkModel || record.options?.cursorSdkModel
    );
    if (!sourceSelection) continue;

    let replacedEffort = false;
    const ultraParams = normalizeModelSelectionParams(sourceSelection.params).map((param) => {
      if (
        !replacedEffort
        && (param.id === CURSOR_MODEL_PARAM_REASONING || param.id === CURSOR_MODEL_PARAM_EFFORT)
      ) {
        replacedEffort = true;
        return { ...param, value: 'ultra' };
      }
      return param;
    });
    if (!replacedEffort) {
      ultraParams.push({ id: CURSOR_MODEL_PARAM_REASONING, value: 'ultra' });
    }
    const ultraContextLimit = getCursorContextLimitFromParams(ultraParams);

    variants.ultra = {
      cursorSdkModel: createCursorSdkModelSelection(sourceSelection.id, ultraParams),
      ...(ultraContextLimit
        ? { limit: { context: ultraContextLimit } }
        : {}),
      _cursorSdkScore: Number.isFinite(maxVariant?._cursorSdkScore) ? maxVariant._cursorSdkScore - 1 : 0,
    };
    record.variants = variants;
  }
  return records;
};

const addSdkModelRecord = (records, model) => {
  const sdkModelId = trimString(model.id);
  if (!sdkModelId) return;
  const name = trimString(model.displayName) || trimString(model.name) || sdkModelId;
  const description = model.description;
  const variants = Array.isArray(model.variants) ? model.variants : [];

  if (variants.length === 0) {
    records[sdkModelId] = createCursorModelRecord({
      id: sdkModelId,
      name,
      description,
      options: { cursorSdkModel: createCursorSdkModelSelection(sdkModelId, []) },
    });
    return;
  }

  for (const sdkVariant of variants) {
    if (!isPlainObject(sdkVariant)) continue;
    const params = normalizeModelSelectionParams(sdkVariant.params);
    const variantKey = createCursorVariantKeyFromParams(params);
    const fastEnabled = getModelParamValue(params, CURSOR_MODEL_PARAM_FAST).toLowerCase() === CURSOR_MODEL_TRUE_VALUE;
    const targetModelId = fastEnabled ? `${sdkModelId}-fast` : sdkModelId;
    const targetName = fastEnabled && !/\bfast\b/i.test(name) ? `${name} Fast` : name;
    mergeCursorSdkModelCandidate(records, {
      id: targetModelId,
      sdkModelId,
      name: targetName,
      description,
      params,
      variantKey,
      score: scoreCursorSdkVariant(sdkVariant),
    });
  }
};

const addCompatibilityModelPair = (records, id, pairedId, pairedName) => {
  if (!records[id] || records[pairedId]) return records;
  return {
    ...records,
    [pairedId]: createCursorModelRecord({ id: pairedId, name: pairedName }),
  };
};

const addCompatibilityModelPairs = (records) => {
  let nextRecords = records;
  for (const [baseId, baseName, fastId, fastName] of COMPATIBILITY_MODEL_PAIRS) {
    nextRecords = addCompatibilityModelPair(nextRecords, baseId, fastId, fastName);
    nextRecords = addCompatibilityModelPair(nextRecords, fastId, baseId, baseName);
  }
  return nextRecords;
};

const normalizeSdkModelRecords = (models) => {
  if (!Array.isArray(models) || models.length === 0) {
    return fallbackModelRecords();
  }

  const records = {};
  for (const model of models) {
    if (!isPlainObject(model)) continue;
    const id = trimString(model.id);
    if (!id) continue;
    addSdkModelRecord(records, model);
  }

  return Object.keys(records).length > 0
    ? stripInternalCursorSdkScores(addNativeUltraCursorVariants(addCompatibilityModelPairs(records)))
    : fallbackModelRecords();
};

const buildVirtualProvider = (models) => ({
  id: CURSOR_PROVIDER_ID,
  name: 'Cursor',
  models,
});

const resolveVariantRecord = (variants, variant) => {
  if (!isPlainObject(variants)) return null;
  const key = trimString(variant);
  if (!key) return null;
  const direct = variants[key];
  if (isPlainObject(direct)) return direct;
  const normalizedKey = createCursorVariantKeyFromParams([
    { id: CURSOR_MODEL_PARAM_THINKING, value: key.toLowerCase().includes(CURSOR_MODEL_PARAM_THINKING) ? CURSOR_MODEL_TRUE_VALUE : 'false' },
    { id: CURSOR_MODEL_PARAM_EFFORT, value: key },
  ]);
  return normalizedKey && isPlainObject(variants[normalizedKey]) ? variants[normalizedKey] : null;
};

const getCursorSdkSelectionFromModelRecord = (record, variant) => {
  if (!isPlainObject(record)) return null;
  const variantRecord = resolveVariantRecord(record.variants, variant);
  const variantSelection = cloneCursorSdkModelSelection(variantRecord?.cursorSdkModel);
  if (variantSelection) return variantSelection;
  return cloneCursorSdkModelSelection(record.options?.cursorSdkModel);
};

const extractPromptPayload = (body) => {
  const parts = Array.isArray(body?.parts) ? body.parts : [];
  const textParts = parts
    .map((part, index) => ({ part, index }))
    .filter(({ part }) => isPlainObject(part) && part.type === 'text')
    .map(({ part, index }) => ({
      index,
      text: trimString(part.text),
      synthetic: part.synthetic === true,
    }))
    .filter((part) => part.text);
  const planInstructionParts = textParts.filter((part) => (
    part.synthetic && part.text.trimStart().startsWith(PLAN_MODE_INSTRUCTION_PREFIX)
  ));
  const isPlanModePrompt = planInstructionParts.length > 0;
  const executionParts = isPlanModePrompt
    ? [
        ...planInstructionParts,
        ...textParts.filter((part) => !planInstructionParts.some((planPart) => planPart.index === part.index)),
      ]
    : textParts;
  const executionText = executionParts
    .map((part) => part.text)
    .join('\n\n')
    .trim();
  const visibleText = textParts
    .filter((part) => !part.synthetic)
    .map((part) => part.text)
    .join('\n\n')
    .trim();
  return {
    executionText,
    visibleText: visibleText || executionText,
    isPlanModePrompt,
    planInstructionParts,
  };
};

const normalizeMime = (value) => (
  typeof value === 'string' ? value.split(';')[0].trim().toLowerCase() : ''
);

const normalizeFilename = (value) => (typeof value === 'string' ? value.trim() : '');

const IMAGE_FILENAME_PATTERN = /\.(?:png|jpe?g|gif|webp|bmp|tiff?)$/i;

const isCursorImageFilePart = (part) => {
  const mime = normalizeMime(part?.mime);
  if (mime.startsWith('image/')) return true;
  return !mime && IMAGE_FILENAME_PATTERN.test(normalizeFilename(part?.filename));
};

const normalizePromptFileParts = (body, { sessionID, messageID }) => {
  const parts = Array.isArray(body?.parts) ? body.parts : [];
  return parts
    .map((part, index) => {
      if (!isPlainObject(part) || part.type !== 'file') return null;
      const url = trimString(part.url);
      if (!url) return null;
      const mime = trimString(part.mime || part.mimeType) || 'application/octet-stream';
      const filename = normalizeFilename(part.filename || part.name);
      return {
        id: trimString(part.id) || `${messageID}_file_${String(index + 1).padStart(2, '0')}`,
        sessionID,
        messageID,
        type: 'file',
        mime,
        url,
        ...(filename ? { filename } : {}),
        ...(part.synthetic === true ? { synthetic: true } : {}),
      };
    })
    .filter(Boolean);
};

const buildCursorImages = (fileParts) => fileParts
  .filter(isCursorImageFilePart)
  .map((part) => normalizeCursorDataImage(part))
  .filter(Boolean);

const parseDataUrl = (url) => {
  const value = trimString(url);
  if (!value.toLowerCase().startsWith('data:')) return null;
  const commaIndex = value.indexOf(',');
  if (commaIndex < 0) return null;
  const metadata = value.slice(5, commaIndex);
  const payload = value.slice(commaIndex + 1);
  const metadataParts = metadata.split(';').map((part) => part.trim()).filter(Boolean);
  const mimeType = normalizeMime(metadataParts[0]) || 'application/octet-stream';
  const isBase64 = metadataParts.slice(1).some((part) => part.toLowerCase() === 'base64');
  return { mimeType, payload, isBase64 };
};

const encodeUtf8Base64 = (text) => Buffer.from(text, 'utf8').toString('base64');

const normalizeCursorDataImage = (part) => {
  const parsed = parseDataUrl(part?.url);
  if (!parsed) return null;
  const mimeType = normalizeMime(part?.mime) || parsed.mimeType;
  if (!mimeType.startsWith('image/')) return null;
  if (parsed.isBase64) {
    const data = parsed.payload.replace(/\s/g, '');
    return data ? { data, mimeType } : null;
  }
  try {
    return { data: encodeUtf8Base64(decodeURIComponent(parsed.payload)), mimeType };
  } catch {
    return { data: encodeUtf8Base64(parsed.payload), mimeType };
  }
};

const getUnsupportedCursorImageUrlMessage = (fileParts) => {
  const unsupported = fileParts.filter((part) => isCursorImageFilePart(part) && !normalizeCursorDataImage(part));
  if (unsupported.length === 0) return '';
  const shown = unsupported.slice(0, 3).map(formatUnsupportedAttachment);
  const extraCount = unsupported.length - shown.length;
  return [
    '<status>blocked</status>',
    '',
    `Cursor SDK provider sessions support data-backed image attachments only. Unsupported image attachments were not sent: ${shown.join(', ')}${extraCount > 0 ? `, and ${extraCount} more` : ''}.`,
    '',
    'Attach the image from the composer so DevRyan can send its bytes, or use a non-Cursor OpenCode model for URL-backed images.',
  ].join('\n');
};

const formatUnsupportedAttachment = (part) => {
  const filename = normalizeFilename(part?.filename) || 'unnamed attachment';
  const mime = normalizeMime(part?.mime);
  return mime ? `${filename} (${mime})` : filename;
};

const getUnsupportedCursorAttachmentMessage = (fileParts) => {
  const unsupported = fileParts.filter((part) => !isCursorImageFilePart(part));
  if (unsupported.length === 0) return '';
  const shown = unsupported.slice(0, 3).map(formatUnsupportedAttachment);
  const extraCount = unsupported.length - shown.length;
  return [
    '<status>blocked</status>',
    '',
    `Cursor SDK provider sessions support image attachments only. Unsupported attachments were not sent: ${shown.join(', ')}${extraCount > 0 ? `, and ${extraCount} more` : ''}.`,
    '',
    'Remove those files, convert them into prompt text, or use a non-Cursor OpenCode model that supports the attachment type.',
  ].join('\n');
};

const formatPromptWithAgentInstructions = ({
  agent,
  instructions,
  prompt,
  runtimeContract = '',
  planFirst = false,
}) => {
  const contextBlocks = [
    ...(runtimeContract
      ? [
          '<cursor_runtime_contract>',
          runtimeContract,
          '</cursor_runtime_contract>',
          '',
        ]
      : []),
    ...(instructions
      ? [
          `<agent_instructions name="${escapeXmlAttribute(agent)}">`,
          instructions,
          '</agent_instructions>',
          '',
        ]
      : []),
  ];
  if (planFirst) {
    const planBreakIndex = prompt.indexOf('\n\n');
    if (planBreakIndex > 0 && prompt.trimStart().startsWith(PLAN_MODE_INSTRUCTION_PREFIX)) {
      return [
        prompt.slice(0, planBreakIndex),
        '',
        ...contextBlocks,
        prompt.slice(planBreakIndex + 2),
      ].join('\n').trim();
    }
    return [
      prompt,
      ...(contextBlocks.length > 0 ? ['', ...contextBlocks] : []),
    ].join('\n').trim();
  }
  return [
    ...contextBlocks,
    '<user_request>',
    prompt,
    '</user_request>',
  ].join('\n');
};

const getUnsupportedCursorAgentMessage = ({ agent }) => {
  const normalized = trimString(agent).toLowerCase();
  if (normalized !== 'council') return '';
  return [
    '<status>blocked</status>',
    '',
    'Cursor SDK provider sessions cannot run the Council agent because it requires the OpenCode council_session plugin tool, and OpenCode plugin tools are not available in Cursor SDK sessions.',
    '',
    'Use a non-Cursor OpenCode model for Council, or use Builder/Orchestrator with Cursor Composer 2.',
  ].join('\n');
};

const normalizeModelId = (value) => {
  const raw = trimString(value);
  if (!raw) return 'auto';
  return raw.startsWith(`${CURSOR_PROVIDER_ID}/`) ? raw.slice(CURSOR_PROVIDER_ID.length + 1) : raw;
};

const isConcreteCursorModel = (modelID) => {
  const model = trimString(modelID);
  return Boolean(model && model !== 'auto');
};

const getCursorRuntimePromptContract = (modelID) => {
  const model = trimString(modelID);
  if (!model || model === 'auto') return '';
  return [
    `This Cursor SDK parent session is pinned to model "${model}".`,
    'Cursor-managed task/subagent tools may report a different provider-selected model without changing the parent session model.',
    'If the parent request cannot be completed without switching its model, return <status>blocked</status> with the reason instead of continuing.',
  ].join('\n');
};

const getCursorDirectPlanModeInstructions = ({ agent, modelID }) => {
  if (trimString(agent).toLowerCase() !== 'orchestrator' || !isConcreteCursorModel(modelID)) {
    return '';
  }
  return [
    `Plan mode is running directly on Cursor model "${trimString(modelID)}".`,
    'Plan mode is no-mutation: do not edit files, run modifying commands, or delegate implementation work.',
    'If the selected agent allows read-only discovery delegation, keep it read-only and use the selected model.',
    'Do not create background implementation work. Do only the minimal read-only inspection needed, then produce the plan.',
    'Return a plan card only: Context, Implementation, and Verification. Do not modify files.',
  ].join('\n');
};

const normalizeRuntimeToolName = (value) => {
  const raw = trimString(value);
  if (!raw) return '';
  let normalized = raw.replace(/:\d+$/, '');
  if (normalized.includes('.')) {
    const parts = normalized.split('.').filter(Boolean);
    normalized = parts[parts.length - 1] || normalized;
  }
  normalized = normalized
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase()
    .replace(/_?tool_?call$/, '');

  if (normalized === 'shell' || normalized === 'cmd' || normalized === 'terminal' || normalized === 'shell_command') {
    return 'bash';
  }
  if (normalized === 'write_file') return 'write';
  if (normalized === 'file_write') return 'file_write';
  if (normalized === 'create_file') return 'create';
  if (normalized === 'edit_file' || normalized === 'file_edit') return 'edit';
  if (normalized === 'applypatch' || normalized === 'patch' || normalized === 'apply_diff' || normalized === 'file_patch') {
    return 'apply_patch';
  }
  return normalized;
};

const isWorkspaceMutationCandidateTool = (toolName) => {
  const normalized = normalizeRuntimeToolName(toolName);
  return normalized === 'bash'
    || normalized === 'edit'
    || normalized === 'multiedit'
    || normalized === 'write'
    || normalized === 'create'
    || normalized === 'file_write'
    || normalized === 'apply_patch'
    || normalized === 'str_replace'
    || normalized === 'str_replace_based_edit_tool';
};

const isCursorPlanTool = (toolName) => {
  const normalized = normalizeRuntimeToolName(toolName);
  return normalized === 'create_plan';
};

const isCursorTaskTool = (toolName) => {
  const normalized = normalizeRuntimeToolName(toolName);
  return normalized === 'task';
};

const getCursorPlanToolText = (part) => {
  if (!isPlainObject(part) || !isCursorPlanTool(part.tool)) return '';
  const candidates = [
    part.input,
    part.state?.input,
    part.metadata,
    part.state?.metadata,
  ];
  for (const candidate of candidates) {
    if (!isPlainObject(candidate)) continue;
    const plan = trimString(candidate.plan);
    if (plan) return plan;
  }
  return '';
};

const readJsonFile = async (filePath, fallback) => {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : fallback;
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
};

const writeJsonFile = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, filePath);
};

const normalizeStoredSessionState = (state) => {
  const records = Array.isArray(state?.records) ? state.records : [];
  if (records.length === 0) {
    return {
      state: { ...state, records },
      changed: !Array.isArray(state?.records),
    };
  }

  const messageIDs = new Set(records.map((record) => trimString(record?.info?.id)).filter(Boolean));
    let changed = false;
    const nextRecords = records.map((record) => {
      if (!isPlainObject(record?.info)) return record;

      let info = record.info;
      let parts = Array.isArray(record.parts) ? record.parts : [];
      let recordChanged = !Array.isArray(record.parts);
      const repairedParts = parts.map((part) => {
        const result = mergeToolDataIntoState(part);
        if (result.changed) recordChanged = true;
        return result.part;
      });
      parts = repairedParts;

    const messageID = trimString(info.id);
    if (info.role === 'assistant' && !trimString(info.parentID) && messageID.endsWith('_assistant')) {
      const parentID = messageID.slice(0, -'_assistant'.length);
      if (messageIDs.has(parentID)) {
        info = { ...info, parentID };
        recordChanged = true;
      }
    }

    const completed = info?.time?.completed;
    if (info.role === 'assistant' && trimString(info.finish) && typeof completed === 'number') {
      const finalStatus = finishToToolStatus(info.finish);
      const nextParts = parts.map((part) => {
        if (part?.type !== 'tool' || part?.state?.status !== 'running') return part;
        recordChanged = true;
        return {
          ...part,
          state: {
            ...part.state,
            status: finalStatus,
            time: {
              ...(part.state?.time || {}),
              end: completed,
            },
          },
        };
      });
      parts = nextParts;
    }

    if (!recordChanged) return record;
    changed = true;
    return { ...record, info, parts };
  });

  return {
    state: changed ? { ...state, records: nextRecords } : { ...state, records },
    changed,
  };
};

const defaultStorageDir = () => path.join(
  process.env.OPENCHAMBER_DATA_DIR ? path.resolve(process.env.OPENCHAMBER_DATA_DIR) : path.join(os.homedir(), '.config', 'openchamber'),
  'cursor-sdk-sessions',
);

export function createCursorSdkRuntime(options = {}) {
  const readAuth = typeof options.readAuth === 'function' ? options.readAuth : () => ({});
  const env = isPlainObject(options.env) ? options.env : process.env;
  const storageDir = trimString(options.storageDir) || defaultStorageDir();
  const rawLoadSdk = typeof options.loadSdk === 'function' ? options.loadSdk : () => importRuntimeModule('@cursor/sdk');
  const ripgrepPath = trimString(options.ripgrepPath);
  const initialRipgrepResolution = resolveCursorRipgrepPath({
    explicitRipgrepPath: ripgrepPath,
    env,
  });
  let lastRipgrepStatus = {
    configured: Boolean(initialRipgrepResolution.path),
    source: initialRipgrepResolution.source,
    usable: Boolean(initialRipgrepResolution.path),
    resolvedSource: initialRipgrepResolution.source,
  };
  const loadSdk = async () => {
    const sdk = await rawLoadSdk();
    lastRipgrepStatus = configureCursorSdkRipgrep(sdk, {
      explicitRipgrepPath: ripgrepPath,
      env,
    });
    return sdk;
  };
  const workerPath = trimString(options.workerPath) || fileURLToPath(new URL('./node-worker.mjs', import.meta.url));
  const persistentWorkerPath = trimString(options.persistentWorkerPath)
    || workerPath.replace(/node-worker\.mjs$/, 'persistent-worker.mjs');
  const workerConfig = resolveCursorSdkWorkerRuntimeConfig({
    env,
    hasInjectedLoadSdk: typeof options.loadSdk === 'function',
    requestedNodeBinary: options.nodeBinary,
    requestedUseNodeWorkerForPrompts: options.useNodeWorkerForPrompts,
    requestedWorkerCwd: options.workerCwd,
    requestedWorkerEnv: options.workerEnv,
    workerPath,
    ripgrepPath,
  });
  const {
    nodeBinary,
    useNodeWorkerForPrompts,
    workerCwd,
    workerEnv,
  } = workerConfig;
  if (useNodeWorkerForPrompts && trimString(workerEnv.CURSOR_SDK_RIPGREP_PATH)) {
    lastRipgrepStatus = {
      configured: true,
      source: initialRipgrepResolution.path ? initialRipgrepResolution.source : 'explicit',
      usable: true,
      resolvedSource: initialRipgrepResolution.path ? initialRipgrepResolution.source : 'explicit',
    };
  }
  const spawnImpl = typeof options.spawnImpl === 'function' ? options.spawnImpl : spawn;
  const usePersistentWorkerForPrompts = options.usePersistentWorkerForPrompts !== false;
  const getWorkspaceDiff = typeof options.getWorkspaceDiff === 'function' ? options.getWorkspaceDiff : defaultGetWorkspaceDiff;
  const emitEvent = typeof options.emitEvent === 'function' ? options.emitEvent : () => {};
  const logger = options.logger || console;
  const resolveAgentPrompt = typeof options.resolveAgentPrompt === 'function' ? options.resolveAgentPrompt : null;
  const resolveAgentDefinitions = typeof options.resolveAgentDefinitions === 'function' ? options.resolveAgentDefinitions : null;
  const streamIdleTimeoutMs = Math.max(0, Number(options.streamIdleTimeoutMs) || 45000);
  const finalResultWaitTimeoutMs = Math.max(0, Number(options.finalResultWaitTimeoutMs) || 1000);
  const finalResultStreamDrainGraceMs = Math.max(0, Number(options.finalResultStreamDrainGraceMs) || 10);
  const modelDiscoveryTtlMs = Math.max(0, Number(options.modelDiscoveryTtlMs) || DEFAULT_MODEL_DISCOVERY_TTL_MS);
  const modelDiscoveryTimeoutMs = Math.max(0, Number(options.modelDiscoveryTimeoutMs) || DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS);
  const recordTimingMark = typeof options.recordTimingMark === 'function' ? options.recordTimingMark : null;
  const MAX_CACHED_AGENTS = 32;
  const MAX_PERSISTENT_WORKERS = 3;
  const activeRuns = new Map();
  const sessionStatuses = new Map();
  const agentsBySession = new Map();
  let releaseSessionFromPersistentWorkers = () => false;
  let lastModelRecords = fallbackModelRecords();
  let lastModelsSource = 'fallback';
  let modelRefreshInFlight = null;
  let lastModelRefreshStartedAt = null;
  let lastModelRefreshCompletedAt = null;
  let lastModelRefreshDurationMs = null;
  let lastModelRefreshReason = null;
  let lastModelRefreshTimedOut = false;
  let lastModelRefreshError = null;
  let lastWorkerTiming = null;
  let lastError = null;
  let lastCancellation = null;
  let lastPostTaskEmptyFinish = null;

  const getSessionPath = (sessionID) => path.join(storageDir, `${encodeURIComponent(sessionID)}.json`);

  const readSessionState = async (sessionID) => {
    const state = await readJsonFile(getSessionPath(sessionID), {
    sessionID,
    agentID: null,
    records: [],
    });
    return normalizeStoredSessionState(state).state;
  };

  const deletedSessionIds = new Set();

  const writeSessionState = async (sessionID, state) => {
    if (deletedSessionIds.has(sessionID)) return;
    await writeJsonFile(getSessionPath(sessionID), state);
  };

  const persistQueues = new Map();

  const enqueuePersist = (sessionID, record, options = {}) => {
    const previous = persistQueues.get(sessionID) || Promise.resolve();
    const writePromise = previous
      .catch(() => {})
      .then(() => appendOrReplaceRecord(sessionID, record));
    const handledPromise = writePromise.catch((error) => {
      logger.error?.('[CursorSDK] persist failed:', error);
    });
    persistQueues.set(sessionID, handledPromise);
    return options.propagateError === true ? writePromise : handledPromise;
  };

  const appendOrReplaceRecord = async (sessionID, record) => {
    const state = await readSessionState(sessionID);
    const records = Array.isArray(state.records) ? state.records : [];
    const index = records.findIndex((entry) => entry?.info?.id === record.info.id);
    const nextRecords = index >= 0 ? [...records] : [...records, record];
    if (index >= 0) nextRecords[index] = record;
    nextRecords.sort((left, right) => String(left?.info?.id || '').localeCompare(String(right?.info?.id || '')));
    const nextState = { ...state, records: nextRecords };
    await writeSessionState(sessionID, nextState);
    return nextState;
  };

  const updateAgentId = async (sessionID, agentID) => {
    const state = await readSessionState(sessionID);
    if (state.agentID === agentID) return;
    await writeSessionState(sessionID, { ...state, agentID });
  };

  const deleteSessionState = async (sessionID) => {
    const id = trimString(sessionID);
    if (!id || deletedSessionIds.has(id)) return false;
    deletedSessionIds.add(id);
    await questionRuntime.deleteSession(id);
    agentsBySession.delete(id);
    sessionStatuses.delete(id);
    const active = activeRuns.get(id);
    activeRuns.delete(id);
    if (active?.run && typeof active.run.cancel === 'function') {
      try {
        active.markAbortRequested?.('session_deleted');
        await active.run.cancel();
      } catch {
      }
    }
    releaseSessionFromPersistentWorkers(id);
    // Serialize behind any in-flight persist so the state file cannot be
    // re-created by a write that was already queued.
    const previous = persistQueues.get(id) || Promise.resolve();
    const removal = previous
      .catch(() => {})
      .then(() => fs.rm(getSessionPath(id), { force: true }))
      .catch((error) => {
        logger.error?.('[CursorSDK] failed to delete session state:', error);
      });
    await removal;
    persistQueues.delete(id);
    return true;
  };

  const emit = (payload, directory) => {
    emitEvent(payload, {
      directory: trimString(directory) || undefined,
      eventId: createId('evt'),
    });
  };

  const questionRuntime = options.questionRuntime || createCursorQuestionRuntime({
    emitEvent,
    logger,
    ...(isPlainObject(options.questionRuntimeOptions) ? options.questionRuntimeOptions : {}),
  });

  // Maximum time to wait for an underlying run cancel. The cancel runs in the
  // background so this never blocks the caller; the bound only stops a hung
  // cancel from leaking forever.
  const CURSOR_CANCEL_TIMEOUT_MS = 5000;

  // Release the active run for a session WITHOUT blocking on the underlying
  // cancel. The session is freed immediately (and optionally marked idle) so a
  // user stop or a rapid model switch / resend can never collide with a run that
  // is still tearing down — the cause of the "stop mid-stream then change models"
  // freeze. The cancel itself is fired in the background, bounded by a timeout so
  // a slow or hung SDK cancel can never wedge the session.
  const releaseActiveRun = (sessionID, { source = 'user_abort', emitIdle = false } = {}) => {
    const active = activeRuns.get(sessionID);
    if (!active?.run) return false;
    active.markAbortRequested?.(source);
    questionRuntime.revokeSessionScope(sessionID, {
      identity: active.questionScopeIdentity,
      messageID: active.messageID,
      reason: source === 'superseded' ? 'the prompt was superseded' : 'the Cursor run was aborted',
    });
    activeRuns.delete(sessionID);
    if (emitIdle) {
      sessionStatuses.set(sessionID, { type: 'idle' });
      emit({ type: 'session.status', properties: { sessionID, status: { type: 'idle' } } }, active.directory);
    }
    if (typeof active.run.cancel === 'function') {
      Promise.resolve()
        .then(() => withTimeout(Promise.resolve(active.run.cancel()), CURSOR_CANCEL_TIMEOUT_MS))
        .catch((error) => {
          logger.warn?.('[CursorSDK] background run cancel failed:', error instanceof Error ? error.message : error);
        });
    }
    return true;
  };

  const getStatus = () => {
    const auth = readAuth();
    const sdkAuthConfigured = Boolean(getCursorSdkApiKey({ env, readAuth }));
    return {
      providerId: CURSOR_PROVIDER_ID,
      bridge: { kind: 'cursor-sdk' },
      sdkAuthConfigured,
      usageAuthConfigured: isCursorUsageAuthConfigured(auth),
      ...(useNodeWorkerForPrompts && usePersistentWorkerForPrompts
        ? persistentWorkerRuntime.getStatus()
        : { workerMode: useNodeWorkerForPrompts ? 'node-worker' : 'direct', workerReady: false, workerRestarts: 0 }),
      activeRuns: activeRuns.size,
      modelsSource: lastModelsSource,
      modelCount: Object.keys(lastModelRecords).length,
      modelsRefreshing: Boolean(modelRefreshInFlight),
      lastModelRefreshStartedAt,
      lastModelRefreshCompletedAt,
      lastModelRefreshDurationMs,
      lastModelRefreshReason,
      lastModelRefreshTimedOut,
      lastModelRefreshError,
      lastWorkerTiming,
      lastError,
      lastCancellation,
      lastPostTaskEmptyFinish,
      ripgrepConfigured: lastRipgrepStatus.configured,
      ripgrepSource: lastRipgrepStatus.source,
      ripgrepUsable: lastRipgrepStatus.usable ?? lastRipgrepStatus.configured,
      ripgrepResolvedSource: lastRipgrepStatus.resolvedSource ?? lastRipgrepStatus.source,
      ripgrepConfigureSupported: lastRipgrepStatus.configureSupported,
    };
  };

  const getSessionStatus = () => {
    const statuses = {};
    for (const [sessionID, status] of sessionStatuses) {
      statuses[sessionID] = status;
    }
    for (const sessionID of activeRuns.keys()) {
      statuses[sessionID] = { type: 'busy' };
    }
    return statuses;
  };

  const isModelCacheFresh = () => (
    lastModelsSource === 'sdk'
    && typeof lastModelRefreshCompletedAt === 'number'
    && (modelDiscoveryTtlMs === 0 || now() - lastModelRefreshCompletedAt < modelDiscoveryTtlMs)
  );

  const refreshModels = async ({ force = false, reason = 'refresh' } = {}) => {
    if (!force && isModelCacheFresh()) {
      return lastModelRecords;
    }
    if (modelRefreshInFlight) {
      return modelRefreshInFlight;
    }

    const apiKey = getCursorSdkApiKey({ env, readAuth });
    if (!apiKey) {
      lastModelRecords = fallbackModelRecords();
      lastModelsSource = 'fallback';
      lastModelRefreshStartedAt = now();
      lastModelRefreshCompletedAt = lastModelRefreshStartedAt;
      lastModelRefreshDurationMs = 0;
      lastModelRefreshReason = reason;
      lastModelRefreshTimedOut = false;
      lastModelRefreshError = null;
      return lastModelRecords;
    }

    const startedAt = now();
    lastModelRefreshStartedAt = startedAt;
    lastModelRefreshCompletedAt = null;
    lastModelRefreshDurationMs = null;
    lastModelRefreshReason = reason;
    lastModelRefreshTimedOut = false;
    lastModelRefreshError = null;

    modelRefreshInFlight = (async () => {
      try {
        const { Cursor } = await loadSdk();
        const models = await Cursor.models.list({ apiKey });
        lastModelRecords = normalizeSdkModelRecords(models);
        lastModelsSource = 'sdk';
        lastError = null;
        lastModelRefreshError = null;
        return lastModelRecords;
      } catch (error) {
        if (lastModelsSource !== 'sdk') {
          lastModelRecords = fallbackModelRecords();
          lastModelsSource = 'fallback';
        }
        lastError = error instanceof Error ? error.message : 'Failed to list Cursor models.';
        lastModelRefreshError = lastError;
        return lastModelRecords;
      } finally {
        const completedAt = now();
        lastModelRefreshCompletedAt = completedAt;
        lastModelRefreshDurationMs = Math.max(0, completedAt - startedAt);
        modelRefreshInFlight = null;
      }
    })();

    return modelRefreshInFlight;
  };

  const refreshVirtualProviderNow = async ({ force = false, reason = 'refresh', timeoutMs = 0 } = {}) => {
    const refreshPromise = refreshModels({ force, reason });
    const boundedTimeoutMs = Math.max(0, Number(timeoutMs) || 0);
    if (!boundedTimeoutMs) {
      const models = await refreshPromise;
      return buildVirtualProvider(models);
    }

    const models = await withTimeout(refreshPromise, boundedTimeoutMs);
    if (!models) {
      lastModelRefreshTimedOut = true;
      lastModelRefreshError = `Cursor model discovery timed out after ${boundedTimeoutMs}ms.`;
      lastError = lastModelRefreshError;
      return buildVirtualProvider(lastModelRecords);
    }
    return buildVirtualProvider(models);
  };

  const refreshVirtualProviderInBackground = (options = {}) => {
    if (!options.force && isModelCacheFresh()) return;
    refreshModels(options).catch((error) => {
      lastError = error instanceof Error ? error.message : 'Failed to refresh Cursor models.';
      lastModelRefreshError = lastError;
    });
  };

  const resolveCursorSdkModelSelection = async ({ modelID, variant }) => {
    const normalizedModelID = normalizeModelId(modelID);
    if (!lastModelRecords || !isPlainObject(lastModelRecords[normalizedModelID])) {
      refreshVirtualProviderInBackground({ reason: 'model_selection_miss' });
    }
    const selected = getCursorSdkSelectionFromModelRecord(lastModelRecords?.[normalizedModelID], variant);
    return selected || createFallbackCursorSdkModelSelection(normalizedModelID);
  };

  const getOrCreateAgentResult = async ({
    sessionID,
    apiKey,
    modelID,
    modelSelection,
    directory,
    agentDefinitions,
    mcpServers,
    mcpServerIdentity,
  }) => {
    const model = cloneCursorSdkModelSelection(modelSelection) || createFallbackCursorSdkModelSelection(modelID);
    const agents = pinCursorSdkSubagentModels(cloneCursorSdkAgentDefinitions(agentDefinitions), model);
    const normalizedMcpServers = cloneCursorMcpServers(mcpServers);
    const fingerprint = createAgentRuntimeFingerprint({ directory, model, agents, mcpServerIdentity });
    const cached = agentsBySession.get(sessionID);
    if (cached?.fingerprint === fingerprint && cached?.agent) {
      agentsBySession.delete(sessionID);
      agentsBySession.set(sessionID, cached);
      return { agent: cached.agent, cacheHit: true };
    }

    const { Agent } = await loadSdk();
    const state = await readSessionState(sessionID);
    const local = {
      ...(trimString(directory) ? { cwd: directory } : {}),
      ...(CURSOR_SETTING_SOURCES ? { settingSources: CURSOR_SETTING_SOURCES } : {}),
    };
    const agentOptions = {
      apiKey,
      model,
      local,
      ...(trimString(directory) ? { platform: { workspaceRef: directory } } : {}),
      ...(agents ? { agents } : {}),
      ...(normalizedMcpServers ? { mcpServers: normalizedMcpServers } : {}),
    };
    let agent = null;
    if (state.agentID) {
      try {
        agent = await Agent.resume(state.agentID, agentOptions);
      } catch (error) {
        if (!isMissingCursorAgentError(error)) {
          throw error;
        }
      }
    }
    if (!agent) {
      agent = await Agent.create({
        name: `DevRyan ${sessionID}`,
        ...agentOptions,
      });
    }
    agentsBySession.set(sessionID, { agent, fingerprint });
    while (agentsBySession.size > MAX_CACHED_AGENTS) {
      const oldestSessionID = agentsBySession.keys().next().value;
      if (oldestSessionID === undefined || activeRuns.has(oldestSessionID)) break;
      agentsBySession.delete(oldestSessionID);
    }
    if (agent?.agentId) {
      await updateAgentId(sessionID, agent.agentId);
    }
    return { agent, cacheHit: false };
  };

  const getOrCreateAgent = async (input) => {
    const result = await getOrCreateAgentResult(input);
    return result.agent;
  };

  const persistMessage = async (sessionID, record) => {
    await appendOrReplaceRecord(sessionID, record);
  };

  const createDirectPromptRun = async ({
    sessionID,
    apiKey,
    modelID,
    modelSelection,
    prompt,
    directory,
    images,
    agentDefinitions,
    mcpServers,
    mcpServerIdentity,
  }) => {
    const model = cloneCursorSdkModelSelection(modelSelection) || createFallbackCursorSdkModelSelection(modelID);
    const agent = await getOrCreateAgent({
      sessionID,
      apiKey,
      modelID,
      modelSelection: model,
      directory,
      agentDefinitions,
      mcpServers,
      mcpServerIdentity,
    });
    const message = Array.isArray(images) && images.length > 0
      ? { text: prompt, images }
      : { text: prompt };
    const deltaQueue = createAsyncQueue();
    const run = await agent.send(message, {
      model,
      onDelta: (event) => {
        const sdkMessage = normalizeInteractionUpdateToSdkMessage(event);
        if (sdkMessage) {
          deltaQueue.push(sdkMessage.type === 'usage'
            ? { type: 'usage', tokens: sdkMessage.tokens }
            : { type: 'message', message: sdkMessage });
        }
      },
    });
    const waitPromise = typeof run.wait === 'function'
      ? run.wait()
        .then((result) => ({
          ok: true,
          result,
          finalStatus: finalStatusFromSdkStatus(sdkStatusFromRunStatus(result?.status || run.status)),
          finalText: trimString(result?.result),
        }))
        .catch((error) => ({
          ok: false,
          error,
          finalStatus: 'error',
          finalText: '',
        }))
      : null;
    return {
      async cancel() {
        if (typeof run.cancel === 'function') {
          await run.cancel();
        }
      },
      async waitFinalResult(options = {}) {
        if (!waitPromise) return null;
        return withTimeout(waitPromise, options.timeoutMs);
      },
      async *stream() {
        const iterator = run.stream()[Symbol.asyncIterator]();
        const shouldSkipDuplicateMessage = createCrossSourceMessageDedupe();
        const waitEventPromise = waitPromise
          ? waitPromise.then((result) => ({ source: 'wait', result }))
          : null;
        let streamDone = false;
        let deltaDone = false;
        let nextStreamPromise = iterator.next().then((next) => ({ source: 'stream', next }));
        let nextDeltaPromise = deltaQueue.next().then((next) => ({ source: 'delta', next }));

        async function* yieldSdkMessage(source, sdkMessage) {
          if (shouldSkipDuplicateMessage(source, sdkMessage)) return;
          yield { type: 'message', message: sdkMessage };
        }

        async function* yieldPromptEvent(source, promptEvent) {
          if (promptEvent?.type !== 'message') {
            yield promptEvent;
            return;
          }
          yield* yieldSdkMessage(source, promptEvent.message);
        }

        async function* yieldWaitResult(result) {
          if (!result) return;
          if (result.ok === false) {
            throw result.error || new Error('Cursor SDK run failed.');
          }
          if (trimString(result.finalText)) {
            yield* yieldSdkMessage('wait', {
              type: 'assistant',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: result.finalText }],
              },
            });
          }
          if (result.finalStatus) {
            yield* yieldSdkMessage('wait', {
              type: 'status',
              status: sdkStatusFromRunStatus(result.result?.status || run.status),
            });
          }
        }

        for (;;) {
          const pending = [];
          if (!streamDone) pending.push(nextStreamPromise);
          if (!deltaDone) pending.push(nextDeltaPromise);
          if (waitEventPromise) pending.push(waitEventPromise);
          if (pending.length === 0) {
            break;
          }
          const event = await Promise.race(pending);

          if (event.source === 'wait') {
            nextStreamPromise.catch(() => {});
            nextDeltaPromise.catch(() => {});
            deltaQueue.close();
            if (typeof iterator.return === 'function') {
              iterator.return().catch(() => {});
            }
            yield* yieldWaitResult(event.result);
            return;
          }

          if (event.source === 'delta') {
            if (event.next?.done) {
              deltaDone = true;
              continue;
            }
            nextDeltaPromise = deltaQueue.next().then((next) => ({ source: 'delta', next }));
            yield* yieldPromptEvent('delta', event.next?.value);
            continue;
          }

          if (event.next?.done) {
            streamDone = true;
            deltaQueue.close();
            continue;
          }
          nextStreamPromise = iterator.next().then((next) => ({ source: 'stream', next }));
          yield* yieldSdkMessage('stream', event.next?.value);
        }

        deltaQueue.close();
        if (waitPromise) {
          yield* yieldWaitResult(await withTimeout(waitPromise, finalResultWaitTimeoutMs));
        }
      },
    };
  };

  const generateDirectTitle = async ({ text, directory }) => {
    const promptText = trimString(text);
    if (!promptText) return null;
    const apiKey = getCursorSdkApiKey({ env, readAuth });
    if (!apiKey) return null;

    const { Agent } = await loadSdk();
    return generateCursorSessionTitle({
      Agent,
      apiKey,
      text: promptText,
      directory,
    });
  };

  const generateNodeWorkerTitle = async ({ text, directory }) => {
    const promptText = trimString(text);
    if (!promptText) return null;
    const apiKey = getCursorSdkApiKey({ env, readAuth });
    if (!apiKey) return null;

    const child = spawnImpl(nodeBinary, [workerPath], {
      cwd: workerCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...workerEnv,
      },
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`;
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.stdin.end(JSON.stringify({
      type: 'title',
      apiKey,
      text: promptText,
      directory: trimString(directory),
      modelID: 'auto',
      modelSelection: { id: 'auto' },
    }));

    const exitPromise = new Promise((resolve) => {
      child.on('error', (error) => resolve({ code: 1, signal: null, error }));
      child.on('close', (code, signal) => resolve({ code, signal, error: null }));
    });
    let title = null;
    let workerError = null;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!trimString(line)) continue;
      let payload = null;
      try {
        payload = JSON.parse(line);
      } catch {
        continue;
      }
      if (payload?.type === 'title-result') {
        title = normalizeCursorSessionTitle(payload.title);
      } else if (payload?.type === 'error') {
        workerError = trimString(payload.error) || 'Cursor SDK title generation failed.';
      }
    }

    const exit = await exitPromise;
    if (workerError) throw new Error(workerError);
    if (exit.error) throw exit.error;
    if (exit.code && exit.code !== 0) {
      const detail = trimString(stderr);
      throw new Error(detail
        ? `Cursor SDK title worker exited with code ${exit.code}: ${detail}`
        : `Cursor SDK title worker exited with code ${exit.code}.`);
    }
    return title;
  };

  const createNodeWorkerPromptRun = async ({
    sessionID,
    messageID,
    apiKey,
    modelID,
    modelSelection,
    prompt,
    directory,
    images,
    agentDefinitions,
    mcpServers,
    mcpServerIdentity,
  }) => {
    const state = await readSessionState(sessionID);
    const workerStartedAt = now();
    const child = spawnImpl(nodeBinary, [workerPath], {
      cwd: trimString(directory) || workerCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...workerEnv,
      },
    });
    const markMetadata = { providerID: CURSOR_PROVIDER_ID, modelID };
    recordTimingMark?.({
      sessionId: sessionID,
      messageId: trimString(messageID),
      mark: 'cursor_worker_spawned',
      directory: trimString(directory) || undefined,
      metadata: markMetadata,
    });
    lastWorkerTiming = {
      sessionID,
      messageID: trimString(messageID) || null,
      runtime: 'node-worker',
      spawnedAt: workerStartedAt,
      firstEventAt: null,
      startupDurationMs: null,
      exitAt: null,
      exitCode: null,
      signal: null,
    };

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`;
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    child.stdin.end(JSON.stringify({
      apiKey,
      sessionID,
      modelID,
      modelSelection: cloneCursorSdkModelSelection(modelSelection) || createFallbackCursorSdkModelSelection(modelID),
      agents: cloneCursorSdkAgentDefinitions(agentDefinitions),
      mcpServers: cloneCursorMcpServers(mcpServers),
      mcpServerIdentity: trimString(mcpServerIdentity),
      prompt,
      images: Array.isArray(images) ? images : [],
      directory: trimString(directory),
      agentID: trimString(state.agentID),
    }));

    const exitPromise = new Promise((resolve) => {
      child.on('error', (error) => resolve({ code: 1, signal: null, error }));
      child.on('close', (code, signal) => {
        const exitAt = now();
        lastWorkerTiming = {
          ...(lastWorkerTiming || {}),
          sessionID,
          messageID: trimString(messageID) || null,
          runtime: 'node-worker',
          exitAt,
          exitCode: code,
          signal,
        };
        resolve({ code, signal, error: null });
      });
    });

    const eventQueue = createAsyncQueue();
    let resolveFinalResult = null;
    let finalResultSettled = false;
    const finalResultPromise = new Promise((resolve) => {
      resolveFinalResult = resolve;
    });
    const settleFinalResult = (result) => {
      if (finalResultSettled) return;
      finalResultSettled = true;
      resolveFinalResult?.(result);
    };
    let workerReaderPromise = null;
    let workerReaderError = null;
    let firstEventRecorded = false;

    const recordFirstWorkerEvent = () => {
      if (firstEventRecorded) return;
      firstEventRecorded = true;
      const firstEventAt = now();
      lastWorkerTiming = {
        ...(lastWorkerTiming || {}),
        sessionID,
        messageID: trimString(messageID) || null,
        runtime: 'node-worker',
        spawnedAt: workerStartedAt,
        firstEventAt,
        startupDurationMs: Math.max(0, firstEventAt - workerStartedAt),
      };
      recordTimingMark?.({
        sessionId: sessionID,
        messageId: trimString(messageID),
        mark: 'cursor_worker_first_event',
        directory: trimString(directory) || undefined,
        metadata: markMetadata,
      });
    };

    const startWorkerReader = () => {
      if (workerReaderPromise) return workerReaderPromise;
      workerReaderPromise = (async () => {
        const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
        let workerError = null;
        let completedNaturally = false;
        let sawDone = false;

        try {
          for await (const line of lines) {
            if (!trimString(line)) continue;
            let payload = null;
            try {
              payload = JSON.parse(line);
            } catch {
              continue;
            }
            recordFirstWorkerEvent();

            if (payload?.type === 'agent' && trimString(payload.agentID)) {
              eventQueue.push({ type: 'agent', agentID: trimString(payload.agentID) });
            } else if (payload?.type === 'usage') {
              eventQueue.push({ type: 'usage', tokens: payload.tokens });
            } else if (payload?.type === 'message') {
              eventQueue.push({ type: 'message', message: payload.message });
            } else if (payload?.type === 'final-result') {
              settleFinalResult(payload.result || null);
            } else if (payload?.type === 'done') {
              sawDone = true;
              completedNaturally = true;
              settleFinalResult({
                ok: true,
                finalStatus: finalStatusFromSdkStatus(sdkStatusFromRunStatus(payload.status)),
                finalText: '',
              });
              break;
            } else if (payload?.type === 'error') {
              workerError = trimString(payload.error) || 'Cursor SDK worker failed.';
              settleFinalResult({
                ok: false,
                error: new Error(workerError),
                finalStatus: 'error',
                finalText: '',
              });
            }
          }
          completedNaturally = true;
        } finally {
          if (!completedNaturally && !sawDone && child.exitCode === null && !child.killed) {
            child.kill('SIGTERM');
          }
        }

        if (completedNaturally) {
          const exit = await exitPromise;
          if (workerError) {
            throw new Error(workerError);
          }
          if (exit.error) {
            throw exit.error;
          }
          if (exit.code && exit.code !== 0) {
            const detail = trimString(stderr);
            throw new Error(detail ? `Cursor SDK worker exited with code ${exit.code}: ${detail}` : `Cursor SDK worker exited with code ${exit.code}.`);
          }
        }
        settleFinalResult(null);
      })()
        .catch((error) => {
          workerReaderError = error;
          settleFinalResult({ ok: false, error, finalStatus: 'error', finalText: '' });
        })
        .finally(() => {
          eventQueue.close();
        });
      return workerReaderPromise;
    };

    const cancelWorker = () => {
      if (child.exitCode !== null || child.killed) return;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null && !child.killed) {
          child.kill('SIGKILL');
        }
      }, 2500).unref?.();
    };

    return {
      async cancel() {
        cancelWorker();
      },
      async waitFinalResult(options = {}) {
        startWorkerReader();
        return withTimeout(finalResultPromise, options.timeoutMs);
      },
      async *stream() {
        startWorkerReader();
        try {
          for (;;) {
            const next = await eventQueue.next();
            if (next.done) break;
            yield next.value;
          }
        } finally {
          if (finalResultSettled && child.exitCode === null && !child.killed) {
            cancelWorker();
          }
        }
        await workerReaderPromise;
        if (workerReaderError) {
          throw workerReaderError;
        }
      },
    };
  };

  const createPersistentWorkerRuntime = (runtimeDirectory = '') => {
    let child = null;
    let readerPromise = null;
    let readyPromise = null;
    let resolveReady = null;
    let rejectReady = null;
    let stderr = '';
    let stopping = false;
    let disposed = false;
    let pendingAdmissions = 0;
    let runtimeWorkerReady = false;
    let runtimeWorkerRestarts = 0;
    const requests = new Map();
    const runtimeWorkerCwd = trimString(runtimeDirectory) || workerCwd;

    const clearReadyPromise = () => {
      readyPromise = null;
      resolveReady = null;
      rejectReady = null;
    };

    const createDisposedError = () => {
      const error = new Error('Cursor SDK persistent worker runtime is disposed.');
      error.code = 'CURSOR_PERSISTENT_WORKER_DISPOSED';
      return error;
    };

    const reserveAdmission = () => {
      if (disposed) throw createDisposedError();
      pendingAdmissions += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        pendingAdmissions = Math.max(0, pendingAdmissions - 1);
      };
    };

    const setRequestFinalResult = (request, result) => {
      if (request.finalResultSettled) return;
      request.finalResultSettled = true;
      request.resolveFinalResult?.(result);
    };

    const closeRequest = (requestID, result = null) => {
      const request = requests.get(requestID);
      if (!request) return;
      requests.delete(requestID);
      if (request.kind === 'prepare') {
        request.resolve?.({
          ok: true,
          agentID: trimString(result?.agentID),
          cacheHit: result?.cacheHit === true,
        });
        return;
      }
      if (request.kind === 'title') {
        request.resolve?.(normalizeCursorSessionTitle(result?.title));
        return;
      }
      if (result) {
        setRequestFinalResult(request, result);
      } else {
        setRequestFinalResult(request, {
          ok: true,
          finalStatus: 'success',
          finalText: '',
        });
      }
      request.eventQueue.close();
    };

    const failRequest = (requestID, error) => {
      const request = requests.get(requestID);
      if (!request) return;
      requests.delete(requestID);
      const finalError = error instanceof Error ? error : new Error(String(error || 'Cursor SDK worker failed.'));
      if (request.kind === 'prepare') {
        request.resolve?.({
          ok: false,
          error: finalError.message,
        });
        return;
      }
      if (request.kind === 'title') {
        request.reject?.(finalError);
        return;
      }
      setRequestFinalResult(request, {
        ok: false,
        error: finalError,
        finalStatus: 'error',
        finalText: '',
      });
      request.eventQueue.close();
    };

    const failAllRequests = (error) => {
      for (const requestID of [...requests.keys()]) {
        failRequest(requestID, error);
      }
    };

    const markForRequest = (request, mark, metadata) => {
      if (!request || !mark) return;
      recordTimingMark?.({
        sessionId: request.sessionID,
        messageId: request.messageID,
        mark,
        directory: trimString(request.directory) || undefined,
        metadata: {
          providerID: CURSOR_PROVIDER_ID,
          modelID: request.modelID,
          ...(metadata && isPlainObject(metadata) ? metadata : {}),
        },
      });
    };

    const handleWorkerPayload = (payload) => {
      if (payload?.type === 'ready') {
        runtimeWorkerReady = true;
        resolveReady?.();
        clearReadyPromise();
        return;
      }

      const requestID = trimString(payload?.requestID);
      if (!requestID) return;
      const request = requests.get(requestID);
      if (!request) return;

      if (payload.type === 'timing') {
        markForRequest(request, trimString(payload.mark), payload.metadata);
        return;
      }

      if (payload.type === 'prepared') {
        closeRequest(requestID, {
          agentID: trimString(payload.agentID),
          cacheHit: payload.cacheHit === true,
        });
        return;
      }

      if (payload.type === 'title-result') {
        closeRequest(requestID, { title: payload.title });
        return;
      }

      if (payload.type === 'agent' && trimString(payload.agentID)) {
        request.eventQueue.push({ type: 'agent', agentID: trimString(payload.agentID) });
        return;
      }

      if (payload.type === 'usage') {
        request.eventQueue.push({ type: 'usage', tokens: payload.tokens });
        return;
      }

      if (payload.type === 'message') {
        request.eventQueue.push({ type: 'message', message: payload.message });
        return;
      }

      if (payload.type === 'final-result') {
        const result = payload.result || null;
        if (result?.ok === false && !(result.error instanceof Error)) {
          setRequestFinalResult(request, {
            ...result,
            error: new Error(trimString(result.error) || 'Cursor SDK persistent worker failed.'),
          });
          return;
        }
        setRequestFinalResult(request, result);
        return;
      }

      if (payload.type === 'done') {
        closeRequest(requestID, {
          ok: true,
          finalStatus: finalStatusFromSdkStatus(sdkStatusFromRunStatus(payload.status)),
          finalText: '',
        });
        return;
      }

      if (payload.type === 'error') {
        failRequest(requestID, new Error(trimString(payload.error) || 'Cursor SDK worker failed.'));
      }
    };

    const startReader = (worker, spawnedAt) => {
      readerPromise = (async () => {
        const lines = createInterface({ input: worker.stdout, crlfDelay: Infinity });
        try {
          for await (const line of lines) {
            if (!trimString(line)) continue;
            let payload = null;
            try {
              payload = JSON.parse(line);
            } catch {
              continue;
            }
            if (!lastWorkerTiming?.firstEventAt) {
              const firstEventAt = now();
              lastWorkerTiming = {
                ...(lastWorkerTiming || {}),
                runtime: 'persistent-node-worker',
                firstEventAt,
                startupDurationMs: Math.max(0, firstEventAt - spawnedAt),
              };
            }
            handleWorkerPayload(payload);
          }
        } finally {
          if (child === worker) {
            child = null;
            readerPromise = null;
            runtimeWorkerReady = false;
            clearReadyPromise();
          }
        }
      })().catch((error) => {
        lastError = error instanceof Error ? error.message : 'Cursor SDK persistent worker failed.';
        failAllRequests(error);
      });
      return readerPromise;
    };

    const startWorker = () => {
      if (disposed) throw createDisposedError();
      if (child && child.exitCode === null && !child.killed) return child;
      runtimeWorkerReady = false;
      const spawnedAt = now();
      const worker = spawnImpl(nodeBinary, [persistentWorkerPath], {
        cwd: runtimeWorkerCwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...workerEnv,
        },
      });
      child = worker;
      stderr = '';
      lastWorkerTiming = {
        runtime: 'persistent-node-worker',
        spawnedAt,
        firstEventAt: null,
        startupDurationMs: null,
        exitAt: null,
        exitCode: null,
        signal: null,
      };
      readyPromise = new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });

      worker.stderr.setEncoding('utf8');
      worker.stderr.on('data', (chunk) => {
        stderr = `${stderr}${chunk}`;
        if (stderr.length > 8000) stderr = stderr.slice(-8000);
      });

      worker.on('error', (error) => {
        lastError = error instanceof Error ? error.message : 'Cursor SDK persistent worker failed.';
        rejectReady?.(error);
        failAllRequests(error);
      });
      worker.on('close', (code, signal) => {
        const exitAt = now();
        lastWorkerTiming = {
          ...(lastWorkerTiming || {}),
          runtime: 'persistent-node-worker',
          exitAt,
          exitCode: code,
          signal,
        };
        const detail = trimString(stderr);
        const error = new Error(detail ? `Cursor SDK persistent worker exited with code ${code}: ${detail}` : `Cursor SDK persistent worker exited with code ${code}.`);
        rejectReady?.(error);
        failAllRequests(error);
        if (!stopping) {
          runtimeWorkerRestarts += 1;
        }
      });

      startReader(worker, spawnedAt);
      return worker;
    };

    const waitUntilReady = async () => {
      startWorker();
      if (runtimeWorkerReady) return;
      if (readyPromise) {
        await readyPromise;
      }
    };

    const writeCommand = (command) => {
      const worker = startWorker();
      worker.stdin.write(`${JSON.stringify(command)}\n`);
    };

    return {
      getStatus() {
        return {
          workerMode: useNodeWorkerForPrompts && usePersistentWorkerForPrompts ? 'persistent-node-worker' : (useNodeWorkerForPrompts ? 'node-worker' : 'direct'),
          workerReady: runtimeWorkerReady,
          workerRestarts: runtimeWorkerRestarts,
          activeRequests: requests.size + pendingAdmissions,
        };
      },
      async prewarm(options = {}) {
        if (!useNodeWorkerForPrompts) return;
        await waitUntilReady();
        const warmApiKey = trimString(options?.apiKey);
        if (warmApiKey) {
          try {
            // Warm the persistent worker's backend connection/auth so the
            // first real prompt of a session skips the cold connect cost.
            writeCommand({ type: 'warm', apiKey: warmApiKey });
          } catch {
            // best-effort connection warm; ignore dispatch failures
          }
        }
      },
      async createPromptRun(input) {
        const releaseAdmission = reserveAdmission();
        let requestID = null;
        let eventQueue = null;
        let resolveFinalResult = null;
        let finalResultPromise = null;
        try {
          await waitUntilReady();
          const state = await readSessionState(input.sessionID);
          if (disposed) throw createDisposedError();
          requestID = createId('cursor_req');
          eventQueue = createAsyncQueue();
          finalResultPromise = new Promise((resolve) => {
            resolveFinalResult = resolve;
          });
          const request = {
            kind: 'prompt',
            requestID,
            eventQueue,
            finalResultPromise,
            resolveFinalResult,
            finalResultSettled: false,
            sessionID: input.sessionID,
            messageID: trimString(input.messageID) || null,
            modelID: input.modelID,
            directory: input.directory,
          };
          requests.set(requestID, request);
          releaseAdmission();
          if (runtimeWorkerReady) {
            markForRequest(request, 'cursor_worker_ready', { workerMode: 'persistent-node-worker' });
          }
          writeCommand({
            type: 'prompt',
            requestID,
            apiKey: input.apiKey,
            sessionID: input.sessionID,
            modelID: input.modelID,
            modelSelection: cloneCursorSdkModelSelection(input.modelSelection) || createFallbackCursorSdkModelSelection(input.modelID),
            agents: cloneCursorSdkAgentDefinitions(input.agentDefinitions),
            mcpServers: cloneCursorMcpServers(input.mcpServers),
            mcpServerIdentity: trimString(input.mcpServerIdentity),
            prompt: input.prompt,
            images: Array.isArray(input.images) ? input.images : [],
            directory: trimString(input.directory),
            agentID: trimString(state.agentID),
          });
        } catch (error) {
          releaseAdmission();
          if (requestID) requests.delete(requestID);
          eventQueue?.close();
          throw error;
        }

        return {
          async cancel() {
            try {
              writeCommand({ type: 'cancel', requestID });
            } catch {
            }
          },
          async waitFinalResult(options = {}) {
            return withTimeout(finalResultPromise, options.timeoutMs);
          },
          async *stream() {
            for (;;) {
              const next = await eventQueue.next();
              if (next.done) break;
              yield next.value;
            }
            const result = await finalResultPromise;
            if (result?.ok === false) {
              throw result.error || new Error('Cursor SDK persistent worker failed.');
            }
          },
        };
      },
      async generateTitle(input) {
        const releaseAdmission = reserveAdmission();
        let requestID = null;
        let resolveTitle = null;
        let rejectTitle = null;
        let resultPromise = null;
        try {
          await waitUntilReady();
          if (disposed) throw createDisposedError();
          requestID = createId('cursor_req');
          resultPromise = new Promise((resolve, reject) => {
            resolveTitle = resolve;
            rejectTitle = reject;
          });
          requests.set(requestID, {
            kind: 'title',
            requestID,
            resolve: resolveTitle,
            reject: rejectTitle,
            sessionID: '',
            messageID: null,
            modelID: 'auto',
            directory: input.directory,
          });
          releaseAdmission();
          writeCommand({
            type: 'title',
            requestID,
            apiKey: input.apiKey,
            text: input.text,
            directory: trimString(input.directory),
            modelID: 'auto',
            modelSelection: { id: 'auto' },
          });
        } catch (error) {
          releaseAdmission();
          if (requestID) requests.delete(requestID);
          throw error;
        }

        return resultPromise;
      },
      async prepareSession(input) {
        const releaseAdmission = reserveAdmission();
        let requestID = null;
        let resolvePrepare = null;
        let resultPromise = null;
        try {
          await waitUntilReady();
          const state = await readSessionState(input.sessionID);
          if (disposed) throw createDisposedError();
          requestID = createId('cursor_req');
          resultPromise = new Promise((resolve) => {
            resolvePrepare = resolve;
          });
          const request = {
            kind: 'prepare',
            requestID,
            resolve: resolvePrepare,
            sessionID: input.sessionID,
            messageID: trimString(input.messageID) || null,
            modelID: input.modelID,
            directory: input.directory,
          };
          requests.set(requestID, request);
          releaseAdmission();
          if (runtimeWorkerReady) {
            markForRequest(request, 'cursor_worker_ready', { workerMode: 'persistent-node-worker' });
          }
          writeCommand({
            type: 'prepare',
            requestID,
            apiKey: input.apiKey,
            sessionID: input.sessionID,
            modelID: input.modelID,
            modelSelection: cloneCursorSdkModelSelection(input.modelSelection) || createFallbackCursorSdkModelSelection(input.modelID),
            agents: cloneCursorSdkAgentDefinitions(input.agentDefinitions),
            mcpServers: cloneCursorMcpServers(input.mcpServers),
            mcpServerIdentity: trimString(input.mcpServerIdentity),
            directory: trimString(input.directory),
            agentID: trimString(state.agentID),
          });
        } catch (error) {
          releaseAdmission();
          if (requestID) requests.delete(requestID);
          throw error;
        }

        const result = await resultPromise;
        if (result?.ok !== false && trimString(result?.agentID)) {
          await updateAgentId(input.sessionID, trimString(result.agentID));
        }
        return result;
      },
      releaseSession(sessionID) {
        const id = trimString(sessionID);
        if (!id || disposed || !child || child.exitCode !== null || child.killed) return false;
        try {
          child.stdin.write(`${JSON.stringify({ type: 'release-session', sessionID: id })}\n`);
          return true;
        } catch {
          return false;
        }
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        stopping = true;
        const disposeError = createDisposedError();
        rejectReady?.(disposeError);
        failAllRequests(disposeError);
        if (child && child.exitCode === null && !child.killed) {
          try {
            child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
          } catch {
          }
          child.kill('SIGTERM');
        }
        if (readerPromise) {
          await withTimeout(readerPromise.catch(() => null), 500);
        }
      },
    };
  };

  const persistentWorkerRuntimes = new Map();
  let persistentWorkerPrewarmApiKey = '';

  const createPersistentWorkerCapacityError = () => {
    const error = new Error(`Cursor SDK persistent worker capacity (${MAX_PERSISTENT_WORKERS}) is full.`);
    error.code = 'CURSOR_PERSISTENT_WORKER_CAPACITY';
    return error;
  };

  const getPersistentWorkerRuntime = (directory) => {
    const key = trimString(directory) || workerCwd;
    const cached = persistentWorkerRuntimes.get(key);
    if (cached) {
      persistentWorkerRuntimes.delete(key);
      persistentWorkerRuntimes.set(key, cached);
      return cached;
    }

    if (persistentWorkerRuntimes.size >= MAX_PERSISTENT_WORKERS) {
      const evictable = [...persistentWorkerRuntimes.entries()].find(([, candidate]) => {
        const status = candidate.getStatus();
        return status.workerReady && status.activeRequests === 0;
      });
      if (!evictable) {
        throw createPersistentWorkerCapacityError();
      }
      const [candidateKey, candidate] = evictable;
      persistentWorkerRuntimes.delete(candidateKey);
      candidate.dispose().catch(() => {});
    }

    const runtime = createPersistentWorkerRuntime(key);
    persistentWorkerRuntimes.set(key, runtime);
    if (persistentWorkerPrewarmApiKey) {
      runtime.prewarm({ apiKey: persistentWorkerPrewarmApiKey }).catch((error) => {
        lastError = error instanceof Error ? error.message : 'Cursor SDK persistent worker prewarm failed.';
      });
    }

    return runtime;
  };

  const persistentWorkerRuntime = {
    getStatus() {
      const statuses = [...persistentWorkerRuntimes.values()].map((runtime) => runtime.getStatus());
      return {
        workerMode: 'persistent-node-worker',
        workerReady: statuses.some((status) => status.workerReady),
        workerRestarts: statuses.reduce((total, status) => total + status.workerRestarts, 0),
      };
    },
    async prewarm(options = {}) {
      const directory = trimString(options.directory);
      const apiKey = trimString(options.apiKey);
      if (apiKey) persistentWorkerPrewarmApiKey = apiKey;
      if (!directory) return;
      await getPersistentWorkerRuntime(directory).prewarm(options);
    },
    createPromptRun(input) {
      return getPersistentWorkerRuntime(input.directory).createPromptRun(input);
    },
    generateTitle(input) {
      return getPersistentWorkerRuntime(input.directory).generateTitle(input);
    },
    prepareSession(input) {
      return getPersistentWorkerRuntime(input.directory).prepareSession(input);
    },
    releaseSession(sessionID) {
      let released = false;
      for (const runtime of persistentWorkerRuntimes.values()) {
        released = runtime.releaseSession(sessionID) || released;
      }
      return released;
    },
    async dispose() {
      const runtimes = [...persistentWorkerRuntimes.values()];
      persistentWorkerRuntimes.clear();
      await Promise.all(runtimes.map((runtime) => runtime.dispose()));
    },
  };
  releaseSessionFromPersistentWorkers = (sessionID) => persistentWorkerRuntime.releaseSession(sessionID);

  const createPersistentWorkerPromptRun = async (input) => {
    try {
      return await persistentWorkerRuntime.createPromptRun(input);
    } catch (error) {
      logger.warn?.('[CursorSDK] persistent worker unavailable, falling back to one-shot worker:', error);
      return createNodeWorkerPromptRun(input);
    }
  };

  const generatePersistentWorkerTitle = async (input) => {
    try {
      return await persistentWorkerRuntime.generateTitle(input);
    } catch (error) {
      logger.warn?.('[CursorSDK] persistent title worker unavailable, falling back to one-shot worker:', error);
      return generateNodeWorkerTitle(input);
    }
  };

  const generateTitle = async (input = {}) => {
    const text = trimString(input.text);
    if (!text) return null;
    const apiKey = getCursorSdkApiKey({ env, readAuth });
    if (!apiKey) return null;
    const titleInput = {
      text,
      directory: trimString(input.directory),
      apiKey,
    };
    if (!useNodeWorkerForPrompts) {
      return generateDirectTitle(titleInput);
    }
    if (usePersistentWorkerForPrompts) {
      return generatePersistentWorkerTitle(titleInput);
    }
    return generateNodeWorkerTitle(titleInput);
  };

  const createPromptRun = typeof options.createPromptRun === 'function'
    ? options.createPromptRun
    : useNodeWorkerForPrompts
      ? (usePersistentWorkerForPrompts ? createPersistentWorkerPromptRun : createNodeWorkerPromptRun)
      : createDirectPromptRun;
  const shouldRaceFinalResultBeforeStream = typeof options.createPromptRun === 'function' || useNodeWorkerForPrompts;

  const recordCursorTimingMark = ({
    sessionID,
    messageID,
    mark,
    directory,
    modelID,
    agent,
    variant,
    metadata,
  }) => {
    if (!recordTimingMark) return;
    recordTimingMark({
      sessionId: sessionID,
      messageId: trimString(messageID) || undefined,
      mark,
      directory: trimString(directory) || undefined,
      metadata: {
        providerID: CURSOR_PROVIDER_ID,
        modelID: normalizeModelId(modelID),
        ...(trimString(agent) ? { agent: trimString(agent) } : {}),
        ...(trimString(variant) ? { variant: trimString(variant) } : {}),
        ...(metadata && isPlainObject(metadata) ? metadata : {}),
      },
    });
  };

  const prepareDirectCursorSession = async ({
    sessionID,
    messageID,
    apiKey,
    modelID,
    modelSelection,
    directory,
    agentDefinitions,
    mcpServers,
    mcpServerIdentity,
  }) => {
    recordCursorTimingMark({
      sessionID,
      messageID,
      mark: 'cursor_agent_prepare_started',
      directory,
      modelID,
    });
    const prepared = await getOrCreateAgentResult({
      sessionID,
      apiKey,
      modelID,
      modelSelection,
      directory,
      agentDefinitions,
      mcpServers,
      mcpServerIdentity,
    });
    const agentID = trimString(prepared.agent?.agentId);
    recordCursorTimingMark({
      sessionID,
      messageID,
      mark: 'cursor_agent_prepared',
      directory,
      modelID,
      metadata: { cacheHit: prepared.cacheHit === true },
    });
    return {
      ok: true,
      agentID,
      cacheHit: prepared.cacheHit === true,
    };
  };

  const preparePersistentWorkerCursorSession = async (input) => {
    try {
      return await persistentWorkerRuntime.prepareSession(input);
    } catch (error) {
      if (error?.code === 'CURSOR_PERSISTENT_WORKER_CAPACITY') {
        return {
          ok: false,
          error: error.message,
        };
      }
      logger.warn?.('[CursorSDK] persistent worker session prewarm unavailable, falling back to direct prepare:', error);
      return prepareDirectCursorSession(input);
    }
  };

  const prepareCursorSession = async (input) => (
    useNodeWorkerForPrompts && usePersistentWorkerForPrompts
      ? preparePersistentWorkerCursorSession(input)
      : prepareDirectCursorSession(input)
  );

  const buildExecutionPrompt = async ({
    requestedAgent,
    prompt,
    directory,
    modelID,
    isPlanModePrompt,
  }) => {
    const runtimeContract = getCursorRuntimePromptContract(modelID);
    const instructionBlocks = [];
    if (resolveAgentPrompt && requestedAgent) {
      try {
        const agentInstructions = trimString(await resolveAgentPrompt({ agent: requestedAgent, directory }));
        if (agentInstructions) instructionBlocks.push(agentInstructions);
      } catch (error) {
        logger.warn?.('[CursorSDK] failed to resolve agent prompt:', error);
      }
    }
    const planModeInstructions = isPlanModePrompt
      ? getCursorDirectPlanModeInstructions({ agent: requestedAgent, modelID })
      : '';
    // Decision: plan mode adds no-mutation constraints without shadowing the selected agent's delegation policy.
    if (planModeInstructions) instructionBlocks.push(planModeInstructions);
    const instructions = instructionBlocks.join('\n\n');

    if (!instructions && !runtimeContract) {
      return prompt;
    }

    return formatPromptWithAgentInstructions({
      agent: requestedAgent,
      instructions,
      prompt,
      runtimeContract,
      planFirst: isPlanModePrompt,
    });
  };

  const resolveCursorSdkAgentDefinitionsForPrompt = async ({
    requestedAgent,
    directory,
    modelID,
    modelSelection,
  }) => {
    if (!resolveAgentDefinitions) return null;
    try {
      return cloneCursorSdkAgentDefinitions(await resolveAgentDefinitions({
        agent: requestedAgent,
        selectedAgent: requestedAgent,
        directory,
        modelID,
        modelSelection: cloneCursorSdkModelSelection(modelSelection),
        resolveModelSelection: async ({ modelID: nextModelID, variant: nextVariant } = {}) => (
          resolveCursorSdkModelSelection({ modelID: nextModelID, variant: nextVariant })
        ),
      }));
    } catch (error) {
      logger.warn?.('[CursorSDK] failed to resolve agent definitions:', error);
      return null;
    }
  };

  const getWorkspaceDiffSnapshot = async (directory) => {
    try {
      return normalizeDiffSnapshot(await getWorkspaceDiff(directory));
    } catch {
      return '';
    }
  };

  const prewarmCursorSession = async (input = {}) => {
    const sessionID = trimString(input.sessionID);
    const directory = trimString(input.directory);
    const modelID = normalizeModelId(input.modelID);
    const variant = trimString(input.variant);
    const requestedAgent = trimString(input.agent);
    const messageID = trimString(input.messageID);
    if (!sessionID) {
      return { ok: false, error: 'Session ID is required.' };
    }

    const apiKey = getCursorSdkApiKey({ env, readAuth });
    if (!apiKey) {
      return { ok: false, error: 'Cursor SDK API key is not configured.' };
    }

    recordCursorTimingMark({
      sessionID,
      messageID,
      mark: 'cursor_prewarm_started',
      directory,
      modelID,
      agent: requestedAgent,
      variant,
    });

    try {
      const modelSelection = await resolveCursorSdkModelSelection({ modelID, variant });
      const agentDefinitions = await resolveCursorSdkAgentDefinitionsForPrompt({
        requestedAgent,
        directory,
        modelID,
        modelSelection,
      });
      const questionMcp = await questionRuntime.getMcpServerConfig({
        agent: requestedAgent,
        sessionID,
        directory,
        messageID,
      });
      const result = await prepareCursorSession({
        sessionID,
        messageID,
        apiKey,
        modelID,
        modelSelection,
        directory,
        agentDefinitions,
        mcpServers: cloneCursorMcpServers(questionMcp?.mcpServers),
        mcpServerIdentity: trimString(questionMcp?.identity),
      });
      recordCursorTimingMark({
        sessionID,
        messageID,
        mark: 'cursor_prewarm_completed',
        directory,
        modelID,
        agent: requestedAgent,
        variant,
        metadata: {
          cacheHit: result?.cacheHit === true,
          ok: result?.ok !== false,
        },
      });
      return {
        ok: result?.ok !== false,
        ...(trimString(result?.agentID) ? { agentID: trimString(result.agentID) } : {}),
        cacheHit: result?.cacheHit === true,
        ...(result?.error ? { error: String(result.error) } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Cursor SDK session prewarm failed.';
      lastError = message;
      recordCursorTimingMark({
        sessionID,
        messageID,
        mark: 'cursor_prewarm_completed',
        directory,
        modelID,
        agent: requestedAgent,
        variant,
        metadata: {
          ok: false,
          error: message,
        },
      });
      return { ok: false, error: message };
    }
  };

  const runPrompt = async ({ sessionID, body, directory }) => {
    const apiKey = getCursorSdkApiKey({ env, readAuth });
    if (!apiKey) {
      return {
        handled: true,
        status: 401,
        body: { error: 'Cursor SDK API key is not configured.' },
      };
    }

    // Defensive: if a prior run for this session is still active (e.g. a rapid
    // stop + model switch + resend before the previous run finished tearing
    // down), release it first so we never orphan its activeRuns entry or run two
    // streams against the same session.
    releaseActiveRun(sessionID, { source: 'superseded', emitIdle: false });

    const {
      executionText: prompt,
      visibleText,
      isPlanModePrompt,
      planInstructionParts,
    } = extractPromptPayload(body);
    if (!prompt) {
      return {
        handled: true,
        status: 400,
        body: { error: 'Cursor prompts require at least one text part.' },
      };
    }

    const modelID = normalizeModelId(body?.model?.modelID);
    const variant = trimString(body?.variant);
    const modelSelection = await resolveCursorSdkModelSelection({ modelID, variant });
    const userMessageID = trimString(body?.messageID) || createId('msg');
    const assistantMessageID = createAssistantMessageId(userMessageID);
    const requestedAgent = trimString(body?.agent);
    const fileParts = normalizePromptFileParts(body, { sessionID, messageID: userMessageID });
    const images = buildCursorImages(fileParts);
    const unsupportedAttachmentMessage = getUnsupportedCursorAttachmentMessage(fileParts)
      || getUnsupportedCursorImageUrlMessage(fileParts);
    const unsupportedAgentMessage = getUnsupportedCursorAgentMessage({
      agent: requestedAgent,
      isPlanModePrompt,
      modelID,
    });
    let unsupportedMessage = unsupportedAttachmentMessage || unsupportedAgentMessage;
    let questionMcp = null;
    if (!unsupportedMessage) {
      try {
        questionMcp = await questionRuntime.getMcpServerConfig({
          agent: requestedAgent,
          sessionID,
          directory,
          messageID: userMessageID,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Cursor question bridge failed to start.';
        unsupportedMessage = `Cursor question bridge error: ${detail}`;
      }
    }
    let executionPrompt;
    let agentDefinitions;
    let baselineWorkspaceDiff = '';
    let baselinePatchesByPath = new Map();
    let lastSyntheticWorkspaceDiff = '';
    const baselineWorkspaceDiffPromise = getWorkspaceDiffSnapshot(directory)
      .then((diff) => {
        baselineWorkspaceDiff = diff;
        baselinePatchesByPath = new Map(
          parseUnifiedDiffFiles(diff).map((file) => [file.relativePath, file.patch]),
        );
        lastSyntheticWorkspaceDiff = diff;
        return diff;
      });
    recordCursorTimingMark({
      sessionID,
      messageID: userMessageID,
      mark: 'cursor_baseline_diff_deferred',
      directory,
      modelID,
      agent: requestedAgent,
      variant,
    });
    if (unsupportedMessage) {
      executionPrompt = prompt;
      agentDefinitions = null;
    } else {
      [executionPrompt, agentDefinitions] = await Promise.all([
        buildExecutionPrompt({
          requestedAgent,
          prompt,
          directory,
          modelID,
          isPlanModePrompt,
        }),
        resolveCursorSdkAgentDefinitionsForPrompt({
          requestedAgent,
          directory,
          modelID,
          modelSelection,
        }),
      ]);
    }
    let partSequence = 0;
    let cancellationSource = null;
    // Resolves the instant a host/user stop is requested (markAbortRequested).
    // The cursor-agent keeps emitting buffered deltas for up to the cancel bound
    // after Stop, and forwarding that tail to the renderer is what makes the UI
    // freeze for a beat — racing the stream read against this lets the pump break
    // out immediately instead of draining it.
    let resolveAbortRequested = null;
    const abortRequestedPromise = new Promise((resolve) => { resolveAbortRequested = resolve; });
    const abortRacePromise = abortRequestedPromise.then(() => ({ aborted: true }));
    let syntheticPatchPartID = null;
    let sawMutationCandidateTool = false;
    const toolPartIdsByCallId = new Map();
    const nextPartID = (kind, suffix = '') => {
      partSequence += 1;
      const sequence = String(partSequence).padStart(6, '0');
      return `${assistantMessageID}_part_${sequence}_${kind}${suffix ? `_${suffix}` : ''}`;
    };
    const ensureSyntheticPatchPartID = () => {
      if (!syntheticPatchPartID) {
        syntheticPatchPartID = nextPartID('tool', 'synthetic_workspace_patch');
      }
      return syntheticPatchPartID;
    };
    const getToolPartID = (callID) => {
      const normalizedCallID = trimString(callID) || createId('call');
      const existing = toolPartIdsByCallId.get(normalizedCallID);
      if (existing) return existing;
      const partID = nextPartID('tool', normalizedCallID);
      toolPartIdsByCallId.set(normalizedCallID, partID);
      return partID;
    };
    const created = now();
    const userParts = [{
      id: `${userMessageID}_text`,
      sessionID,
      messageID: userMessageID,
      type: 'text',
      text: visibleText,
    }];
    if (isPlanModePrompt) {
      for (const [index, part] of planInstructionParts.entries()) {
        userParts.push({
          id: `${userMessageID}_plan_mode_${String(index + 1).padStart(2, '0')}`,
          sessionID,
          messageID: userMessageID,
          type: 'text',
          text: part.text,
          synthetic: true,
        });
      }
    }
    userParts.push(...fileParts);

    const userRecord = {
      info: {
        id: userMessageID,
        sessionID,
        role: 'user',
        time: { created },
        providerID: CURSOR_PROVIDER_ID,
        modelID,
        ...(variant ? { variant } : {}),
        ...(requestedAgent ? { agent: requestedAgent } : {}),
        ...(isPlanModePrompt ? { metadata: { openchamberPlanMode: true } } : {}),
      },
      parts: userParts,
    };

    const assistantRecord = {
      info: {
        id: assistantMessageID,
        parentID: userMessageID,
        sessionID,
        role: 'assistant',
        time: { created: created + 1 },
        providerID: CURSOR_PROVIDER_ID,
        modelID,
        ...(variant ? { variant } : {}),
        ...(requestedAgent ? { agent: requestedAgent, mode: requestedAgent } : {}),
      },
      parts: [],
    };

    const emittedMessageInfo = new Map();
    const emittedParts = new Map();
    const rawAssistantTextByPartId = new Map();
    const planTextPartIdsByToolPartId = new Map();
    let emittedOpenCodeTextTiming = false;

    const normalizeAssistantPlanParts = () => {
      if (!isPlanModePrompt) return false;
      const normalizedParts = normalizePlanModeAssistantParts(assistantRecord.parts, { isPlanModePrompt: true });
      if (normalizedParts === assistantRecord.parts || areRuntimeValuesEqual(normalizedParts, assistantRecord.parts)) {
        return false;
      }
      assistantRecord.parts = normalizedParts;
      return true;
    };

    const upsertAssistantPlanTextFromToolPart = (toolPart) => {
      if (!isPlanModePrompt) return false;
      const planText = getCursorPlanToolText(toolPart);
      if (!planText) return false;

      let partID = planTextPartIdsByToolPartId.get(toolPart.id);
      if (!partID) {
        partID = nextPartID('text', 'cursor_plan');
        planTextPartIdsByToolPartId.set(toolPart.id, partID);
      }

      const existing = assistantRecord.parts.find((part) => part.id === partID);
      const existingText = rawAssistantTextByPartId.get(partID) || existing?.text || '';
      if (existing && existingText === planText) {
        return normalizeAssistantPlanParts();
      }

      rawAssistantTextByPartId.set(partID, planText);
      const partChanged = upsertAssistantPart({
        ...(existing || {
          id: partID,
          sessionID,
          messageID: assistantMessageID,
          type: 'text',
          time: { start: now() },
        }),
        text: planText,
      });
      const normalizedChanged = normalizeAssistantPlanParts();
      return partChanged || normalizedChanged;
    };

    const emitStreamingTextPartUpdate = (part, previousPart, recordInfoId, forcePartUpdated) => {
      const messageID = part.messageID || recordInfoId;
      const partID = part.id;
      const nextText = typeof part.text === 'string' ? part.text : '';
      const previousText = previousPart && typeof previousPart.text === 'string' ? previousPart.text : '';
      const markOpenCodeTextEmitted = () => {
        if (emittedOpenCodeTextTiming || !nextText) return;
        emittedOpenCodeTextTiming = true;
        recordTimingMark?.({
          sessionId: sessionID,
          messageId: userMessageID,
          mark: 'cursor_first_emitted_text_delta',
          directory,
          metadata: { providerID: CURSOR_PROVIDER_ID, modelID },
        });
      };

      if (!forcePartUpdated && previousPart) {
        const incrementalDelta = computeIncrementalTextDelta(previousText, nextText);
        if (incrementalDelta) {
          emittedParts.set(partID, part);
          markOpenCodeTextEmitted();
          emit({
            type: 'message.part.delta',
            properties: { messageID, partID, field: 'text', delta: incrementalDelta },
          }, directory);
          return;
        }
      }

      emittedParts.set(partID, part);
      markOpenCodeTextEmitted();
      emit({ type: 'message.part.updated', properties: { part } }, directory);
    };

    const emitRecordDelta = async (record, options = {}) => {
      const forcePartUpdated = options.forcePartUpdated === true;
      const awaitPersist = options.awaitPersist === true;
      const persistBeforeEmit = options.persistBeforeEmit === true;
      const messageInfoAfterParts = options.messageInfoAfterParts === true;
      const propagatePersistError = options.propagatePersistError === true;

      if (persistBeforeEmit) {
        await enqueuePersist(sessionID, record, { propagateError: propagatePersistError });
      }

      const emitMessageInfo = () => {
        const previousInfo = emittedMessageInfo.get(record.info.id);
        if (!previousInfo || !areRuntimeValuesEqual(previousInfo, record.info)) {
          emittedMessageInfo.set(record.info.id, record.info);
          emit({ type: 'message.updated', properties: { info: record.info } }, directory);
        }
      };

      if (!messageInfoAfterParts) emitMessageInfo();

      const currentPartIds = new Set();
      for (const part of record.parts || []) {
        if (!part?.id) continue;
        currentPartIds.add(part.id);
        const previousPart = emittedParts.get(part.id);
        if (previousPart && areRuntimeValuesEqual(previousPart, part)) {
          continue;
        }

        if (
          !forcePartUpdated
          && (part.type === 'text' || part.type === 'reasoning')
          && typeof part.text === 'string'
        ) {
          emitStreamingTextPartUpdate(part, previousPart, record.info.id, forcePartUpdated);
          continue;
        }

        emittedParts.set(part.id, part);
        emit({ type: 'message.part.updated', properties: { part } }, directory);
      }

      for (const [partID, part] of [...emittedParts.entries()]) {
        if (part?.messageID !== record.info.id || currentPartIds.has(partID)) {
          continue;
        }
        emittedParts.delete(partID);
        emit({
          type: 'message.part.removed',
          properties: {
            messageID: record.info.id,
            partID,
          },
        }, directory);
      }

      if (messageInfoAfterParts) emitMessageInfo();

      if (!persistBeforeEmit) {
        const persistPromise = enqueuePersist(sessionID, record, { propagateError: propagatePersistError });
        if (awaitPersist) {
          await persistPromise;
        }
      }
    };

    const upsertAssistantPart = (part) => {
      const existingIndex = assistantRecord.parts.findIndex((existing) => existing.id === part.id);
      if (existingIndex >= 0) {
        const existing = assistantRecord.parts[existingIndex];
        if (areRuntimeValuesEqual(existing, part)) {
          return false;
        }
        assistantRecord.parts = assistantRecord.parts.map((existing, index) => (
          index === existingIndex ? part : existing
        ));
        return true;
      }

      assistantRecord.parts = [...assistantRecord.parts, part];
      return true;
    };

    const syncUserRecordDiffSummary = async (files) => {
      const summary = buildWorkspaceDiffSummary(files);
      if (!summary) {
        if (!hasOwn(userRecord.info, 'summary')) {
          return false;
        }
        const { summary: _summary, ...nextInfo } = userRecord.info;
        void _summary;
        userRecord.info = nextInfo;
        await emitRecordDelta(userRecord, { awaitPersist: true });
        return true;
      }

      if (areRuntimeValuesEqual(userRecord.info.summary, summary)) {
        return false;
      }

      userRecord.info = {
        ...userRecord.info,
        summary,
      };
      await emitRecordDelta(userRecord, { awaitPersist: true });
      return true;
    };

    const syncWorkspacePatchPart = async (completed = now()) => {
      await baselineWorkspaceDiffPromise;
      const currentWorkspaceDiff = await getWorkspaceDiffSnapshot(directory);
      if (currentWorkspaceDiff === lastSyntheticWorkspaceDiff) {
        return false;
      }
      lastSyntheticWorkspaceDiff = currentWorkspaceDiff;

      const files = currentWorkspaceDiff && currentWorkspaceDiff !== baselineWorkspaceDiff
        ? filterWorkspaceDiffFilesAgainstBaselineMap(baselinePatchesByPath, currentWorkspaceDiff)
        : [];

      if (files.length === 0) {
        const summaryChanged = await syncUserRecordDiffSummary([]);
        if (!syntheticPatchPartID) {
          return summaryChanged;
        }
        const nextParts = assistantRecord.parts.filter((part) => part.id !== syntheticPatchPartID);
        if (nextParts.length === assistantRecord.parts.length) {
          return summaryChanged;
        }
        assistantRecord.parts = nextParts;
        await emitRecordDelta(assistantRecord);
        return true;
      }

      await syncUserRecordDiffSummary(files);

      const patchText = files.map((file) => file.patch).join('\n');
      const output = `Applied ${files.length} ${files.length === 1 ? 'patch' : 'patches'}.`;
      const patchPartID = ensureSyntheticPatchPartID();
      const patchPart = {
        id: patchPartID,
        sessionID,
        messageID: assistantMessageID,
        type: 'tool',
        tool: 'apply_patch',
        input: { patchText },
        output,
        state: {
          status: 'completed',
          input: { patchText },
          output,
          metadata: {
            patchText,
            files,
            [SYNTHETIC_WORKSPACE_PATCH_METADATA_KEY]: true,
          },
          time: {
            start: created,
            end: completed,
          },
        },
      };
      assistantRecord.parts = [
        ...assistantRecord.parts.filter((part) => part.id !== patchPartID),
        patchPart,
      ];
      await emitRecordDelta(assistantRecord);
      return true;
    };

    let workspacePatchSyncInFlight = null;
    let workspacePatchSyncDirty = false;

    const scheduleWorkspacePatchSync = () => {
      if (workspacePatchSyncInFlight) {
        workspacePatchSyncDirty = true;
        return;
      }
      workspacePatchSyncInFlight = (async () => {
        try {
          do {
            workspacePatchSyncDirty = false;
            await syncWorkspacePatchPart();
          } while (workspacePatchSyncDirty);
        } finally {
          workspacePatchSyncInFlight = null;
        }
      })();
    };

    const awaitWorkspacePatchSync = async (completed = now()) => {
      if (workspacePatchSyncInFlight) {
        await workspacePatchSyncInFlight;
      }
      await syncWorkspacePatchPart(completed);
    };

    const applyFinalAssistantText = (text) => {
      const finalText = trimString(text);
      if (!finalText) return false;

      const textParts = assistantRecord.parts.filter((part) => part?.type === 'text');
      const getComparableText = (part) => (
        rawAssistantTextByPartId.get(part?.id) || (typeof part?.text === 'string' ? part.text : '')
      );
      const combinedText = textParts
        .map((part) => getComparableText(part))
        .join('');
      const combinedTextWithBreaks = textParts
        .map((part) => getComparableText(part))
        .filter(Boolean)
        .join('\n');
      if (
        combinedText === finalText
        || combinedTextWithBreaks === finalText
        || combinedText.includes(finalText)
        || combinedTextWithBreaks.includes(finalText)
      ) {
        return false;
      }

      const textPart = textParts[textParts.length - 1] || null;
      const textPartIndex = textPart
        ? assistantRecord.parts.findIndex((part) => part?.id === textPart.id)
        : -1;
      const hasContentAfterTextPart = textPartIndex >= 0 && textPartIndex < assistantRecord.parts.length - 1;
      if (hasContentAfterTextPart) {
        const finalContainsExistingText =
          (Boolean(combinedText) && finalText.startsWith(combinedText))
          || (Boolean(combinedTextWithBreaks) && finalText.startsWith(combinedTextWithBreaks));
        if (finalContainsExistingText) {
          const textPartIds = new Set(textParts.map((part) => part.id).filter(Boolean));
          assistantRecord.parts = assistantRecord.parts.filter((part) => {
            if (!textPartIds.has(part?.id)) return true;
            rawAssistantTextByPartId.delete(part.id);
            return false;
          });
        }

        const finalPartId = nextPartID('text', 'final_summary');
        rawAssistantTextByPartId.set(finalPartId, finalText);
        assistantRecord.parts = [
          ...assistantRecord.parts,
          {
            id: finalPartId,
            sessionID,
            messageID: assistantMessageID,
            type: 'text',
            text: finalText,
            time: { start: now() },
          },
        ];
        normalizeAssistantPlanParts();
        return true;
      }

      const existingText = getComparableText(textPart);
      const enrichedFinalText = combinedText && finalText.startsWith(combinedText)
        ? `${existingText}${finalText.slice(combinedText.length)}`
        : combinedTextWithBreaks && finalText.startsWith(combinedTextWithBreaks)
          ? `${existingText}${finalText.slice(combinedTextWithBreaks.length)}`
          : finalText;
      const nextText = isLossyStreamedTextVariant(existingText, enrichedFinalText)
        ? enrichedFinalText
        : mergeFinalText(existingText, enrichedFinalText);
      if (nextText === existingText) return false;

      const nextPartId = textPart?.id || nextPartID('text');
      rawAssistantTextByPartId.set(nextPartId, nextText);
      const partChanged = upsertAssistantPart({
        ...(textPart || {
          id: nextPartId,
          sessionID,
          messageID: assistantMessageID,
          type: 'text',
          time: { start: now() },
        }),
        text: nextText,
      });
      const normalizedChanged = normalizeAssistantPlanParts();
      if (!partChanged && !normalizedChanged) {
        return false;
      }
      return true;
    };

    const waitForFinalRunResult = async (timeoutMs = finalResultWaitTimeoutMs) => {
      if (!run || typeof run.waitFinalResult !== 'function') return null;
      const result = await run.waitFinalResult({ timeoutMs });
      if (!result) return null;
      if (result.ok === false) {
        throw result.error || new Error('Cursor SDK run failed.');
      }
      return result;
    };

    const applyFinalRunResult = (result) => {
      if (!result) return null;
      applyFinalAssistantText(result.finalText);
      return result.finalStatus || null;
    };

    let lastUsageTokens = null;
    const finalizeAssistantRun = async (finalStatus, completed = now(), failureReason = '') => {
      const finish = normalizeFinish(finalStatus);
      if (finish === 'cancelled' || cancellationSource) {
        lastCancellation = {
          sessionID,
          assistantMessageID,
          source: cancellationSource || 'provider_or_runtime',
          finalStatus: finish,
          at: completed,
        };
      }
      if (finish === 'stop' && sawMutationCandidateTool) {
        await awaitWorkspacePatchSync(completed);
      }

      const hasAssistantText = assistantRecord.parts.some((part) => (
        part?.type === 'text' && trimString(part.text || part.content)
      ));
      const hasToolActivity = assistantRecord.parts.some((part) => part?.type === 'tool');
      const hasTaskToolActivity = assistantRecord.parts.some((part) => (
        part?.type === 'tool' && isCursorTaskTool(part.tool)
      ));
      if (finish === 'stop' && !hasAssistantText && hasToolActivity) {
        const summaryText = hasTaskToolActivity
          ? POST_TASK_EMPTY_FINISH_DIAGNOSTIC
          : TOOL_ONLY_COMPLETION_SUMMARY;
        if (hasTaskToolActivity) {
          lastPostTaskEmptyFinish = {
            sessionID,
            assistantMessageID,
            at: completed,
          };
        }
        const summaryPartId = nextPartID('text', 'tool_only_completion');
        rawAssistantTextByPartId.set(summaryPartId, summaryText);
        upsertAssistantPart({
          id: summaryPartId,
          sessionID,
          messageID: assistantMessageID,
          type: 'text',
          text: summaryText,
          time: { start: completed },
        });
      }

      const finalToolStatus = finishToToolStatus(finish);
      assistantRecord.parts = assistantRecord.parts.map((part) => {
        if (part?.type === 'tool') {
          if (part?.state?.status !== 'running' && part?.state?.status !== 'pending') {
            const terminalStatus = normalizeToolCallStatus(part?.state?.status);
            if (
              finalToolStatus === 'error'
              && terminalStatus === 'error'
              && failureReason
              && !trimString(part?.state?.error)
            ) {
              return {
                ...part,
                state: {
                  ...part.state,
                  error: failureReason,
                },
              };
            }
            return part;
          }
          return {
            ...part,
            state: {
              ...part.state,
              status: finalToolStatus,
              ...(finalToolStatus === 'error' && failureReason ? { error: failureReason } : {}),
              time: {
                ...(part.state?.time || {}),
                end: completed,
              },
            },
          };
        }

        if (part?.type === 'reasoning') {
          const text = typeof part.text === 'string' ? part.text : '';
          const trimmedText = trimDanglingReasoningFragment(text);
          if (trimmedText !== text || typeof part?.time?.end !== 'number') {
            return {
              ...part,
              text: trimmedText,
              time: {
                ...(part.time || {}),
                end: completed,
              },
            };
          }
        }

        if (part?.type === 'text' && typeof part?.time?.end !== 'number') {
          return {
            ...part,
            time: {
              ...(part.time || {}),
              end: completed,
            },
          };
        }

        return part;
      });
      normalizeAssistantPlanParts();
      assistantRecord.info = {
        ...assistantRecord.info,
        finish,
        ...(lastUsageTokens ? { tokens: lastUsageTokens } : {}),
        time: {
          ...assistantRecord.info.time,
          completed,
        },
      };
      try {
        await emitRecordDelta(assistantRecord, {
          forcePartUpdated: true,
          awaitPersist: true,
          persistBeforeEmit: true,
          messageInfoAfterParts: true,
          propagatePersistError: true,
        });
      } catch (error) {
        const persistenceMessage = error instanceof Error
          ? error.message
          : 'Cursor SDK could not persist the completed response.';
        lastError = persistenceMessage;
        emit({
          type: 'session.error',
          properties: {
            sessionID,
            error: {
              name: 'CursorPersistenceError',
              message: 'Cursor SDK could not persist the completed response.',
            },
          },
        }, directory);
        sessionStatuses.set(sessionID, { type: 'idle' });
        emit({ type: 'session.status', properties: { sessionID, status: { type: 'idle' } } }, directory);
        return false;
      }
      if (finish === 'error') {
        emit({
          type: 'session.error',
          properties: {
            sessionID,
            error: {
              name: 'CursorProviderError',
              message: failureReason || 'Cursor SDK run failed.',
            },
          },
        }, directory);
      }
      sessionStatuses.set(sessionID, { type: 'idle' });
      emit({ type: 'session.status', properties: { sessionID, status: { type: 'idle' } } }, directory);
      return true;
    };

    sessionStatuses.set(sessionID, { type: 'busy' });
    emit({ type: 'session.status', properties: { sessionID, status: { type: 'busy' } } }, directory);
    try {
      await emitRecordDelta(userRecord, {
        awaitPersist: true,
        persistBeforeEmit: true,
        propagatePersistError: true,
      });
      await emitRecordDelta(assistantRecord, {
        awaitPersist: true,
        persistBeforeEmit: true,
        propagatePersistError: true,
      });
    } catch (error) {
      const persistenceMessage = error instanceof Error
        ? error.message
        : 'Cursor SDK could not persist the accepted prompt.';
      lastError = persistenceMessage;
      emit({
        type: 'session.error',
        properties: {
          sessionID,
          error: {
            name: 'CursorPersistenceError',
            message: 'Cursor SDK could not persist the accepted prompt.',
          },
        },
      }, directory);
      sessionStatuses.set(sessionID, { type: 'idle' });
      emit({ type: 'session.status', properties: { sessionID, status: { type: 'idle' } } }, directory);
      return {
        handled: true,
        status: 204,
        body: null,
      };
    }

    if (unsupportedMessage) {
      applyFinalAssistantText(unsupportedMessage);
      await finalizeAssistantRun('error', now(), unsupportedMessage);
      return {
        handled: true,
        status: 204,
        body: null,
      };
    }

    let run = null;
    try {
      run = await createPromptRun({
        sessionID,
        messageID: userMessageID,
        apiKey,
        modelID,
        modelSelection,
        prompt: executionPrompt,
        directory,
        images,
        agentDefinitions,
        mcpServers: cloneCursorMcpServers(questionMcp?.mcpServers),
        mcpServerIdentity: trimString(questionMcp?.identity),
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Cursor SDK run failed.';
      applyFinalAssistantText(`Cursor SDK error: ${text}`);
      lastError = text;
      questionRuntime.revokeSessionScope(sessionID, {
        identity: trimString(questionMcp?.identity),
        messageID: userMessageID,
        reason: 'the Cursor provider failed to start',
      });
      await finalizeAssistantRun('error', now(), text);
      return {
        handled: true,
        status: 204,
        body: null,
      };
    }
    activeRuns.set(sessionID, {
      run,
      messageID: userMessageID,
      questionScopeIdentity: trimString(questionMcp?.identity),
      assistantMessageID,
      directory,
      markAbortRequested: (source = 'user_abort') => {
        cancellationSource = source;
        resolveAbortRequested?.();
      },
    });

    const pump = (async () => {
      let finalStatus = 'success';
      let runFailureReason = '';
      const finalResultPromise = shouldRaceFinalResultBeforeStream && typeof run.waitFinalResult === 'function'
        ? waitForFinalRunResult(0)
          .then((result) => ({ finalResult: result }))
          .catch((error) => ({ finalError: error }))
        : null;
      let finalResultConsumed = false;

      const shouldFinishOnIdle = () => {
        const assistantText = assistantRecord.parts
          .filter((part) => part?.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text)
          .join('\n')
          .trim();
        const hasRunningTool = assistantRecord.parts.some((part) => (
          part?.type === 'tool' && (part?.state?.status === 'running' || part?.state?.status === 'pending')
        ));
        const hasCompletedTool = assistantRecord.parts.some((part) => (
          part?.type === 'tool' && part?.state?.status && part.state.status !== 'running' && part.state.status !== 'pending'
        ));
        return !hasRunningTool && (assistantText.length > 0 || hasCompletedTool);
      };

      const readNextStreamEvent = async (iterator) => {
        const nextPromise = iterator.next();
        const finalPromise = finalResultPromise && !finalResultConsumed ? finalResultPromise : null;
        const preferReadyStreamEvent = async (result) => {
          if (!('finalResult' in result) && !('finalError' in result)) {
            return result;
          }

          const next = await withTimeout(nextPromise, finalResultStreamDrainGraceMs);
          if (next && !next.done) {
            return { next, idle: false };
          }

          nextPromise.catch(() => {});
          return result;
        };
        if (!streamIdleTimeoutMs || !shouldFinishOnIdle()) {
          const racers = [nextPromise.then((next) => ({ next, idle: false })), abortRacePromise];
          if (finalPromise) {
            racers.push(finalPromise);
          }
          const result = await Promise.race(racers);
          if (result.aborted) {
            nextPromise.catch(() => {});
            return result;
          }
          if ('finalResult' in result && !result.finalResult) {
            finalResultConsumed = true;
            return { next: await nextPromise, idle: false };
          }
          return preferReadyStreamEvent(result);
        }

        let timeout = null;
        const idlePromise = new Promise((resolve) => {
          timeout = setTimeout(() => resolve({ next: null, idle: true }), streamIdleTimeoutMs);
          timeout.unref?.();
        });
        const pending = [
          nextPromise.then((next) => ({ next, idle: false })),
          idlePromise,
          abortRacePromise,
        ];
        if (finalPromise) {
          pending.push(finalPromise);
        }
        const result = await Promise.race(pending);
        if (timeout) clearTimeout(timeout);
        if (result.aborted) {
          nextPromise.catch(() => {});
          return result;
        }
        if ('finalResult' in result && !result.finalResult) {
          finalResultConsumed = true;
          return { next: await nextPromise, idle: false };
        }
        if ('finalResult' in result || 'finalError' in result) {
          return preferReadyStreamEvent(result);
        }
        if (result.idle) {
          nextPromise.catch(() => {});
        }
        return result;
      };

      try {
        const iterator = run.stream()[Symbol.asyncIterator]();
        let activeTextPartID = null;
        let activeReasoningPartID = null;
        let previousContentKind = null;
        let lastCursorTaskToolPartID = null;
        const cursorTaskSummariesByPartId = new Map();

        const finalizeActiveReasoningPart = async (completed = now()) => {
          if (!activeReasoningPartID) return false;
          const existing = assistantRecord.parts.find((part) => part.id === activeReasoningPartID);
          if (!existing || existing.type !== 'reasoning') {
            activeReasoningPartID = null;
            return false;
          }
          if (typeof existing?.time?.end === 'number') {
            activeReasoningPartID = null;
            return false;
          }
          const changed = upsertAssistantPart({
            ...existing,
            metadata: {
              ...(isPlainObject(existing.metadata) ? existing.metadata : {}),
              providerID: CURSOR_PROVIDER_ID,
              cursorSdk: true,
            },
            time: {
              ...(existing.time || {}),
              end: completed,
            },
          });
          activeReasoningPartID = null;
          previousContentKind = 'thinking_completed';
          if (changed) {
            await emitRecordDelta(assistantRecord);
          }
          return changed;
        };

        const applyCursorTaskSummary = async (text) => {
          const summary = trimString(text);
          if (!summary || !lastCursorTaskToolPartID) return false;
          const existing = assistantRecord.parts.find((part) => part.id === lastCursorTaskToolPartID);
          if (!existing || existing.type !== 'tool') return false;
          cursorTaskSummariesByPartId.set(lastCursorTaskToolPartID, summary);
          const metadata = {
            ...(isPlainObject(existing.metadata) ? existing.metadata : {}),
            ...(isPlainObject(existing.state?.metadata) ? existing.state.metadata : {}),
            cursorTaskSummary: summary,
          };
          const updated = {
            ...existing,
            output: summary,
            metadata,
            state: {
              ...(existing.state || {}),
              output: summary,
              metadata,
            },
          };
          const changed = upsertAssistantPart(updated);
          if (changed) {
            await emitRecordDelta(assistantRecord);
          }
          return changed;
        };

        for (;;) {
          const streamRead = await readNextStreamEvent(iterator);
          if (streamRead.aborted) {
            // Host/user pressed Stop: leave the pump now rather than forwarding the
            // cursor-agent's buffered cancel tail to the renderer (the freeze). The
            // underlying run.cancel() was already fired in the background by
            // releaseActiveRun; here we just stop consuming and finalize.
            if (typeof iterator.return === 'function') {
              iterator.return().catch(() => {});
            }
            finalStatus = 'cancelled';
            break;
          }
          if ('finalError' in streamRead) {
            finalResultConsumed = true;
            throw streamRead.finalError || new Error('Cursor SDK run failed.');
          }
          if ('finalResult' in streamRead) {
            finalResultConsumed = true;
            if (!streamRead.finalResult) {
              continue;
            }
            finalStatus = applyFinalRunResult(streamRead.finalResult) || 'success';
            if (typeof iterator.return === 'function') {
              iterator.return().catch(() => {});
            }
            break;
          }
          const { next, idle } = streamRead;
          if (idle) {
            const result = await waitForFinalRunResult(finalResultWaitTimeoutMs);
            finalStatus = applyFinalRunResult(result) || 'success';
            if (typeof iterator.return === 'function') {
              iterator.return().catch(() => {});
            }
            break;
          }
          if (next?.done) break;
          const event = next?.value;
          if (event?.type === 'agent') {
            await updateAgentId(sessionID, event.agentID);
            continue;
          }
          if (event?.type === 'usage') {
            if (isPlainObject(event.tokens)) lastUsageTokens = event.tokens;
            continue;
          }
          const message = event?.type === 'message' ? event.message : event;
          if (!isPlainObject(message)) continue;
          if (message.type === 'assistant') {
            if (previousContentKind === 'thinking') {
              await finalizeActiveReasoningPart();
            }
            const content = Array.isArray(message.message?.content) ? message.message.content : [];
            const text = content
              .filter((block) => block?.type === 'text' && typeof block.text === 'string')
              .map((block) => block.text)
              .join('');
            if (text) {
              if (previousContentKind !== 'assistant' || !activeTextPartID) {
                activeTextPartID = nextPartID('text');
              }
              const existing = assistantRecord.parts.find((part) => part.id === activeTextPartID);
              const existingText = rawAssistantTextByPartId.get(activeTextPartID) || existing?.text || '';
              const nextText = mergeTextDelta(existingText, text);
              rawAssistantTextByPartId.set(activeTextPartID, nextText);
              const partChanged = upsertAssistantPart({
                ...(existing || {
                  id: activeTextPartID,
                  sessionID,
                  messageID: assistantMessageID,
                  type: 'text',
                  time: { start: now() },
                }),
                text: nextText,
              });
              previousContentKind = 'assistant';
              const normalizedChanged = partChanged ? normalizeAssistantPlanParts() : false;
              if (partChanged || normalizedChanged) {
                await emitRecordDelta(assistantRecord);
              }
            }
          } else if (message.type === 'thinking') {
            const text = typeof message.text === 'string' ? message.text : '';
            if (text) {
              if (previousContentKind !== 'thinking' || !activeReasoningPartID) {
                activeReasoningPartID = nextPartID('reasoning');
              }
              const existing = assistantRecord.parts.find((part) => part.id === activeReasoningPartID);
              const existingText = typeof existing?.text === 'string' ? existing.text : '';
              const reasoningPart = {
                ...(existing || {
                  id: activeReasoningPartID,
                  sessionID,
                  messageID: assistantMessageID,
                  type: 'reasoning',
                  metadata: {
                    providerID: CURSOR_PROVIDER_ID,
                    cursorSdk: true,
                  },
                  time: { start: now() },
                }),
                metadata: {
                  ...(isPlainObject(existing?.metadata) ? existing.metadata : {}),
                  providerID: CURSOR_PROVIDER_ID,
                  cursorSdk: true,
                },
                text: mergeTextDelta(existingText, text),
              };
              const partChanged = upsertAssistantPart(reasoningPart);
              previousContentKind = 'thinking';
              if (partChanged) {
                await emitRecordDelta(assistantRecord);
              }
            }
          } else if (message.type === 'thinking_completed') {
            await finalizeActiveReasoningPart();
          } else if (message.type === 'tool_call') {
            if (previousContentKind === 'thinking') {
              await finalizeActiveReasoningPart();
            }
            const partID = getToolPartID(message.call_id);
            const existing = assistantRecord.parts.find((part) => part.id === partID);
            const existingState = isPlainObject(existing?.state) ? existing.state : {};
            const existingInput = isPlainObject(existing?.input)
              ? existing.input
              : (isPlainObject(existingState.input) ? existingState.input : undefined);
            const input = isPlainObject(message.args) ? message.args : existingInput;
            const incomingStatus = normalizeToolCallStatus(message.status);
            const existingStatus = trimString(existingState.status);
            const existingIsTerminal = existingStatus && existingStatus !== 'running' && existingStatus !== 'pending';
            const incomingIsTerminal = incomingStatus !== 'running' && incomingStatus !== 'pending';
            const status = existingIsTerminal && !incomingIsTerminal ? existingStatus : incomingStatus;
            const existingTime = isPlainObject(existingState.time) ? existingState.time : {};
            const startedAt = existingTime.start || now();
            const existingSummary = cursorTaskSummariesByPartId.get(partID);
            const existingOutput = typeof existing?.output === 'string'
              ? existing.output
              : (typeof existingState.output === 'string' ? existingState.output : '');
            const hasResult = hasOwn(message, 'result');
            const hasRetainedPartialOutput = Boolean(trimString(existingOutput || existingSummary));
            const shouldPreservePartialOutput = incomingStatus === 'error' && hasRetainedPartialOutput;
            const resultOutput = hasResult ? safeJson(message.result) : '';
            const output = shouldPreservePartialOutput
              ? existingOutput || existingSummary || ''
              : hasResult
              ? (trimString(resultOutput) ? resultOutput : existingOutput || existingSummary || resultOutput)
              : existingOutput || existingSummary || '';
            const providerFailureReason = incomingStatus === 'error'
              ? readToolFailureReason(message.result)
              : '';
            const existingFailureReason = typeof existingState.error === 'string'
              ? trimString(existingState.error)
              : '';
            const toolFailureReason = providerFailureReason || existingFailureReason;
            const metadata = {
              ...sanitizeProviderToolMetadata(existingState.metadata),
              ...sanitizeProviderToolMetadata(message.metadata),
              ...(existingSummary ? { cursorTaskSummary: existingSummary } : {}),
            };
            const toolPart = {
              id: partID,
              sessionID,
              messageID: assistantMessageID,
              type: 'tool',
              tool: trimString(message.name) || trimString(existing?.tool) || 'tool',
              ...(input ? { input } : {}),
              output,
              state: {
                status,
                ...(input ? { input } : {}),
                output,
                ...(toolFailureReason ? { error: toolFailureReason } : {}),
                ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
                time: {
                  start: startedAt,
                  ...(status !== 'running' && status !== 'pending' ? { end: existingTime.end || now() } : {}),
                },
              },
            };
            if (isCursorTaskTool(message.name)) {
              lastCursorTaskToolPartID = partID;
            }
            const partChanged = upsertAssistantPart(toolPart);
            const isTerminalToolStatus = status !== 'running' && status !== 'pending';
            const planTextChanged = isTerminalToolStatus
              ? upsertAssistantPlanTextFromToolPart(toolPart)
              : false;
            previousContentKind = 'tool';
            if (partChanged || planTextChanged) {
              await emitRecordDelta(assistantRecord);
            }
            if (isTerminalToolStatus && isWorkspaceMutationCandidateTool(message.name)) {
              sawMutationCandidateTool = true;
              scheduleWorkspacePatchSync();
            }
          } else if (message.type === 'task') {
            await applyCursorTaskSummary(message.text);
          } else if (message.type === 'status') {
            const terminalStatus = finalStatusFromSdkStatus(message.status);
            if (terminalStatus) {
              if (terminalStatus !== 'success') {
                runFailureReason = trimString(message.message) || runFailureReason;
              }
              const result = await waitForFinalRunResult(finalResultWaitTimeoutMs);
              applyFinalRunResult(result);
              finalStatus = terminalStatus;
              break;
            }
          }
        }
        const result = await waitForFinalRunResult(finalResultWaitTimeoutMs);
        finalStatus = applyFinalRunResult(result) || finalStatus;
      } catch (error) {
        finalStatus = 'error';
        const text = error instanceof Error ? error.message : 'Cursor SDK run failed.';
        runFailureReason = text;
        const hasAssistantText = assistantRecord.parts.some((part) => (
          part?.type === 'text' && trimString(part.text)
        ));
        if (!hasAssistantText) {
          applyFinalAssistantText(`Cursor SDK error: ${text}`);
        }
        lastError = text;
      } finally {
        // releaseActiveRun already drops this entry on abort, and a fast resend may
        // have installed a new run for the same session — only clear it when it
        // still points at this run so we never evict a freshly-started one.
        if (activeRuns.get(sessionID)?.run === run) {
          activeRuns.delete(sessionID);
        }
        questionRuntime.revokeSessionScope(sessionID, {
          identity: trimString(questionMcp?.identity),
          messageID: userMessageID,
          reason: 'the Cursor run ended before the question was answered',
        });
        await finalizeAssistantRun(finalStatus, now(), runFailureReason);
      }
    })();

    pump.catch((error) => {
      lastError = error instanceof Error ? error.message : 'Cursor SDK stream failed.';
      logger.error?.('[CursorSDK] stream failed:', error);
    });

    return {
      handled: true,
      status: 204,
      body: null,
    };
  };

  return {
    getRuntimeStatus: getStatus,
    getSessionStatus,
    listPendingQuestions(options = {}) {
      return questionRuntime.listPendingQuestions(options);
    },
    async replyToQuestion(requestID, answers) {
      return questionRuntime.replyToQuestion(requestID, answers);
    },
    async rejectQuestion(requestID) {
      return questionRuntime.rejectQuestion(requestID);
    },
    async verifyConnection() {
      const apiKey = getCursorSdkApiKey({ env, readAuth });
      if (!apiKey) {
        return {
          ...getStatus(),
          ok: false,
          configured: false,
          error: 'Cursor SDK API key is not configured.',
        };
      }

      try {
        const { Cursor } = await loadSdk();
        await Cursor.me({ apiKey });
        const provider = await refreshVirtualProviderNow({
          force: true,
          reason: 'verify_connection',
          timeoutMs: modelDiscoveryTimeoutMs,
        });
        if (useNodeWorkerForPrompts && usePersistentWorkerForPrompts) {
          persistentWorkerRuntime.prewarm({ apiKey }).catch((error) => {
            lastError = error instanceof Error ? error.message : 'Cursor SDK persistent worker prewarm failed.';
            logger.warn?.('[CursorSDK] persistent worker prewarm failed:', error);
          });
        }
        return {
          ...getStatus(),
          ok: true,
          configured: true,
          modelCount: Object.keys(provider.models).length,
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Cursor SDK connection failed.';
        return {
          ...getStatus(),
          ok: false,
          configured: true,
          error: lastError,
        };
      }
    },
    async prewarm() {
      const apiKey = getCursorSdkApiKey({ env, readAuth });
      if (!apiKey) {
        return {
          ...getStatus(),
          ok: false,
          configured: false,
          error: 'Cursor SDK API key is not configured.',
        };
      }
      if (useNodeWorkerForPrompts && usePersistentWorkerForPrompts) {
        await persistentWorkerRuntime.prewarm({ apiKey });
      }
      return {
        ...getStatus(),
        ok: true,
        configured: true,
      };
    },
    async prewarmSession(input) {
      return prewarmCursorSession(input);
    },
    async getVirtualProvider() {
      return refreshVirtualProviderNow({
        reason: 'virtual_provider',
        timeoutMs: modelDiscoveryTimeoutMs,
      });
    },
    getCachedVirtualProvider() {
      return buildVirtualProvider(lastModelRecords);
    },
    refreshVirtualProvider(options = {}) {
      return refreshVirtualProviderNow(options);
    },
    async generateTitle(input = {}) {
      return generateTitle(input);
    },
    async handlePromptAsync(input) {
      const providerID = trimString(input?.body?.model?.providerID);
      if (providerID !== CURSOR_PROVIDER_ID) {
        return { handled: false };
      }
      return runPrompt(input);
    },
    async abortSession(sessionID) {
      // Free the session and return immediately; the underlying cancel runs in
      // the background (bounded) so the stop button never hangs and a follow-up
      // model switch / prompt cannot race a run that is still cancelling.
      return releaseActiveRun(sessionID, { source: 'user_abort', emitIdle: true });
    },
    async getSessionMessages(sessionID) {
      const state = await readSessionState(sessionID);
      return Array.isArray(state.records) ? state.records : [];
    },
    async deleteSessionState(sessionID) {
      return deleteSessionState(sessionID);
    },
    async dispose() {
      await questionRuntime.dispose();
      await persistentWorkerRuntime.dispose();
    },
  };
}
