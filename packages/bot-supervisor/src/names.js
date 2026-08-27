import crypto from 'node:crypto';

export const BOT_RUNTIME_LABEL = 'production-bots';
export const BOT_RESOURCE_PREFIX = 'devryan-bot';

const KINDS = new Set(['reasoning', 'computer']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/;

export class BotResourceNameError extends Error {
  constructor(message, code = 'bot_supervisor_identity_invalid') {
    super(message);
    this.name = 'BotResourceNameError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new BotResourceNameError(message, code);
};

const assertExactKeys = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    fail('Bot resource identity shape is invalid');
  }
};

const validateIdentity = ({ deploymentId, botId, scopeKey, kind }) => {
  if (!ID_PATTERN.test(deploymentId) || !ID_PATTERN.test(botId)
    || !SCOPE_PATTERN.test(scopeKey) || !KINDS.has(kind)) {
    fail('Bot resource identity is invalid');
  }
};

const digestIdentity = ({ deploymentId, botId, scopeKey, kind }) => (
  crypto.createHash('sha256')
    .update(`${deploymentId}\0${botId}\0${kind}\0${scopeKey}`, 'utf8')
    .digest('hex')
);

const digestSharedIdentity = ({ deploymentId, botId }) => (
  crypto.createHash('sha256')
    .update(`${deploymentId}\0${botId}\0shared`, 'utf8')
    .digest('hex')
);

export function deriveBotSharedVolumeName(input) {
  assertExactKeys(input, ['deploymentId', 'botId']);
  if (!ID_PATTERN.test(input.deploymentId) || !ID_PATTERN.test(input.botId)) {
    fail('Bot shared volume identity is invalid');
  }
  return `${BOT_RESOURCE_PREFIX}-shared-${digestSharedIdentity(input).slice(0, 24)}`;
}

export function deriveBotResourceNames(input) {
  assertExactKeys(input, ['deploymentId', 'botId', 'scopeKey', 'kind']);
  validateIdentity(input);
  const digest = digestIdentity(input);
  const suffix = digest.slice(0, 24);
  const root = `${BOT_RESOURCE_PREFIX}-${input.kind}-${suffix}`;
  const volumes = input.kind === 'reasoning'
    ? {
        opencode: `${root}-opencode`,
        workspace: `${root}-workspace`,
        runtimeConfig: `${root}-runtime-config`,
        shared: deriveBotSharedVolumeName({ deploymentId: input.deploymentId, botId: input.botId }),
      }
    : {
        profile: `${root}-profile`,
        scratch: `${root}-scratch`,
        shared: deriveBotSharedVolumeName({ deploymentId: input.deploymentId, botId: input.botId }),
      };
  return Object.freeze({
    container: root,
    scopeDigest: `sha256:${digest}`,
    volumes: Object.freeze(volumes),
  });
}

export function buildBotSharedVolumeLabels(input) {
  assertExactKeys(input, ['deploymentId', 'botId']);
  if (!ID_PATTERN.test(input.deploymentId) || !ID_PATTERN.test(input.botId)) {
    fail('Bot shared volume identity is invalid');
  }
  return Object.freeze({
    'devryan.runtime': BOT_RUNTIME_LABEL,
    'devryan.deployment': input.deploymentId,
    'devryan.bot': input.botId,
    'devryan.scope': `sha256:${digestSharedIdentity(input)}`,
    'devryan.kind': 'shared',
    'devryan.volume-role': 'shared',
  });
}

export function buildBotOwnershipLabels(input) {
  assertExactKeys(input, ['deploymentId', 'botId', 'scopeKey', 'kind', 'imageIdentity']);
  const { imageIdentity, ...identity } = input;
  validateIdentity(identity);
  if (typeof imageIdentity !== 'string' || imageIdentity.length < 8 || imageIdentity.length > 512) {
    fail('Bot image identity is invalid');
  }
  const names = deriveBotResourceNames(identity);
  return Object.freeze({
    'devryan.runtime': BOT_RUNTIME_LABEL,
    'devryan.deployment': input.deploymentId,
    'devryan.bot': input.botId,
    'devryan.scope': names.scopeDigest,
    'devryan.kind': input.kind,
    'devryan.image': imageIdentity,
  });
}

export function buildBotVolumeLabels(input) {
  assertExactKeys(input, ['deploymentId', 'botId', 'scopeKey', 'kind', 'volumeRole']);
  const { volumeRole, ...identity } = input;
  validateIdentity(identity);
  if (typeof volumeRole !== 'string' || !/^[a-z][a-z-]{0,31}$/.test(volumeRole)) {
    fail('Bot volume role is invalid');
  }
  const names = deriveBotResourceNames(identity);
  return Object.freeze({
    'devryan.runtime': BOT_RUNTIME_LABEL,
    'devryan.deployment': input.deploymentId,
    'devryan.bot': input.botId,
    'devryan.scope': names.scopeDigest,
    'devryan.kind': input.kind,
    'devryan.volume-role': volumeRole,
  });
}
