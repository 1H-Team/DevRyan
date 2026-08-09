import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const EVALUATION_CASE_IDS = Object.freeze([
  'inspect',
  'repair-and-test',
  'managed-change',
  'oracle-review-focused',
  'oracle-review-deep',
]);

const REQUIRED_FIELDS = Object.freeze([
  'schemaVersion',
  'fixtureRoot',
  'devRyanBaseUrl',
  'providerId',
  'modelId',
  'agent',
  'variant',
  'caseIds',
  'repetitions',
  'timeoutMs',
  'reportDirectory',
]);

const OPTIONAL_FIELDS = Object.freeze(['processSampling']);
const PROCESS_SAMPLING_FIELDS = Object.freeze([
  'electronPid',
  'caseId',
  'intervalMs',
  'idleSeconds',
  'cycles',
  'settlementSeconds',
  'runs',
]);

const USAGE = 'Usage: bun run agent:eval -- --config <path>';

export class EvaluationConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EvaluationConfigError';
    this.code = 'invalid_evaluation_config';
  }
}

const isPlainObject = (value) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
);

const resolveRepoPath = (value, repoRoot, field) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new EvaluationConfigError(`${field} must be a non-empty path string`);
  }
  return path.resolve(repoRoot, value.trim());
};

const requirePinnedString = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new EvaluationConfigError(`${field} must be an explicit non-empty config string`);
  }
  return value.trim();
};

const UNSAFE_IDENTIFIER_SHAPE = /(?:https?:\/\/|\bbearer\b|(?:^|[_.:@/-])(?:token|api[_-]?key|password|cookie|authorization|credential|secret)(?:$|[_.:@/-])|^error(?:$|[:_\s-]))/i;
const SAFE_PINNED_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,255}$/;

const requirePinnedIdentifier = (value, field) => {
  const normalized = requirePinnedString(value, field);
  const pathShaped = /^(?:~|\/|\\|[a-zA-Z]:[\\/])/.test(normalized)
    || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(normalized);
  if (!SAFE_PINNED_IDENTIFIER.test(normalized) || pathShaped || UNSAFE_IDENTIFIER_SHAPE.test(normalized)) {
    throw new EvaluationConfigError(`${field} must be a safe pinned identifier`);
  }
  return normalized;
};

const assertSafeInteger = (value, field, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new EvaluationConfigError(
      `${field} config value must be an integer from ${minimum} through ${maximum}`,
    );
  }
  return value;
};

const normalizeLoopbackUrl = (value) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new EvaluationConfigError('devRyanBaseUrl must be an explicit loopback base URL');
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new EvaluationConfigError('devRyanBaseUrl must be a valid loopback base URL');
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (!loopback || !['http:', 'https:'].includes(url.protocol)) {
    throw new EvaluationConfigError('devRyanBaseUrl must use HTTP(S) on a loopback host');
  }
  if (url.username || url.password) {
    throw new EvaluationConfigError('devRyanBaseUrl must not contain credentials');
  }
  if (url.search || url.hash) {
    throw new EvaluationConfigError('devRyanBaseUrl must be a base URL without query or fragment data');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname && pathname !== '/api') {
    throw new EvaluationConfigError('devRyanBaseUrl base URL path must be empty or /api');
  }
  url.pathname = pathname;
  return url.toString().replace(/\/$/, '');
};

const normalizeProcessSampling = (value) => {
  if (!isPlainObject(value)) {
    throw new EvaluationConfigError('processSampling config must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!PROCESS_SAMPLING_FIELDS.includes(key)) {
      throw new EvaluationConfigError(`Unknown processSampling config field: ${key}`);
    }
  }
  for (const key of PROCESS_SAMPLING_FIELDS) {
    if (!Object.hasOwn(value, key)) {
      throw new EvaluationConfigError(`Missing processSampling config field: ${key}`);
    }
  }
  const normalized = {
    electronPid: assertSafeInteger(value.electronPid, 'processSampling.electronPid'),
    caseId: requirePinnedString(value.caseId, 'processSampling.caseId'),
    intervalMs: assertSafeInteger(value.intervalMs, 'processSampling.intervalMs'),
    idleSeconds: assertSafeInteger(value.idleSeconds, 'processSampling.idleSeconds'),
    cycles: assertSafeInteger(value.cycles, 'processSampling.cycles'),
    settlementSeconds: assertSafeInteger(value.settlementSeconds, 'processSampling.settlementSeconds'),
    runs: assertSafeInteger(value.runs, 'processSampling.runs'),
  };
  if (!EVALUATION_CASE_IDS.includes(normalized.caseId)) {
    throw new EvaluationConfigError(`processSampling.caseId config must be one of ${EVALUATION_CASE_IDS.join(', ')}`);
  }
  const prescribed = {
    intervalMs: 1_000,
    idleSeconds: 60,
    cycles: 5,
    settlementSeconds: 30,
    runs: 2,
  };
  for (const [key, expected] of Object.entries(prescribed)) {
    if (normalized[key] !== expected) {
      throw new EvaluationConfigError(`processSampling.${key} config must be ${expected}`);
    }
  }
  return normalized;
};

const isWithin = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

const resolveCanonicalTarget = (candidate) => {
  const suffix = [];
  let existingAncestor = path.resolve(candidate);
  while (!existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    suffix.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }
  return path.resolve(realpathSync(existingAncestor), ...suffix);
};

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const parseEvaluationArgs = (argv, options = {}) => {
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot);
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== '--config') {
    throw new EvaluationConfigError(USAGE);
  }
  if (typeof argv[1] !== 'string' || !argv[1].trim() || argv[1].startsWith('-')) {
    throw new EvaluationConfigError(USAGE);
  }
  return { configPath: path.resolve(repoRoot, argv[1].trim()) };
};

export const validateEvaluationConfig = (value, options = {}) => {
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot);
  if (!isPlainObject(value)) {
    throw new EvaluationConfigError('Evaluation config must be a JSON object');
  }
  for (const key of Object.keys(value)) {
    if (![...REQUIRED_FIELDS, ...OPTIONAL_FIELDS].includes(key)) {
      throw new EvaluationConfigError(`Unknown config field: ${key}`);
    }
  }
  for (const key of REQUIRED_FIELDS) {
    if (!Object.hasOwn(value, key)) {
      throw new EvaluationConfigError(`Missing required config field: ${key}`);
    }
  }
  if (value.schemaVersion !== 1) {
    throw new EvaluationConfigError('schemaVersion config value must be exactly 1');
  }

  const fixtureRoot = resolveRepoPath(value.fixtureRoot, repoRoot, 'fixtureRoot');
  let fixtureStats;
  try {
    fixtureStats = statSync(fixtureRoot);
  } catch {
    throw new EvaluationConfigError('fixtureRoot config path must exist');
  }
  if (!fixtureStats.isDirectory()) {
    throw new EvaluationConfigError('fixtureRoot config path must be a directory');
  }
  try {
    if (!statSync(path.join(fixtureRoot, 'src')).isDirectory()) {
      throw new Error('not a directory');
    }
  } catch {
    throw new EvaluationConfigError('fixtureRoot config must contain an existing src directory');
  }

  const reportDirectory = resolveRepoPath(value.reportDirectory, repoRoot, 'reportDirectory');
  const canonicalReportDirectory = resolveCanonicalTarget(reportDirectory);
  if (isWithin(realpathSync(fixtureRoot), canonicalReportDirectory)) {
    throw new EvaluationConfigError('reportDirectory config must be outside fixtureRoot');
  }

  if (!Array.isArray(value.caseIds) || value.caseIds.length === 0) {
    throw new EvaluationConfigError('caseIds config must be a non-empty array');
  }
  const caseIds = value.caseIds.map((caseId) => requirePinnedString(caseId, 'caseIds entry'));
  if (new Set(caseIds).size !== caseIds.length) {
    throw new EvaluationConfigError('caseIds config entries must be unique');
  }
  for (const caseId of caseIds) {
    if (!EVALUATION_CASE_IDS.includes(caseId)) {
      throw new EvaluationConfigError(`caseIds config contains unknown case: ${caseId}`);
    }
  }
  if (value.variant !== null && (typeof value.variant !== 'string' || !value.variant.trim())) {
    throw new EvaluationConfigError('variant config must be a non-empty string or null');
  }

  return Object.freeze({
    schemaVersion: 1,
    fixtureRoot,
    devRyanBaseUrl: normalizeLoopbackUrl(value.devRyanBaseUrl),
    providerId: requirePinnedIdentifier(value.providerId, 'providerId'),
    modelId: requirePinnedIdentifier(value.modelId, 'modelId'),
    agent: requirePinnedIdentifier(value.agent, 'agent'),
    variant: value.variant === null ? null : requirePinnedIdentifier(value.variant, 'variant'),
    caseIds: Object.freeze([...caseIds]),
    repetitions: assertSafeInteger(value.repetitions, 'repetitions', { maximum: 100 }),
    timeoutMs: assertSafeInteger(value.timeoutMs, 'timeoutMs', { minimum: 1_000, maximum: 86_400_000 }),
    reportDirectory,
    ...(Object.hasOwn(value, 'processSampling')
      ? { processSampling: Object.freeze(normalizeProcessSampling(value.processSampling)) }
      : {}),
  });
};

export const loadEvaluationConfig = (configPath, options = {}) => {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    const kind = error?.code === 'ENOENT' ? 'does not exist' : 'is not valid JSON';
    throw new EvaluationConfigError(`Evaluation config ${kind}`);
  }
  return validateEvaluationConfig(parsed, options);
};
