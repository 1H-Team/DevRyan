import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  assertBotBoundaryObject,
  assertBotJsonValue,
  canonicalizeBotJson,
  hashCanonicalBotJson,
} from '@openchamber/bots-runtime';

import { validateBotActionPolicy, validateBotBrowserPolicy } from './policy-engine.js';
import { validateUuid } from './validation.js';

export const BOT_COMPILED_CONFIG_VERSION = 2;
export const BOT_REVISION_CONTRACT_VERSION = 3;
export const BOT_GATEWAY_PLUGIN_PATH = '/opt/devryan/devryan-bot-tools.mjs';
export const BOT_FILE_TOOLS = Object.freeze(['edit', 'glob', 'grep', 'read', 'write']);
export const BOT_RUNTIME_TOOLS = Object.freeze(['bash', 'git', 'task', 'terminal']);
// The gateway plugin version is a deployment fact, not a per-Bot setting. The
// server stamps this onto every contract it writes.
export const BOT_CURRENT_GATEWAY_PLUGIN_VERSION = 'devryan-bot-tools@1.3.0';

const REVIEWED_WORKSPACE_WRITE_PLUGIN_VERSIONS = new Set([
  'devryan-bot-tools@1.1.0',
  'devryan-bot-tools@1.2.0',
  BOT_CURRENT_GATEWAY_PLUGIN_VERSION,
]);

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+:/@-]{0,255}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_STANDING_ROLE_BYTES = 64 * 1024;
const MAX_INSTRUCTION_BYTES = 64 * 1024;
// A soul describes identity and voice. Guides converge on a short file, and a
// hard cap keeps it from becoming a second instruction dump.
const MAX_SOUL_BYTES = 16 * 1024;

export class BotConfigCompilerError extends Error {
  constructor(message, code = 'bot_revision_contract_invalid') {
    super(message);
    this.name = 'BotConfigCompilerError';
    this.code = code;
    this.statusCode = 400;
  }
}

const fail = (message, code) => {
  throw new BotConfigCompilerError(message, code);
};

const normalizeIdentifier = (value, field) => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!MODEL_ID_PATTERN.test(normalized)) fail(`${field} is invalid`);
  return normalized;
};

const normalizeModel = (value, field) => {
  try {
    assertBotBoundaryObject(value, {
      label: field,
      required: ['providerId', 'modelId', 'credentialId', 'egressHosts'],
      optional: ['variant'],
    });
  } catch (error) {
    fail(error.message);
  }
  if (!Array.isArray(value.egressHosts) || value.egressHosts.length < 1 || value.egressHosts.length > 32) {
    fail(`${field}.egressHosts is invalid`);
  }
  const egressHosts = value.egressHosts.map((host, index) => {
    const normalized = typeof host === 'string' ? host.trim().toLowerCase() : '';
    if (!normalized || normalized.length > 2_048 || /[\u0000-\u0020\u007f]/u.test(normalized)) {
      fail(`${field}.egressHosts[${index}] is invalid`);
    }
    return normalized;
  });
  if (new Set(egressHosts).size !== egressHosts.length) fail(`${field}.egressHosts contains duplicates`);
  return Object.freeze({
    providerId: normalizeIdentifier(value.providerId, `${field}.providerId`),
    modelId: normalizeIdentifier(value.modelId, `${field}.modelId`),
    credentialId: validateUuid(value.credentialId, `${field}.credentialId`),
    egressHosts: Object.freeze(egressHosts),
    ...(value.variant === undefined
      ? {}
      : { variant: normalizeIdentifier(value.variant, `${field}.variant`) }),
  });
};

const normalizeOptionalText = (value, field, maximumBytes = MAX_INSTRUCTION_BYTES) => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximumBytes) {
    fail(`${field} is invalid`);
  }
  return value.trim();
};

const normalizeObjectives = (value) => {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 32) fail('Bot revision objectives are invalid');
  const objectives = value.map((entry, index) => normalizeOptionalText(
    entry,
    `Bot revision objectives[${index}]`,
    2_048,
  )).filter(Boolean);
  if (objectives.length !== value.length) fail('Bot revision objectives are invalid');
  return Object.freeze(objectives);
};

const normalizeSkillBindings = (value) => {
  if (!Array.isArray(value) || value.length > 128) fail('Bot revision skill bindings are invalid');
  const bindings = value.map((binding, index) => {
    try {
      assertBotBoundaryObject(binding, {
        label: `Bot revision skill binding ${index}`,
        required: ['id', 'digest'],
      });
    } catch (error) {
      fail(error.message);
    }
    if (typeof binding.digest !== 'string' || !DIGEST_PATTERN.test(binding.digest)) {
      fail(`Bot revision skill binding ${index}.digest is invalid`);
    }
    return Object.freeze({
      id: validateUuid(binding.id, `skillBindings[${index}].id`),
      digest: binding.digest,
    });
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(bindings.map((binding) => binding.id)).size !== bindings.length) {
    fail('Bot revision skill bindings contain duplicates');
  }
  return Object.freeze(bindings);
};

const normalizeMcpBindings = (value) => {
  if (!Array.isArray(value) || value.length > 64) fail('Bot revision MCP bindings are invalid');
  const bindings = value.map((binding, index) => {
    try {
      assertBotBoundaryObject(binding, {
        label: `Bot revision MCP binding ${index}`,
        required: ['id', 'descriptorDigest', 'manifestDigest'],
      });
    } catch (error) {
      fail(error.message);
    }
    if (typeof binding.descriptorDigest !== 'string' || !DIGEST_PATTERN.test(binding.descriptorDigest)
      || typeof binding.manifestDigest !== 'string' || !DIGEST_PATTERN.test(binding.manifestDigest)) {
      fail(`Bot revision MCP binding ${index} digests are invalid`);
    }
    return Object.freeze({
      id: validateUuid(binding.id, `mcpBindings[${index}].id`),
      descriptorDigest: binding.descriptorDigest,
      manifestDigest: binding.manifestDigest,
    });
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(bindings.map((binding) => binding.id)).size !== bindings.length) {
    fail('Bot revision MCP bindings contain duplicates');
  }
  return Object.freeze(bindings);
};

const normalizeAgentBinding = (value) => {
  try {
    assertBotBoundaryObject(value, {
      label: 'Bot revision agent binding',
      required: ['kind'],
      optional: ['models', 'connectionRef', 'connectionDigest', 'modelHint'],
    });
  } catch (error) {
    fail(error.message);
  }
  if (value.kind === 'opencode') {
    if (!Object.hasOwn(value, 'models')
      || Object.hasOwn(value, 'connectionRef')
      || Object.hasOwn(value, 'connectionDigest')
      || Object.hasOwn(value, 'modelHint')) {
      fail('Bot OpenCode agent binding is invalid');
    }
    return Object.freeze({ kind: 'opencode', models: normalizeModelPolicy(value.models) });
  }
  if (value.kind !== 'ag_ui' || Object.hasOwn(value, 'models')
    || !Object.hasOwn(value, 'connectionRef')
    || !Object.hasOwn(value, 'connectionDigest')) {
    fail('Bot AG-UI agent binding is invalid');
  }
  if (typeof value.connectionDigest !== 'string' || !DIGEST_PATTERN.test(value.connectionDigest)) {
    fail('Bot AG-UI connection digest is invalid');
  }
  return Object.freeze({
    kind: 'ag_ui',
    connectionRef: validateUuid(value.connectionRef, 'agent.connectionRef'),
    connectionDigest: value.connectionDigest,
    ...(value.modelHint === undefined ? {} : {
      modelHint: normalizeIdentifier(value.modelHint, 'agent.modelHint'),
    }),
  });
};

const normalizeComputerPolicy = (value = {}) => {
  try {
    assertBotBoundaryObject(value, {
      label: 'Bot revision computer policy',
      required: [],
      optional: ['isolationTier'],
    });
  } catch (error) {
    fail(error.message);
  }
  const isolationTier = value.isolationTier ?? 'standard';
  if (!['standard', 'runsc'].includes(isolationTier)) {
    fail('Bot computer isolation tier is invalid');
  }
  return Object.freeze({ isolationTier });
};

const normalizeIdentity = (value) => {
  const identity = value ?? {};
  try {
    assertBotBoundaryObject(identity, {
      label: 'Bot revision identity',
      required: [],
      optional: ['title', 'avatar'],
    });
  } catch (error) {
    fail(error.message);
  }
  return Object.freeze({
    title: normalizeOptionalText(identity.title, 'Bot revision identity.title', 512),
    avatar: normalizeOptionalText(identity.avatar, 'Bot revision identity.avatar', 512),
  });
};

const normalizeContract = (contract) => {
  try {
    assertBotBoundaryObject(contract, {
      label: 'Bot revision contract',
      required: [
        'standingRole',
        'reasoning',
        'fileTools',
        'gatewayPluginVersion',
        'libraryVersionIds',
        'memoryPolicy',
      ],
      optional: [
        'actionPolicy',
        'browserPolicy',
        'identity',
        'objectives',
        'soul',
        'tone',
        'operatingInstructions',
        'prohibitedInstructions',
        'advancedPrompt',
        'tenancy',
        'runtimeTools',
        'skillBindings',
        'mcpBindings',
        'contractVersion',
        'agent',
        'computerPolicy',
        'models',
      ],
    });
  } catch (error) {
    fail(error.message);
  }

  const isV3 = Object.hasOwn(contract, 'contractVersion');
  if (isV3 && contract.contractVersion !== BOT_REVISION_CONTRACT_VERSION) {
    fail('Bot revision contractVersion is invalid');
  }
  if (isV3 !== Object.hasOwn(contract, 'agent')) {
    fail('Bot revision agent binding requires contractVersion 3');
  }
  if (!isV3 && !Object.hasOwn(contract, 'models')) {
    fail('Legacy Bot revision models are required');
  }
  if (isV3 && Object.hasOwn(contract, 'models')) {
    fail('Revision-v3 models must be inside the agent binding');
  }
  const agent = isV3 ? normalizeAgentBinding(contract.agent) : null;

  const standingRole = typeof contract.standingRole === 'string' ? contract.standingRole.trim() : '';
  if (!standingRole || Buffer.byteLength(standingRole, 'utf8') > MAX_STANDING_ROLE_BYTES) {
    fail('Bot revision standingRole is invalid');
  }
  if (!Array.isArray(contract.fileTools) || contract.fileTools.length > BOT_FILE_TOOLS.length) {
    fail('Bot revision file tool policy is invalid');
  }
  const fileTools = [...contract.fileTools].sort();
  if (new Set(fileTools).size !== fileTools.length
    || fileTools.some((tool) => !BOT_FILE_TOOLS.includes(tool))) {
    fail('Bot revision file tool policy is invalid');
  }
  let runtimeTools = null;
  if (Object.hasOwn(contract, 'runtimeTools')) {
    if (!Array.isArray(contract.runtimeTools) || contract.runtimeTools.length > BOT_RUNTIME_TOOLS.length) {
      fail('Bot revision runtime tool policy is invalid');
    }
    runtimeTools = [...contract.runtimeTools].sort();
    if (new Set(runtimeTools).size !== runtimeTools.length
      || runtimeTools.some((tool) => !BOT_RUNTIME_TOOLS.includes(tool))) {
      fail('Bot revision runtime tool policy is invalid');
    }
  }
  if (!Array.isArray(contract.libraryVersionIds) || contract.libraryVersionIds.length > 1_000) {
    fail('Bot revision Library versions are invalid');
  }
  const libraryVersionIds = contract.libraryVersionIds
    .map((id, index) => validateUuid(id, `libraryVersionIds[${index}]`))
    .sort();
  if (new Set(libraryVersionIds).size !== libraryVersionIds.length) {
    fail('Bot revision Library versions contain duplicates');
  }
  const gatewayPluginVersion = typeof contract.gatewayPluginVersion === 'string'
    ? contract.gatewayPluginVersion.trim()
    : '';
  if (!VERSION_PATTERN.test(gatewayPluginVersion)) fail('Bot gateway plugin version is invalid');
  try {
    assertBotJsonValue(contract.reasoning, 'Bot revision reasoning');
    assertBotJsonValue(contract.memoryPolicy, 'Bot revision memoryPolicy');
  } catch (error) {
    fail(error.message);
  }
  if (!contract.reasoning || Array.isArray(contract.reasoning)
    || !contract.memoryPolicy || Array.isArray(contract.memoryPolicy)) {
    fail('Bot revision reasoning and memory policy must be JSON objects');
  }
  // Tenancy is no longer a per-Bot choice. Contracts written before the
  // shared-computer migration may still say 'personalized'; they compile to the
  // same single team computer instead of failing.
  if (contract.tenancy !== undefined && !['team', 'personalized'].includes(contract.tenancy)) {
    fail('Bot revision tenancy is invalid');
  }
  const tenancy = 'team';

  const browserPolicy = validateBotBrowserPolicy(contract.browserPolicy ?? {});
  const actionPolicy = validateBotActionPolicy(contract.actionPolicy ?? {});
  if (actionPolicy.matcherVersion === 2 && !isV3) {
    fail('Structured matcher v2 requires revision contractVersion 3');
  }
  return Object.freeze({
    ...(isV3 ? {
      contractVersion: BOT_REVISION_CONTRACT_VERSION,
      agent,
      computerPolicy: normalizeComputerPolicy(contract.computerPolicy),
    } : {}),
    identity: normalizeIdentity(contract.identity),
    objectives: normalizeObjectives(contract.objectives),
    tone: normalizeOptionalText(contract.tone, 'Bot revision tone', 4_096),
    operatingInstructions: normalizeOptionalText(
      contract.operatingInstructions,
      'Bot revision operating instructions',
    ),
    prohibitedInstructions: normalizeOptionalText(
      contract.prohibitedInstructions,
      'Bot revision prohibited instructions',
    ),
    advancedPrompt: normalizeOptionalText(
      contract.advancedPrompt,
      'Bot revision advanced prompt',
    ),
    tenancy,
    standingRole,
    ...(!isV3 ? { models: normalizeModelPolicy(contract.models) } : {}),
    reasoning: structuredClone(contract.reasoning),
    fileTools: Object.freeze(fileTools),
    ...(runtimeTools === null ? {} : { runtimeTools: Object.freeze(runtimeTools) }),
    gatewayPluginVersion,
    libraryVersionIds: Object.freeze(libraryVersionIds),
    memoryPolicy: structuredClone(contract.memoryPolicy),
    actionPolicy,
    browserPolicy: isV3 && !browserPolicy.networkAccess
      ? Object.freeze({
          ...browserPolicy,
          networkAccess: Object.freeze({ mode: 'public_only', hosts: Object.freeze([]) }),
        })
      : browserPolicy,
    // Omitted entirely when unset so revisions written before souls existed
    // keep hashing to their stored compiled_hash.
    ...(Object.hasOwn(contract, 'soul')
      ? { soul: normalizeOptionalText(contract.soul, 'Bot revision soul', MAX_SOUL_BYTES) }
      : {}),
    ...(Object.hasOwn(contract, 'skillBindings')
      ? { skillBindings: normalizeSkillBindings(contract.skillBindings) }
      : {}),
    ...(Object.hasOwn(contract, 'mcpBindings')
      ? { mcpBindings: normalizeMcpBindings(contract.mcpBindings) }
      : {}),
  });
};

const normalizeModelPolicy = (models) => {
  try {
    assertBotBoundaryObject(models, {
      label: 'Bot revision models',
      required: ['primary', 'fallbacks'],
    });
  } catch (error) {
    fail(error.message);
  }
  if (!Array.isArray(models.fallbacks) || models.fallbacks.length > 8) {
    fail('Bot revision model fallbacks are invalid');
  }
  return Object.freeze({
    primary: normalizeModel(models.primary, 'Bot revision primary model'),
    fallbacks: Object.freeze(models.fallbacks.map((candidate, index) => (
      normalizeModel(candidate, `Bot revision fallback model ${index}`)
    ))),
  });
};

const SKILL_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_SKILL_FILE_BYTES = 256 * 1024;
const MAX_SKILL_PACKAGE_BYTES = 2 * 1024 * 1024;

const normalizeResolvedSkillPackages = (contract, packages) => {
  const bindings = contract.skillBindings ?? [];
  if (!Array.isArray(packages) || packages.length !== bindings.length) {
    fail('A pinned Bot skill package is unavailable', 'bot_skill_binding_unavailable');
  }
  const byId = new Map(packages.map((entry) => [entry?.id, entry]));
  const names = new Set();
  return Object.freeze(bindings.map((binding) => {
    const entry = byId.get(binding.id);
    if (!entry || entry.digest !== binding.digest || !SKILL_NAME_PATTERN.test(entry.name)
      || !Array.isArray(entry.files) || entry.files.length < 1 || entry.files.length > 128) {
      fail('A pinned Bot skill package failed integrity checks', 'bot_skill_binding_integrity_failed');
    }
    if (names.has(entry.name)) {
      fail('Pinned Bot skill names must be unique', 'bot_skill_binding_duplicate');
    }
    names.add(entry.name);
    const paths = new Set();
    let totalBytes = 0;
    const files = entry.files.map((file) => {
      const relativePath = typeof file?.path === 'string'
        ? path.posix.normalize(file.path.replaceAll('\\', '/'))
        : '';
      const content = typeof file?.content === 'string' ? file.content : null;
      const sha256 = typeof file?.sha256 === 'string' ? file.sha256 : '';
      const contentBytes = content === null ? 0 : Buffer.byteLength(content, 'utf8');
      totalBytes += contentBytes;
      if (!relativePath || relativePath === '.' || relativePath === '..'
        || relativePath.startsWith('../') || path.posix.isAbsolute(relativePath)
        || relativePath.split('/').some((segment) => !segment || segment === '..')
        || content === null || contentBytes > MAX_SKILL_FILE_BYTES
        || totalBytes > MAX_SKILL_PACKAGE_BYTES || !DIGEST_PATTERN.test(sha256)
        || crypto.createHash('sha256').update(content, 'utf8').digest('hex') !== sha256
        || paths.has(relativePath)) {
        fail('A pinned Bot skill package failed integrity checks', 'bot_skill_binding_integrity_failed');
      }
      paths.add(relativePath);
      return Object.freeze({ path: relativePath, content, sha256 });
    }).sort((left, right) => left.path.localeCompare(right.path));
    if (!paths.has('SKILL.md')) {
      fail('A pinned Bot skill package is missing SKILL.md', 'bot_skill_binding_integrity_failed');
    }
    return Object.freeze({ id: binding.id, name: entry.name, digest: binding.digest, files });
  }));
};

const buildOpenCodeConfig = (contract, skillNames = []) => {
  if (contract.agent?.kind === 'ag_ui') {
    // The compiler remains the single integrity boundary for every revision,
    // but AG-UI execution never launches this inert compatibility config.
    return {
      $schema: 'https://opencode.ai/config.json',
      default_agent: 'bot',
      plugin: [],
      mcp: {},
      agent: { bot: { disable: true } },
    };
  }
  const reviewedWorkspaceWrites = REVIEWED_WORKSPACE_WRITE_PLUGIN_VERSIONS.has(
    contract.gatewayPluginVersion,
  );
  const workspaceMutationEnabled = contract.fileTools.includes('write')
    || contract.fileTools.includes('edit');
  const autonomousRuntime = Object.hasOwn(contract, 'runtimeTools');
  const runtimeTools = contract.runtimeTools ?? [];
  const permissions = {
    '*': 'deny',
    devryan_bot: 'allow',
    devryan_image: 'allow',
    bash: runtimeTools.includes('bash') ? 'allow' : 'deny',
    terminal: runtimeTools.includes('terminal') ? 'allow' : 'deny',
    git: runtimeTools.includes('git') ? 'allow' : 'deny',
    task: runtimeTools.includes('task') ? 'allow' : 'deny',
    devryan_task: 'deny',
    browser: 'deny',
    devryan_browser: 'deny',
    mcp: 'deny',
    external_directory: 'deny',
    devryan_write: reviewedWorkspaceWrites && workspaceMutationEnabled ? 'allow' : 'deny',
  };
  for (const tool of BOT_FILE_TOOLS) {
    permissions[tool] = !autonomousRuntime && reviewedWorkspaceWrites && ['edit', 'write'].includes(tool)
      ? 'deny'
      : (contract.fileTools.includes(tool) ? 'allow' : 'deny');
  }
  const skillPermissions = { '*': 'deny' };
  for (const name of skillNames) skillPermissions[name] = 'allow';
  const primary = contract.agent?.kind === 'opencode'
    ? contract.agent.models.primary
    : contract.models.primary;
  // Identity anchors the prompt, so the soul leads and everything operational
  // follows it.
  const promptSections = [];
  if (contract.soul) promptSections.push(contract.soul);
  promptSections.push(contract.standingRole);
  if (contract.objectives.length > 0) {
    promptSections.push(`Objectives:\n${contract.objectives.map((item) => `- ${item}`).join('\n')}`);
  }
  // Voice moved into the soul. Legacy contracts that predate it still carry a
  // separate tone field.
  if (contract.tone && !contract.soul) promptSections.push(`Tone:\n${contract.tone}`);
  if (contract.operatingInstructions) {
    promptSections.push(`Operating instructions:\n${contract.operatingInstructions}`);
  }
  if (contract.prohibitedInstructions) {
    promptSections.push(`Prohibited behavior:\n${contract.prohibitedInstructions}`);
  }
  if (contract.advancedPrompt) promptSections.push(contract.advancedPrompt);
  if (!autonomousRuntime && reviewedWorkspaceWrites && workspaceMutationEnabled) {
    promptSections.push('Use devryan_write for every workspace file change. Workspace writes may pause until an authorized person approves the exact path and content.');
  }
  if (autonomousRuntime) {
    promptSections.push('Work autonomously inside the scoped Bot container and managed workspace. Files explicitly provided to this Bot live in /workspace/Resources; inspect them when relevant and treat those computer files as the source of truth. Never seek host files, Docker access, host credentials, raw browser/CDP, direct MCP, or DevRyan host-task orchestration. Use devryan_bot for governed browser and external actions. When devryan_image is available, call it with its exact prompt, out, and quality arguments, save out under /workspace/generated-images, and rely on automatic attachment; never guess an image.generate gateway payload, call artifact.put for the image, or promise a later Shared-folder publication. Use artifact.put to publish other generated files explicitly, and never scan or expose unrelated computer files.');
  }
  const assignedSkillPermission = Object.hasOwn(contract, 'skillBindings')
    ? { skill: skillPermissions }
    : {};
  const subagentPermissions = {
    ...permissions,
    task: 'deny',
    devryan_task: 'deny',
    devryan_bot: 'deny',
    devryan_image: 'deny',
    browser: 'deny',
    devryan_browser: 'deny',
    mcp: 'deny',
    external_directory: 'deny',
    ...assignedSkillPermission,
  };
  return {
    $schema: 'https://opencode.ai/config.json',
    default_agent: 'bot',
    plugin: [BOT_GATEWAY_PLUGIN_PATH],
    mcp: {},
    agent: {
      bot: {
        mode: 'primary',
        description: 'Scoped DevRyan Production Bot runtime',
        prompt: promptSections.join('\n\n'),
        model: `${primary.providerId}/${primary.modelId}`,
        ...(primary.variant ? { variant: primary.variant } : {}),
        permission: {
          ...permissions,
          ...assignedSkillPermission,
        },
      },
      ...(autonomousRuntime && runtimeTools.includes('task') ? {
        explore: {
          mode: 'subagent',
          description: 'Scoped Bot research subagent',
          permission: subagentPermissions,
        },
        general: {
          mode: 'subagent',
          description: 'Scoped Bot execution subagent',
          permission: subagentPermissions,
        },
      } : {
        explore: { disable: true },
        general: { disable: true },
      }),
    },
  };
};

const writePrivateFile = async (filePath, value, fsPromises) => {
  const handle = await fsPromises.open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(value, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const collectRelativeFiles = async (root, fsPromises, prefix = '') => {
  const files = [];
  for (const entry of await fsPromises.readdir(root, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await collectRelativeFiles(path.join(root, entry.name), fsPromises, relativePath));
    } else {
      files.push(relativePath);
    }
  }
  return files.sort();
};

const SOUL_FILE_NAME = 'soul.md';

// The soul is already inside revision.json; it is also written as a plain file
// so the running container can read its own identity the way every SOUL.md
// convention expects.
const verifyExistingSoul = async ({ directory, expectedSoul, fsPromises }) => {
  const soulPath = path.join(directory, SOUL_FILE_NAME);
  let stat = null;
  try {
    stat = await fsPromises.lstat(soulPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (expectedSoul === null) return;
    fail('Compiled Bot soul file is missing', 'bot_compiled_config_conflict');
  }
  if (expectedSoul === null) {
    fail('Compiled Bot revision directory contains an unexpected soul file', 'bot_compiled_config_conflict');
  }
  const content = await fsPromises.readFile(soulPath, 'utf8');
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o277) !== 0
    || content !== expectedSoul) {
    fail('Compiled Bot soul file does not match its revision', 'bot_compiled_config_conflict');
  }
};

const verifyExistingSkills = async ({ directory, packages, fsPromises }) => {
  const skillsRoot = path.join(directory, 'skills');
  const expected = new Map();
  for (const skill of packages) {
    for (const file of skill.files) expected.set(`${skill.name}/${file.path}`, file);
  }
  const skillsStat = await fsPromises.lstat(skillsRoot);
  if (!skillsStat.isDirectory() || skillsStat.isSymbolicLink() || (skillsStat.mode & 0o277) !== 0) {
    fail('Compiled Bot skill directory is invalid', 'bot_compiled_config_conflict');
  }
  const actualPaths = await collectRelativeFiles(skillsRoot, fsPromises);
  if (actualPaths.join('\0') !== [...expected.keys()].sort().join('\0')) {
    fail('Compiled Bot skill directory does not match its manifest', 'bot_compiled_config_conflict');
  }
  await Promise.all(actualPaths.map(async (relativePath) => {
    const filePath = path.join(skillsRoot, ...relativePath.split('/'));
    const [stat, content] = await Promise.all([
      fsPromises.lstat(filePath),
      fsPromises.readFile(filePath, 'utf8'),
    ]);
    const expectedFile = expected.get(relativePath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o277) !== 0
      || crypto.createHash('sha256').update(content, 'utf8').digest('hex') !== expectedFile.sha256) {
      fail('Compiled Bot skill file failed integrity checks', 'bot_compiled_config_conflict');
    }
  }));
};

const removePrivateTree = async (directory, fsPromises) => {
  try {
    const stat = await fsPromises.lstat(directory);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      await fsPromises.chmod(directory, 0o700);
      for (const entry of await fsPromises.readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          await removePrivateTree(path.join(directory, entry.name), fsPromises);
        }
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await fsPromises.rm(directory, { recursive: true, force: true });
};

const materializeCompiledDirectory = async ({
  temporaryDirectory,
  manifest,
  openCodeConfig,
  soulFile,
  skillPackages,
  fsPromises,
}) => {
  await fsPromises.mkdir(temporaryDirectory, { mode: 0o700 });
  await writePrivateFile(
    path.join(temporaryDirectory, 'revision.json'),
    `${canonicalizeBotJson(manifest)}\n`,
    fsPromises,
  );
  await writePrivateFile(
    path.join(temporaryDirectory, 'opencode.json'),
    openCodeConfig,
    fsPromises,
  );
  if (soulFile !== null) {
    await writePrivateFile(
      path.join(temporaryDirectory, SOUL_FILE_NAME),
      soulFile,
      fsPromises,
    );
  }

  const skillsDirectory = path.join(temporaryDirectory, 'skills');
  await fsPromises.mkdir(skillsDirectory, { mode: 0o700 });
  if (skillPackages !== null) {
    for (const skill of skillPackages) {
      const skillDirectory = path.join(skillsDirectory, skill.name);
      await fsPromises.mkdir(skillDirectory, { mode: 0o700 });
      for (const file of skill.files) {
        const targetPath = path.join(skillDirectory, ...file.path.split('/'));
        const targetParent = path.dirname(targetPath);
        await fsPromises.mkdir(targetParent, { recursive: true, mode: 0o700 });
        await writePrivateFile(targetPath, file.content, fsPromises);
        await fsPromises.chmod(targetPath, 0o400);
      }
    }
  }
  const directories = [];
  const collectDirectories = async (root) => {
    directories.push(root);
    for (const entry of await fsPromises.readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory()) await collectDirectories(path.join(root, entry.name));
    }
  };
  await collectDirectories(skillsDirectory);
  for (const skillDirectory of directories.reverse()) {
    await fsPromises.chmod(skillDirectory, 0o500);
  }

  await fsPromises.chmod(path.join(temporaryDirectory, 'revision.json'), 0o400);
  await fsPromises.chmod(path.join(temporaryDirectory, 'opencode.json'), 0o400);
  if (soulFile !== null) {
    await fsPromises.chmod(path.join(temporaryDirectory, SOUL_FILE_NAME), 0o400);
  }
  await fsPromises.chmod(temporaryDirectory, 0o500);
};

const verifyExisting = async ({
  directory,
  expectedManifest,
  expectedConfig,
  expectedSoul,
  expectedSkills,
  fsPromises,
}) => {
  try {
    const revisionPath = path.join(directory, 'revision.json');
    const configPath = path.join(directory, 'opencode.json');
    const [directoryStat, revisionStat, configStat, rawRevision, rawConfig, rootEntries] = await Promise.all([
      fsPromises.lstat(directory),
      fsPromises.lstat(revisionPath),
      fsPromises.lstat(configPath),
      fsPromises.readFile(revisionPath, 'utf8'),
      fsPromises.readFile(configPath, 'utf8'),
      fsPromises.readdir(directory),
    ]);
    const expectedRootEntries = [
      'opencode.json',
      'revision.json',
      'skills',
      ...(expectedSoul === null ? [] : [SOUL_FILE_NAME]),
    ].sort();
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
      || !revisionStat.isFile() || revisionStat.isSymbolicLink()
      || !configStat.isFile() || configStat.isSymbolicLink()
      || (directoryStat.mode & 0o277) !== 0
      || (revisionStat.mode & 0o277) !== 0
      || (configStat.mode & 0o277) !== 0
      || rawRevision !== `${canonicalizeBotJson(expectedManifest)}\n`
      || rawConfig !== expectedConfig
      || rootEntries.sort().join('\0') !== expectedRootEntries.join('\0')) {
      fail('Compiled Bot revision directory does not match its hash', 'bot_compiled_config_conflict');
    }
    await verifyExistingSoul({ directory, expectedSoul, fsPromises });
    await verifyExistingSkills({ directory, packages: expectedSkills, fsPromises });
    return true;
  } catch (error) {
    if (error instanceof BotConfigCompilerError) throw error;
    if (error?.code === 'ENOENT') return false;
    fail('Compiled Bot revision directory is unreadable', 'bot_compiled_config_invalid');
  }
};

export function createBotConfigCompiler({
  dataDirectory,
  fsPromises = fs,
  randomBytes = crypto.randomBytes,
  resolveSkillPackages = async () => [],
  recordDiagnostic = () => {},
} = {}) {
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)) {
    fail('Bot config compiler requires an absolute data directory', 'bot_compiler_configuration_invalid');
  }
  if (typeof resolveSkillPackages !== 'function' || typeof recordDiagnostic !== 'function') {
    fail('Bot skill package resolver is invalid', 'bot_compiler_configuration_invalid');
  }
  const runtimeRoot = path.join(dataDirectory, 'bots', 'runtime');
  const compilations = new Map();

  const markRepair = (event, { channelId, revisionId, compiledHash, code = null }) => {
    try {
      recordDiagnostic({
        type: 'lifecycle',
        event: `bot.compiled_config_repair.${event}`,
        payload: {
          channelId,
          revisionId,
          hash: compiledHash,
          ...(code ? { code } : {}),
        },
      });
    } catch {
      // Diagnostics must never make an otherwise valid runtime unavailable.
    }
  };

  return Object.freeze({
    runtimeRoot,
    async compile({ channelId, revisionId, contract } = {}) {
      const normalizedChannelId = validateUuid(channelId, 'channelId');
      const normalizedRevisionId = validateUuid(revisionId, 'revisionId');
      const normalizedContract = normalizeContract(contract);
      const hasSkillBindings = Object.hasOwn(normalizedContract, 'skillBindings');
      const skillPackages = hasSkillBindings
        ? normalizeResolvedSkillPackages(
          normalizedContract,
          await resolveSkillPackages({
            revisionId: normalizedRevisionId,
            bindings: normalizedContract.skillBindings,
          }),
        )
        : null;
      const compiledHash = hashCanonicalBotJson(normalizedContract);
      const directory = path.join(
        runtimeRoot,
        'channels',
        normalizedChannelId,
        normalizedRevisionId,
        compiledHash,
      );
      const manifest = Object.freeze({
        version: Object.hasOwn(normalizedContract, 'runtimeTools')
          ? BOT_COMPILED_CONFIG_VERSION
          : 1,
        revisionId: normalizedRevisionId,
        compiledHash,
        contract: normalizedContract,
        ...(hasSkillBindings ? {
          skills: Object.freeze(skillPackages.map((entry) => Object.freeze({
            id: entry.id,
            name: entry.name,
            digest: entry.digest,
            files: Object.freeze(entry.files.map((file) => Object.freeze({
              path: file.path,
              sha256: file.sha256,
            }))),
          }))),
        } : {}),
      });
      const openCodeConfig = `${JSON.stringify(buildOpenCodeConfig(
        normalizedContract,
        skillPackages?.map((entry) => entry.name) ?? [],
      ), null, 2)}\n`;
      const soulFile = normalizedContract.soul ? `${normalizedContract.soul}\n` : null;
      const result = Object.freeze({ directory, compiledHash, contract: normalizedContract });
      const current = compilations.get(directory);
      if (current) return current;

      const compilation = (async () => {
        let repairCode = null;
        try {
          if (await verifyExisting({
            directory,
            expectedManifest: manifest,
            expectedConfig: openCodeConfig,
            expectedSoul: soulFile,
            expectedSkills: skillPackages ?? [],
            fsPromises,
          })) return result;
        } catch (error) {
          if (!(error instanceof BotConfigCompilerError)
            || !['bot_compiled_config_conflict', 'bot_compiled_config_invalid'].includes(error.code)) {
            throw error;
          }
          repairCode = error.code;
          markRepair('detected', {
            channelId: normalizedChannelId,
            revisionId: normalizedRevisionId,
            compiledHash,
            code: repairCode,
          });
        }

        const parent = path.dirname(directory);
        await fsPromises.mkdir(parent, { recursive: true, mode: 0o700 });
        await fsPromises.chmod(parent, 0o700);
        const nonce = Buffer.from(randomBytes(12)).toString('hex');
        const temporaryDirectory = path.join(parent, `.compile-${process.pid}-${nonce}`);
        const quarantineDirectory = path.join(parent, `.quarantine-${process.pid}-${nonce}`);
        let quarantined = false;
        let replacementInstalled = false;
        try {
          await materializeCompiledDirectory({
            temporaryDirectory,
            manifest,
            openCodeConfig,
            soulFile,
            skillPackages,
            fsPromises,
          });
          if (!await verifyExisting({
            directory: temporaryDirectory,
            expectedManifest: manifest,
            expectedConfig: openCodeConfig,
            expectedSoul: soulFile,
            expectedSkills: skillPackages ?? [],
            fsPromises,
          })) {
            fail('Compiled Bot replacement could not be verified', 'bot_compiled_config_invalid');
          }

          if (repairCode) {
            await fsPromises.rename(directory, quarantineDirectory);
            quarantined = true;
          }
          try {
            await fsPromises.rename(temporaryDirectory, directory);
            replacementInstalled = true;
          } catch (error) {
            if (!repairCode && ['EEXIST', 'ENOTEMPTY'].includes(error?.code)) {
              await removePrivateTree(temporaryDirectory, fsPromises);
            } else {
              throw error;
            }
          }
          if (!await verifyExisting({
            directory,
            expectedManifest: manifest,
            expectedConfig: openCodeConfig,
            expectedSoul: soulFile,
            expectedSkills: skillPackages ?? [],
            fsPromises,
          })) {
            fail('Compiled Bot revision directory could not be committed', 'bot_compiled_config_conflict');
          }
          if (quarantined) {
            await removePrivateTree(quarantineDirectory, fsPromises).catch(() => undefined);
            quarantined = false;
            markRepair('completed', {
              channelId: normalizedChannelId,
              revisionId: normalizedRevisionId,
              compiledHash,
              code: repairCode,
            });
          }
          return result;
        } catch (error) {
          await removePrivateTree(temporaryDirectory, fsPromises).catch(() => undefined);
          if (quarantined) {
            try {
              if (replacementInstalled) await removePrivateTree(directory, fsPromises);
              await fsPromises.rename(quarantineDirectory, directory);
              quarantined = false;
            } catch {
              // Keep the quarantined tree intact when rollback cannot safely restore it.
            }
          }
          if (repairCode) {
            markRepair('failed', {
              channelId: normalizedChannelId,
              revisionId: normalizedRevisionId,
              compiledHash,
              code: typeof error?.code === 'string' ? error.code : 'bot_compiled_config_repair_failed',
            });
            if (!(error instanceof BotConfigCompilerError)) {
              fail('Compiled Bot revision directory could not be repaired', 'bot_compiled_config_invalid');
            }
          }
          throw error;
        }
      })();
      compilations.set(directory, compilation);
      try {
        return await compilation;
      } finally {
        if (compilations.get(directory) === compilation) compilations.delete(directory);
      }
    },
  });
}

export { normalizeContract as validateBotRevisionRuntimeContract };
export { normalizeModelPolicy as validateBotModelPolicy };
