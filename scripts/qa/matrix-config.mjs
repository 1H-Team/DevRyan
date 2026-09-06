import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const QA_SCENARIO_IDS = Object.freeze([
  'core-journey', 'project-work', 'compaction-manual', 'compaction-natural', 'mobile',
  'compaction-retrieval-control', 'compaction-retrieval-compacted',
]);
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CELL_FIELDS = [
  'id', 'runtime', 'transport', 'providerId', 'modelId', 'agent', 'planMode',
  'variant', 'scenarioIds', 'repetitions', 'timeoutMs',
];

export class QaMatrixConfigError extends Error {
  constructor(message) { super(message); this.name = 'QaMatrixConfigError'; this.code = 'invalid_qa_matrix'; }
}

const fail = (message) => { throw new QaMatrixConfigError(message); };
const objectWithFields = (value, fields, label, optionalFields = []) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!fields.includes(key) && !optionalFields.includes(key)) fail(`Unknown ${label} field: ${key}`);
  for (const key of fields) if (!Object.hasOwn(value, key)) fail(`Missing ${label} field: ${key}`);
};
const pinned = (value, label, pattern = /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,255}$/) => {
  if (typeof value !== 'string' || !pattern.test(value)
    || /(?:^|\/)\.\.(?:\/|$)|https?:\/\/|(?:^|[_.:@/-])(?:password|secret|token|api[_-]?key|cookie|credential)(?:$|[_.:@/-])/i.test(value)) {
    fail(`${label} must be a safe pinned identifier`);
  }
  return value;
};
const oneOf = (value, choices, label) => choices.includes(value) ? value : fail(`Invalid ${label}`);
const integer = (value, min, max, label) => Number.isSafeInteger(value) && value >= min && value <= max
  ? value : fail(`${label} must be an integer from ${min} through ${max}`);
const within = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const canonicalTarget = (target) => {
  const suffix = [];
  let ancestor = target;
  while (!existsSync(ancestor)) { suffix.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
  return path.resolve(realpathSync(ancestor), ...suffix);
};

// A separate opt-in schema: the existing qa defaults and agent-eval schema are unchanged.
export const validateQaMatrixConfig = (value, { repoRoot = REPO_ROOT } = {}) => {
  objectWithFields(value, ['schemaVersion', 'evidenceRoot', 'cells'], 'matrix');
  if (value.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (typeof value.evidenceRoot !== 'string' || !value.evidenceRoot.trim() || value.evidenceRoot.includes('\0')) {
    fail('evidenceRoot must be a path inside the repository .cache directory');
  }
  const root = realpathSync(repoRoot);
  const cacheRoot = path.join(root, '.cache');
  const evidenceRoot = path.resolve(root, value.evidenceRoot);
  if (!within(cacheRoot, evidenceRoot) || !within(cacheRoot, canonicalTarget(evidenceRoot))) {
    fail('evidenceRoot must be inside the repository .cache directory without symlink escapes');
  }
  if (!Array.isArray(value.cells) || value.cells.length < 1 || value.cells.length > 500) fail('cells must contain 1 through 500 entries');
  const ids = new Set();
  let runCount = 0;
  const cells = value.cells.map((cell) => {
    objectWithFields(cell, CELL_FIELDS, 'cell', ['projectCompaction']);
    const id = pinned(cell.id, 'cell.id', /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
    if (ids.has(id)) fail('cell IDs must be unique');
    ids.add(id);
    const runtime = oneOf(cell.runtime, ['web', 'electron'], 'runtime');
    const transport = oneOf(cell.transport, ['fixture', 'live'], 'transport');
    const providerId = oneOf(cell.providerId, transport === 'live' ? ['openai', 'anthropic', 'xai'] : ['fixture'], 'providerId for transport');
    const modelId = pinned(cell.modelId, 'modelId');
    const agent = oneOf(cell.agent, ['builder', 'orchestrator'], 'agent');
    if (typeof cell.planMode !== 'boolean') fail('planMode must be a boolean');
    const variant = cell.variant === null ? null : pinned(cell.variant, 'variant');
    if (!Array.isArray(cell.scenarioIds) || !cell.scenarioIds.length) fail('scenarioIds must be a nonempty array');
    const scenarioIds = cell.scenarioIds.map((scenario) => oneOf(scenario, QA_SCENARIO_IDS, 'scenarioId'));
    if (new Set(scenarioIds).size !== scenarioIds.length) fail('scenarioIds must be unique');
    if (scenarioIds.includes('mobile') && runtime !== 'web') fail('mobile requires web');
    if (scenarioIds.includes('compaction-natural') && (runtime !== 'electron' || transport !== 'live')) {
      fail('compaction-natural requires live Electron');
    }
    if (scenarioIds.some(scenario => scenario.startsWith('compaction-retrieval-'))
      && (runtime !== 'electron' || transport !== 'live' || agent !== 'builder' || cell.planMode !== false)) {
      fail('compaction-retrieval diagnostics require live Electron Builder with Plan off');
    }
    if (Object.hasOwn(cell, 'projectCompaction') && (cell.projectCompaction !== 'manual'
      || runtime !== 'electron' || transport !== 'live' || scenarioIds.length !== 1 || scenarioIds[0] !== 'project-work')) {
      fail('projectCompaction must be manual on a live Electron project-work cell');
    }
    const repetitions = integer(cell.repetitions, 1, 100, 'repetitions');
    const timeoutMs = integer(cell.timeoutMs, 1_000, 86_400_000, 'timeoutMs');
    runCount += repetitions * scenarioIds.length;
    return Object.freeze({ id, runtime, transport, providerId, modelId, agent, planMode: cell.planMode,
      variant, scenarioIds: Object.freeze(scenarioIds), repetitions, timeoutMs,
      ...(Object.hasOwn(cell, 'projectCompaction') ? { projectCompaction: cell.projectCompaction } : {}) });
  });
  if (runCount > 10_000) fail('matrix may not expand beyond 10000 runs');
  return Object.freeze({ schemaVersion: 1, evidenceRoot, cells: Object.freeze(cells) });
};

export const loadQaMatrixConfig = (configPath, options = {}) => {
  let value;
  try { value = JSON.parse(readFileSync(path.resolve(options.repoRoot ?? REPO_ROOT, configPath), 'utf8')); }
  catch { fail('Cannot read QA matrix JSON'); }
  return validateQaMatrixConfig(value, options);
};

export const expandQaMatrix = (value, options = {}) => {
  const config = validateQaMatrixConfig(value, options);
  return config.cells.flatMap(({ scenarioIds, repetitions, ...cell }) => scenarioIds.flatMap((scenarioId) => (
    Array.from({ length: repetitions }, (_, index) => {
      const repetition = index + 1;
      const runId = `${cell.id}-${scenarioId}-${repetition}`;
      return Object.freeze({ ...cell, scenarioId, repetition, runId,
        evidenceDirectory: path.join(config.evidenceRoot, runId) });
    })
  )));
};
