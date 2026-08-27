import {
  BOT_POLICY_EFFECTS,
  BOT_RISK_LEVELS,
  assertBotJsonValue,
  hashCanonicalBotJson,
  hashBotAction,
  resolveBotApprovalClass,
  validateBotActionDescriptor,
} from '@openchamber/bots-runtime';

import {
  assertExactObject,
  validateBoundedJsonObject,
  validateBoundedString,
} from './validation.js';

export const BOT_BROWSER_READ_ACTIONS = Object.freeze([
  'download',
  'navigate',
  'screenshot',
  'scroll',
  'snapshot',
  'status',
  'wait',
]);
export const BOT_BROWSER_MUTATING_ACTIONS = Object.freeze([
  'click',
  'fill',
  'key',
  'select',
  'upload',
]);

const EFFECT_RANK = Object.freeze({ allow: 0, prompt: 1, deny: 2 });
const RISK_RANK = Object.freeze({ low: 0, sensitive: 1, critical: 2 });
const DEFAULT_DECISION_TTL_SECONDS = 15 * 60;
const MAX_DECISION_TTL_SECONDS = 24 * 60 * 60;
const MATCHER_VERSIONS = Object.freeze([1, 2]);
const ACTOR_ROLES = Object.freeze(['member', 'operator', 'manager']);
const ARGUMENT_PREDICATE_OPERATORS = Object.freeze([
  'exists', 'eq', 'in', 'prefix', 'suffix', 'glob', 'gte', 'lte', 'arrayContains',
]);
const MAX_GLOB_COUNT = 64;
const MAX_GLOB_BYTES = 512;
const MAX_COMPILED_GLOB_CACHE_ENTRIES = 4_096;
const MAX_ARGUMENT_PREDICATES = 32;
const MAX_QUOTA_LIMIT = 1_000_000;
const MAX_QUOTA_WINDOW_SECONDS = 24 * 60 * 60;
const DISTINCT_CRITICAL_ACTION = /(?:^|[._:\s-])(?:purge|credential[._:\s-]?export|secret[._:\s-]?export|purchase|buy|checkout|pay|payment|transfer|delete|remove|destroy|invite|grant|revoke|approve|deploy|release|broad[._:\s-]?autonomy|autonomy[._:\s-]?broad)(?:$|[._:\s-])/i;
const PRODUCTION_PUBLICATION = /\b(?:publish|publication|release|deploy)\b[\s\S]{0,48}\b(?:production|prod|live)\b|\b(?:production|prod|live)\b[\s\S]{0,48}\b(?:publish|publication|release|deploy)\b/i;
const compiledGlobCache = new Map();

export class BotPolicyEngineError extends Error {
  constructor(message, code = 'bot_policy_invalid', statusCode = 400) {
    super(message);
    this.name = 'BotPolicyEngineError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotPolicyEngineError(message, code, statusCode);
};

const effect = (value, field) => {
  if (!BOT_POLICY_EFFECTS.includes(value)) fail(`${field} is invalid`);
  return value;
};

const risk = (value, field) => {
  if (!BOT_RISK_LEVELS.includes(value)) fail(`${field} is invalid`);
  return value;
};

const stringList = (value, field, { maximum = 64, normalize = (entry) => entry } = {}) => {
  if (!Array.isArray(value) || value.length > maximum) fail(`${field} is invalid`);
  const entries = value.map((entry, index) => normalize(validateBoundedString(
    entry,
    `${field}[${index}]`,
    { maximum: 512 },
  )));
  if (new Set(entries).size !== entries.length) fail(`${field} contains duplicates`);
  return Object.freeze(entries);
};

const normalizeOrigin = (value, field) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${field} is invalid`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) {
    fail(`${field} must be an HTTP(S) origin`);
  }
  return url.origin;
};

const normalizePercentEscapes = (value) => value.replace(/%[0-9a-f]{2}/giu, (escape) => (
  escape.toUpperCase()
));

const validateStructuredGlob = (value, field, { pathKind }) => {
  const glob = validateBoundedString(value, field, { maximum: MAX_GLOB_BYTES });
  if (/[\u0000-\u001f\u007f]/u.test(glob)) {
    fail(`${field} is invalid`);
  }
  const normalized = normalizePercentEscapes(glob.normalize('NFC'));
  if (/%(?:2F|5C)/u.test(normalized)) fail(`${field} contains an encoded separator`);
  if (pathKind === 'url') {
    if (!normalized.startsWith('/') || normalized.includes('?') || normalized.includes('#')
      || /%(?:0[0-9A-F]|1[0-9A-F]|7F)/u.test(normalized)) {
      fail(`${field} must be a URL pathname glob`);
    }
  } else if (pathKind === 'file' && (!normalized.startsWith('/')
    || normalized.includes('//')
    || normalized.split('/').some((segment) => segment === '.' || segment === '..')
    || /^\/(?:Users|Volumes|private|home|root)(?:\/|$)/u.test(normalized)
    || normalized === '/var/run/docker.sock')) {
    fail(`${field} must be a canonical virtual POSIX path glob`);
  }
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === '\\') {
      if (!['*', '?', '\\'].includes(normalized[index + 1])) {
        fail(`${field} contains an invalid escape`);
      }
      index += 1;
    } else if (/[\[\]{}()|+^$]/u.test(character)) {
      fail(`${field} contains an unsupported glob token`);
    }
  }
  compiledStructuredGlob(normalized);
  return normalized;
};

const structuredGlobRegex = (glob) => {
  let source = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === '\\') {
      index += 1;
      source += glob[index].replace(/[\\.^$|()\[\]{}+*?]/gu, '\\$&');
    } else if (character === '*') {
      if (glob[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/]*';
      }
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += character.replace(/[\\.^$|()\[\]{}+]/gu, '\\$&');
    }
  }
  return new RegExp(`${source}$`, 'u');
};

const compiledStructuredGlob = (glob) => {
  const existing = compiledGlobCache.get(glob);
  if (existing) return existing;
  const compiled = structuredGlobRegex(glob);
  if (compiledGlobCache.size >= MAX_COMPILED_GLOB_CACHE_ENTRIES) {
    compiledGlobCache.delete(compiledGlobCache.keys().next().value);
  }
  compiledGlobCache.set(glob, compiled);
  return compiled;
};

const matchesStructuredGlob = (glob, value) => compiledStructuredGlob(glob).test(value);

const normalizeJsonPointer = (value, field) => {
  const pointer = typeof value === 'string' ? value : null;
  if (pointer === null || pointer.length > 512 || /[\u0000-\u001f\u007f]/u.test(pointer)) {
    fail(`${field} is not a JSON Pointer`);
  }
  if (pointer !== '' && !pointer.startsWith('/')) fail(`${field} is not a JSON Pointer`);
  if (/(?:~(?![01]))/u.test(pointer)) fail(`${field} is not a JSON Pointer`);
  return pointer;
};

const normalizeArgumentPredicate = (value, ruleIndex, predicateIndex) => {
  const field = `actionPolicy.rules[${ruleIndex}].match.argumentPredicates[${predicateIndex}]`;
  try {
    assertExactObject(value, {
      label: field,
      required: ['pointer', 'op'],
      optional: ['value'],
    });
    assertBotJsonValue(value.value, `${field}.value`);
  } catch (error) {
    if (value?.op === 'exists' && !Object.hasOwn(value, 'value')) {
      // `undefined` is not JSON, but it is the required absence for exists.
    } else {
      fail(error.message);
    }
  }
  if (!ARGUMENT_PREDICATE_OPERATORS.includes(value.op)) fail(`${field}.op is invalid`);
  const hasValue = Object.hasOwn(value, 'value');
  if ((value.op === 'exists' && hasValue) || (value.op !== 'exists' && !hasValue)) {
    fail(`${field}.value is invalid`);
  }
  if (hasValue && Buffer.byteLength(JSON.stringify(value.value), 'utf8') > 16 * 1024) {
    fail(`${field}.value is too large`);
  }
  if (['prefix', 'suffix', 'glob'].includes(value.op) && typeof value.value !== 'string') {
    fail(`${field}.value must be a string`);
  }
  if (value.op === 'in' && (!Array.isArray(value.value) || value.value.length > 64)) {
    fail(`${field}.value must be a bounded array`);
  }
  if (['gte', 'lte'].includes(value.op) && !Number.isFinite(value.value)) {
    fail(`${field}.value must be a finite number`);
  }
  return Object.freeze({
    pointer: normalizeJsonPointer(value.pointer, `${field}.pointer`),
    op: value.op,
    ...(hasValue ? { value: structuredClone(value.value) } : {}),
  });
};

const normalizeQuota = (value, index) => {
  const field = `actionPolicy.rules[${index}].quota`;
  try {
    assertExactObject(value, {
      label: field,
      required: ['scope', 'limit', 'windowSeconds'],
    });
  } catch (error) {
    fail(error.message);
  }
  if (!['actor', 'bot'].includes(value.scope)
    || !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > MAX_QUOTA_LIMIT
    || !Number.isSafeInteger(value.windowSeconds) || value.windowSeconds < 1
    || value.windowSeconds > MAX_QUOTA_WINDOW_SECONDS) {
    fail(`${field} is invalid`);
  }
  return Object.freeze({
    scope: value.scope,
    limit: value.limit,
    windowSeconds: value.windowSeconds,
  });
};

const normalizeMatch = (value, index, matcherVersion) => {
  try {
    assertExactObject(value, {
      label: `actionPolicy.rules[${index}].match`,
      required: [],
      optional: [
        'tool', 'actions', 'origins', 'operationKinds', 'actorRoles',
        'urlPathGlobs', 'filePaths', 'argumentPredicates',
      ],
    });
  } catch (error) {
    fail(error.message);
  }
  if (Object.keys(value).length === 0) fail(`actionPolicy.rules[${index}].match is empty`);
  const v2Fields = ['actorRoles', 'urlPathGlobs', 'filePaths', 'argumentPredicates'];
  if (matcherVersion !== 2 && v2Fields.some((field) => Object.hasOwn(value, field))) {
    fail(`actionPolicy.rules[${index}].match requires matcherVersion 2`);
  }
  let filePaths;
  if (value.filePaths !== undefined) {
    try {
      assertExactObject(value.filePaths, {
        label: `actionPolicy.rules[${index}].match.filePaths`,
        required: ['quantifier', 'globs'],
      });
    } catch (error) {
      fail(error.message);
    }
    if (!['any', 'all'].includes(value.filePaths.quantifier)) {
      fail(`actionPolicy.rules[${index}].match.filePaths.quantifier is invalid`);
    }
    filePaths = Object.freeze({
      quantifier: value.filePaths.quantifier,
      globs: stringList(value.filePaths.globs, `actionPolicy.rules[${index}].match.filePaths.globs`, {
        maximum: MAX_GLOB_COUNT,
        normalize: (entry) => validateStructuredGlob(
          entry,
          `actionPolicy.rules[${index}].match.filePaths.globs`,
          { pathKind: 'file' },
        ),
      }),
    });
  }
  const predicates = value.argumentPredicates === undefined
    ? undefined
    : (() => {
        if (!Array.isArray(value.argumentPredicates)
          || value.argumentPredicates.length < 1
          || value.argumentPredicates.length > MAX_ARGUMENT_PREDICATES) {
          fail(`actionPolicy.rules[${index}].match.argumentPredicates is invalid`);
        }
        return Object.freeze(value.argumentPredicates.map((predicate, predicateIndex) => (
          normalizeArgumentPredicate(predicate, index, predicateIndex)
        )));
      })();
  return Object.freeze({
    ...(value.tool === undefined ? {} : {
      tool: validateBoundedString(value.tool, `actionPolicy.rules[${index}].match.tool`, {
        maximum: 120,
      }),
    }),
    ...(value.actions === undefined ? {} : {
      actions: stringList(value.actions, `actionPolicy.rules[${index}].match.actions`, {
        normalize: (entry) => entry.toLowerCase(),
      }),
    }),
    ...(value.origins === undefined ? {} : {
      origins: stringList(value.origins, `actionPolicy.rules[${index}].match.origins`, {
        normalize: (entry) => normalizeOrigin(entry, `actionPolicy.rules[${index}].match.origins`),
      }),
    }),
    ...(value.operationKinds === undefined ? {} : {
      operationKinds: stringList(
        value.operationKinds,
        `actionPolicy.rules[${index}].match.operationKinds`,
        { normalize: (entry) => {
          if (!['read', 'write'].includes(entry)) {
            fail(`actionPolicy.rules[${index}].match.operationKinds is invalid`);
          }
          return entry;
        } },
      ),
    }),
    ...(value.actorRoles === undefined ? {} : {
      actorRoles: stringList(value.actorRoles, `actionPolicy.rules[${index}].match.actorRoles`, {
        normalize: (entry) => {
          if (!ACTOR_ROLES.includes(entry)) {
            fail(`actionPolicy.rules[${index}].match.actorRoles is invalid`);
          }
          return entry;
        },
      }),
    }),
    ...(value.urlPathGlobs === undefined ? {} : {
      urlPathGlobs: stringList(
        value.urlPathGlobs,
        `actionPolicy.rules[${index}].match.urlPathGlobs`,
        {
          maximum: MAX_GLOB_COUNT,
          normalize: (entry) => validateStructuredGlob(
            entry,
            `actionPolicy.rules[${index}].match.urlPathGlobs`,
            { pathKind: 'url' },
          ),
        },
      ),
    }),
    ...(filePaths === undefined ? {} : { filePaths }),
    ...(predicates === undefined ? {} : { argumentPredicates: predicates }),
  });
};

const normalizeRule = (value, index, matcherVersion) => {
  try {
    assertExactObject(value, {
      label: `actionPolicy.rules[${index}]`,
      required: ['id', 'effect', 'risk', 'match'],
      optional: ['retainEvidence', 'ttlSeconds', 'quota'],
    });
  } catch (error) {
    fail(error.message);
  }
  const ttlSeconds = value.ttlSeconds ?? DEFAULT_DECISION_TTL_SECONDS;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 30
    || ttlSeconds > MAX_DECISION_TTL_SECONDS) {
    fail(`actionPolicy.rules[${index}].ttlSeconds is invalid`);
  }
  if (value.retainEvidence !== undefined && typeof value.retainEvidence !== 'boolean') {
    fail(`actionPolicy.rules[${index}].retainEvidence is invalid`);
  }
  return Object.freeze({
    id: validateBoundedString(value.id, `actionPolicy.rules[${index}].id`, {
      maximum: 120,
      pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    }),
    effect: effect(value.effect, `actionPolicy.rules[${index}].effect`),
    risk: risk(value.risk, `actionPolicy.rules[${index}].risk`),
    match: normalizeMatch(value.match, index, matcherVersion),
    retainEvidence: value.retainEvidence === true,
    ttlSeconds,
    ...(value.quota === undefined ? {} : {
      quota: matcherVersion === 2
        ? normalizeQuota(value.quota, index)
        : fail(`actionPolicy.rules[${index}].quota requires matcherVersion 2`),
    }),
  });
};

export const validateBotActionPolicy = (value = {}) => {
  const policy = validateBoundedJsonObject(value, 'actionPolicy');
  try {
    assertExactObject(policy, {
      label: 'actionPolicy',
      required: [],
      optional: ['matcherVersion', 'defaultEffect', 'defaultRisk', 'rules'],
    });
  } catch (error) {
    fail(error.message);
  }
  const rules = policy.rules ?? [];
  if (!Array.isArray(rules) || rules.length > 256) fail('actionPolicy.rules is invalid');
  const matcherVersion = policy.matcherVersion ?? 1;
  if (!MATCHER_VERSIONS.includes(matcherVersion)) fail('actionPolicy.matcherVersion is invalid');
  const normalizedRules = rules.map((rule, index) => normalizeRule(rule, index, matcherVersion));
  if (new Set(normalizedRules.map((rule) => rule.id)).size !== normalizedRules.length) {
    fail('actionPolicy.rules contains duplicate IDs');
  }
  return Object.freeze({
    ...(Object.hasOwn(policy, 'matcherVersion') ? { matcherVersion } : {}),
    defaultEffect: effect(policy.defaultEffect ?? 'deny', 'actionPolicy.defaultEffect'),
    defaultRisk: risk(policy.defaultRisk ?? 'sensitive', 'actionPolicy.defaultRisk'),
    rules: Object.freeze(normalizedRules),
  });
};

export const validateBotBrowserPolicy = (value = {}) => {
  const policy = validateBoundedJsonObject(value, 'browserPolicy');
  try {
    assertExactObject(policy, {
      label: 'browserPolicy',
      required: [],
      optional: ['allowedOrigins', 'deniedOrigins', 'networkAccess'],
    });
  } catch (error) {
    fail(error.message);
  }
  let networkAccess;
  if (policy.networkAccess !== undefined) {
    try {
      assertExactObject(policy.networkAccess, {
        label: 'browserPolicy.networkAccess',
        required: ['mode', 'hosts'],
      });
    } catch (error) {
      fail(error.message);
    }
    if (!['public_only', 'allowlist'].includes(policy.networkAccess.mode)) {
      fail('browserPolicy.networkAccess.mode is invalid');
    }
    const hosts = stringList(policy.networkAccess.hosts, 'browserPolicy.networkAccess.hosts', {
      maximum: 64,
      normalize: (entry) => {
        const normalized = entry.trim().toLowerCase();
        if (normalized.includes('*') || normalized.includes('/') || normalized.includes('@')) {
          fail('browserPolicy.networkAccess.hosts contains an invalid host');
        }
        let url;
        try {
          url = new URL(`https://${normalized}`);
        } catch {
          fail('browserPolicy.networkAccess.hosts contains an invalid host');
        }
        if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
          || (url.port && (!Number.isInteger(Number(url.port)) || Number(url.port) < 1))) {
          fail('browserPolicy.networkAccess.hosts contains an invalid host');
        }
        return url.port ? `${url.hostname}:${url.port}` : url.hostname;
      },
    });
    if (policy.networkAccess.mode === 'public_only' && hosts.length > 0) {
      fail('browserPolicy.networkAccess.hosts must be empty in public-only mode');
    }
    if (policy.networkAccess.mode === 'allowlist' && hosts.length < 1) {
      fail('browserPolicy.networkAccess.hosts is required in allowlist mode');
    }
    networkAccess = Object.freeze({ mode: policy.networkAccess.mode, hosts });
  }
  return Object.freeze({
    allowedOrigins: stringList(policy.allowedOrigins ?? [], 'browserPolicy.allowedOrigins', {
      normalize: (entry) => normalizeOrigin(entry, 'browserPolicy.allowedOrigins'),
    }),
    deniedOrigins: stringList(policy.deniedOrigins ?? [], 'browserPolicy.deniedOrigins', {
      normalize: (entry) => normalizeOrigin(entry, 'browserPolicy.deniedOrigins'),
    }),
    // Omit the new field on legacy contracts so their canonical compiled hash
    // remains byte-for-byte stable. Runtime callers treat absence as
    // public_only.
    ...(networkAccess === undefined ? {} : { networkAccess }),
  });
};

export const effectiveBotBrowserNetworkPolicy = (browserPolicy = {}) => (
  validateBotBrowserPolicy(browserPolicy).networkAccess
  || Object.freeze({ mode: 'public_only', hosts: Object.freeze([]) })
);

const operationKindFor = (action) => {
  if (action.tool !== 'browser'
    && (action.target?.operationKind === 'read' || action.target?.operationKind === 'write')) {
    return action.target.operationKind;
  }
  return action.tool === 'browser' && BOT_BROWSER_READ_ACTIONS.includes(action.action)
    ? 'read'
    : 'write';
};

const targetOrigin = (action) => {
  const value = action.target?.origin;
  if (value === undefined || value === null || value === '') return null;
  return normalizeOrigin(value, 'action.target.origin');
};

const targetIntent = (target) => [
  target?.intent,
  target?.label,
  target?.name,
  target?.role,
  target?.control,
].filter((value) => typeof value === 'string').join(' ');

const normalizeUrlPathFact = (value) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 8_192
    || /[\\\u0000-\u001f\u007f]/u.test(value)) {
    fail('authoritative browser URL is invalid', 'bot_policy_facts_invalid', 409);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('authoritative browser URL is invalid', 'bot_policy_facts_invalid', 409);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.search || url.hash || /[\\\u0000-\u001f\u007f]/u.test(url.pathname)) {
    fail('authoritative browser URL is invalid', 'bot_policy_facts_invalid', 409);
  }
  const pathname = normalizePercentEscapes(url.pathname.normalize('NFC'));
  if (/%(?:2F|5C|0[0-9A-F]|1[0-9A-F]|7F)/u.test(pathname)) {
    fail('authoritative browser URL contains an encoded separator or control', 'bot_policy_facts_invalid', 409);
  }
  return pathname;
};

const normalizeVirtualPathFact = (value, index) => {
  const field = `policyFacts.filePaths[${index}]`;
  const normalized = validateBoundedString(value, field, { maximum: 2_048 }).normalize('NFC');
  if (!normalized.startsWith('/') || normalized.includes('\\') || normalized.includes('//')
    || normalized.includes('\0')
    || normalized.split('/').some((segment) => segment === '.' || segment === '..')
    || /^\/(?:Users|Volumes|private|home|root)(?:\/|$)/u.test(normalized)
    || normalized === '/var/run/docker.sock') {
    fail(`${field} is not a canonical virtual POSIX path`, 'bot_policy_facts_invalid', 409);
  }
  return normalized;
};

const pointerValue = (root, pointer) => {
  if (pointer === '') return { exists: true, value: root };
  let current = root;
  for (const rawToken of pointer.slice(1).split('/')) {
    const token = rawToken.replaceAll('~1', '/').replaceAll('~0', '~');
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, token)) {
      return { exists: false, value: undefined };
    }
    current = current[token];
  }
  return { exists: true, value: current };
};

const sameJson = (left, right) => {
  try {
    return hashCanonicalBotJson(left) === hashCanonicalBotJson(right);
  } catch {
    return false;
  }
};

const matchesArgumentPredicate = (predicate, args) => {
  const resolved = pointerValue(args, predicate.pointer);
  if (predicate.op === 'exists') return resolved.exists;
  if (!resolved.exists) return false;
  if (predicate.op === 'eq') return sameJson(resolved.value, predicate.value);
  if (predicate.op === 'in') return predicate.value.some((candidate) => sameJson(
    candidate,
    resolved.value,
  ));
  if (predicate.op === 'prefix') {
    return typeof resolved.value === 'string' && resolved.value.startsWith(predicate.value);
  }
  if (predicate.op === 'suffix') {
    return typeof resolved.value === 'string' && resolved.value.endsWith(predicate.value);
  }
  if (predicate.op === 'glob') {
    return typeof resolved.value === 'string'
      && matchesStructuredGlob(validateStructuredGlob(
        predicate.value,
        'argument predicate glob',
        { pathKind: predicate.value.startsWith('/') ? 'file' : 'value' },
      ), resolved.value);
  }
  if (predicate.op === 'gte') {
    return typeof resolved.value === 'number' && Number.isFinite(resolved.value)
      && resolved.value >= predicate.value;
  }
  if (predicate.op === 'lte') {
    return typeof resolved.value === 'number' && Number.isFinite(resolved.value)
      && resolved.value <= predicate.value;
  }
  return predicate.op === 'arrayContains' && Array.isArray(resolved.value)
    && resolved.value.some((candidate) => sameJson(candidate, predicate.value));
};

const normalizePolicyFacts = (action, facts = {}) => {
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) {
    fail('Bot policy facts are invalid', 'bot_policy_facts_invalid', 409);
  }
  const actorRole = facts.actorRole ?? null;
  if (actorRole !== null && !ACTOR_ROLES.includes(actorRole)) {
    fail('Bot policy actor role is invalid', 'bot_policy_facts_invalid', 409);
  }
  const candidateUrl = facts.authoritativeUrl
    ?? (action.tool === 'browser' && action.action === 'navigate'
      ? (action.target?.url || (action.target?.origin
        ? `${action.target.origin}${action.target.pathname || '/'}`
        : null))
      : null);
  const filePaths = facts.filePaths ?? [];
  if (!Array.isArray(filePaths) || filePaths.length > 128) {
    fail('Bot policy file facts are invalid', 'bot_policy_facts_invalid', 409);
  }
  const normalizedFiles = filePaths.map(normalizeVirtualPathFact);
  if (new Set(normalizedFiles).size !== normalizedFiles.length) {
    fail('Bot policy file facts contain duplicates', 'bot_policy_facts_invalid', 409);
  }
  return Object.freeze({
    actorRole,
    urlPath: normalizeUrlPathFact(candidateUrl),
    filePaths: Object.freeze(normalizedFiles),
    connectorSchemaValidated: facts.connectorSchemaValidated === true,
    arguments: structuredClone(action.args),
  });
};

const matchesRule = (rule, action, operationKind, origin, policyFacts) => (
  (rule.match.tool === undefined || rule.match.tool === action.tool)
  && (rule.match.actions === undefined || rule.match.actions.includes(action.action.toLowerCase()))
  && (rule.match.origins === undefined || (origin !== null && rule.match.origins.includes(origin)))
  && (rule.match.operationKinds === undefined || rule.match.operationKinds.includes(operationKind))
  && (rule.match.actorRoles === undefined
    || (policyFacts.actorRole !== null && rule.match.actorRoles.includes(policyFacts.actorRole)))
  && (rule.match.urlPathGlobs === undefined
    || (policyFacts.urlPath !== null
      && rule.match.urlPathGlobs.some((glob) => matchesStructuredGlob(glob, policyFacts.urlPath))))
  && (rule.match.filePaths === undefined
    || (policyFacts.filePaths.length > 0
      && (rule.match.filePaths.quantifier === 'any'
        ? policyFacts.filePaths.some((filePath) => rule.match.filePaths.globs.some(
            (glob) => matchesStructuredGlob(glob, filePath),
          ))
        : policyFacts.filePaths.every((filePath) => rule.match.filePaths.globs.some(
            (glob) => matchesStructuredGlob(glob, filePath),
          )))))
  && (rule.match.argumentPredicates === undefined
    || ((!/^connector[:.]/u.test(action.tool) || policyFacts.connectorSchemaValidated)
      && rule.match.argumentPredicates.every((predicate) => matchesArgumentPredicate(
        predicate,
        action.args,
      ))))
);

const builtInRules = (action, operationKind, origin, browserPolicy) => {
  const rules = [];
  const actionIdentity = `${action.tool}:${action.action} ${targetIntent(action.target)}`;
  if (DISTINCT_CRITICAL_ACTION.test(actionIdentity)
    || PRODUCTION_PUBLICATION.test(actionIdentity)) {
    rules.push({
      id: 'builtin.critical-distinct',
      effect: 'prompt',
      risk: 'critical',
      retainEvidence: false,
      ttlSeconds: DEFAULT_DECISION_TTL_SECONDS,
      requireDistinctApprover: false,
    });
  }
  if (action.tool !== 'browser') return rules;
  if (origin && browserPolicy.deniedOrigins.includes(origin)) {
    rules.push({
      id: 'builtin.browser-origin-denied',
      effect: 'deny',
      risk: 'critical',
      retainEvidence: false,
      ttlSeconds: DEFAULT_DECISION_TTL_SECONDS,
      requireDistinctApprover: false,
    });
  } else if (origin && browserPolicy.allowedOrigins.length > 0
    && !browserPolicy.allowedOrigins.includes(origin)) {
    rules.push({
      id: 'builtin.browser-origin-not-allowed',
      effect: 'deny',
      risk: 'critical',
      retainEvidence: false,
      ttlSeconds: DEFAULT_DECISION_TTL_SECONDS,
      requireDistinctApprover: false,
    });
  }
  if (operationKind === 'write' && (!origin || typeof action.target?.goal !== 'string'
    || action.target.goal.trim().length < 1)) {
    rules.push({
      id: 'builtin.browser-interaction-unbounded',
      effect: 'deny',
      risk: 'critical',
      retainEvidence: false,
      ttlSeconds: DEFAULT_DECISION_TTL_SECONDS,
      requireDistinctApprover: false,
    });
  }
  return rules;
};

export const classifyBotActionPolicy = ({
  action,
  actionPolicy = {},
  browserPolicy = {},
  facts = {},
} = {}) => {
  validateBotActionDescriptor(action);
  const normalizedActionPolicy = validateBotActionPolicy(actionPolicy);
  const normalizedBrowserPolicy = validateBotBrowserPolicy(browserPolicy);
  const matcherVersion = normalizedActionPolicy.matcherVersion ?? 1;
  const policyFacts = matcherVersion === 2
    ? normalizePolicyFacts(action, facts)
    : null;
  const operationKind = operationKindFor(action);
  const origin = targetOrigin(action);
  const matches = normalizedActionPolicy.rules
    .filter((rule) => matchesRule(
      rule,
      action,
      operationKind,
      origin,
      policyFacts || Object.freeze({
        actorRole: null,
        urlPath: null,
        filePaths: Object.freeze([]),
        connectorSchemaValidated: false,
      }),
    ))
    .map((rule) => ({ ...rule, requireDistinctApprover: false }));
  matches.push(...builtInRules(action, operationKind, origin, normalizedBrowserPolicy));
  if (matches.length === 0) {
    matches.push({
      id: 'default',
      effect: normalizedActionPolicy.defaultEffect,
      risk: normalizedActionPolicy.defaultRisk,
      retainEvidence: false,
      ttlSeconds: DEFAULT_DECISION_TTL_SECONDS,
      requireDistinctApprover: false,
    });
  }
  const selectedEffect = matches.reduce((current, rule) => (
    EFFECT_RANK[rule.effect] > EFFECT_RANK[current] ? rule.effect : current
  ), 'allow');
  const selected = matches.filter((rule) => rule.effect === selectedEffect);
  const selectedRisk = selected.reduce((current, rule) => (
    RISK_RANK[rule.risk] > RISK_RANK[current] ? rule.risk : current
  ), 'low');
  const classification = {
    effect: selectedEffect,
    risk: selectedRisk,
    approvalClass: resolveBotApprovalClass({ effect: selectedEffect, risk: selectedRisk }),
    operationKind,
    retainEvidence: operationKind === 'write' && selected.some((rule) => rule.retainEvidence),
    // Consequential actions ask the requester for a simple confirmation.
    // Persisted legacy rules may still carry a distinct-approver flag, but
    // newly compiled Bot policies no longer create a role-based approval gate.
    requireDistinctApprover: selected.some((rule) => rule.requireDistinctApprover),
    ttlSeconds: Math.min(...selected.map((rule) => rule.ttlSeconds)),
    ruleIds: Object.freeze(selected.map((rule) => rule.id).sort()),
  };
  if (matcherVersion === 2) {
    classification.matcherVersion = 2;
    classification.policyFacts = policyFacts;
    classification.policyFactsDigest = hashCanonicalBotJson(policyFacts);
    classification.quotaRules = Object.freeze(matches
      .filter((rule) => rule.quota)
      .map((rule) => Object.freeze({ ruleId: rule.id, ...rule.quota }))
      .sort((left, right) => left.ruleId.localeCompare(right.ruleId)));
  }
  return Object.freeze(classification);
};

export const bindBotActionPolicyDecision = ({ classification, action, now = Date.now } = {}) => {
  validateBotActionDescriptor(action);
  if (!classification || typeof classification !== 'object' || typeof now !== 'function') {
    fail('Bot policy decision binding is invalid');
  }
  const expiresAt = action.limits?.decisionExpiresAt;
  const timestamp = Date.parse(expiresAt);
  const current = Number(now());
  if (typeof expiresAt !== 'string' || !Number.isFinite(timestamp) || !Number.isFinite(current)
    || timestamp <= current
    || timestamp - current > classification.ttlSeconds * 1_000) {
    fail('Bot policy decision expiry is invalid', 'bot_policy_expiry_invalid', 409);
  }
  const actionHash = hashBotAction(action);
  const decision = {
    actionHash,
    effect: classification.effect,
    risk: classification.risk,
    approvalClass: classification.approvalClass,
    operationKind: classification.operationKind,
    retainEvidence: classification.retainEvidence,
    requireDistinctApprover: classification.requireDistinctApprover,
    ruleIds: Object.freeze([...classification.ruleIds]),
    expiresAt: new Date(timestamp).toISOString(),
    binding: Object.freeze({
      botId: action.botId,
      revisionId: action.revisionId,
      runId: action.runId,
      credentialScopeKey: action.credentialScopeKey,
      computerScopeKey: action.computerScopeKey,
      target: structuredClone(action.target),
      initiatorUserId: action.initiatorUserId,
      limits: structuredClone(action.limits),
      ...(classification.matcherVersion === 2 ? {
        matcherVersion: 2,
        policyFactsDigest: classification.policyFactsDigest,
        authoritativeActorRole: classification.policyFacts.actorRole,
        quotaBinding: structuredClone(classification.quotaBinding ?? {}),
      } : {}),
    }),
  };
  if (classification.matcherVersion === 2) {
    decision.matcherVersion = 2;
    decision.policyFactsDigest = classification.policyFactsDigest;
    decision.authoritativeActorRole = classification.policyFacts.actorRole;
    decision.quotaBinding = Object.freeze(structuredClone(classification.quotaBinding ?? {}));
  }
  return Object.freeze(decision);
};

export function createBotPolicyEngine({ now = Date.now } = {}) {
  if (typeof now !== 'function') throw new TypeError('Bot policy engine clock is invalid');
  return Object.freeze({
    classify: (input) => classifyBotActionPolicy(input),
    bind: (classification, action) => bindBotActionPolicyDecision({
      classification,
      action,
      now,
    }),
  });
}
