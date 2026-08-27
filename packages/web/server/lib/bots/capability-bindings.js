import crypto, { randomUUID } from 'node:crypto';
import path from 'node:path';

import { hashCanonicalBotJson } from '@openchamber/bots-runtime';

import { validateBotRevisionRuntimeContract } from './config-compiler.js';
import {
  digestBotMcpDescriptor,
  normalizeBotMcpCandidate,
} from './mcp-connector.js';
import { wipeBotSourceScan } from './source-scanner.js';
import {
  assertExactObject,
  validateBoundedString,
  validateUuid,
} from './validation.js';

const SKILL_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;
const PACKAGE_FORMAT = 'DevRyan.BotSkillPackage';
const PACKAGE_VERSION = 1;
const MAX_SKILL_FILES = 128;
const MAX_SKILL_FILE_BYTES = 256 * 1024;
const MAX_SKILL_PACKAGE_BYTES = 2 * 1024 * 1024;

export class BotCapabilityBindingsError extends Error {
  constructor(message, code = 'bot_capability_binding_invalid', statusCode = 400, details = null) {
    super(message);
    this.name = 'BotCapabilityBindingsError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

const fail = (message, code, statusCode, details = null) => {
  throw new BotCapabilityBindingsError(message, code, statusCode, details);
};

const normalizeExpectedUpdatedAt = (value) => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    fail('expectedUpdatedAt is required', 'bot_revision_required', 400);
  }
  return value;
};

const normalizeDirectory = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 4_096
    || value.includes('\0')) {
    fail('Skill discovery directory is invalid');
  }
  return path.normalize(value);
};

const publicRevision = (row, includeContract = true) => Object.freeze({
  id: row.id,
  botId: row.bot_id,
  revisionNumber: Number(row.revision_number),
  compiledHash: row.compiled_hash,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  activatedAt: row.activated_at || null,
  retiredAt: row.retired_at || null,
  ...(includeContract ? { contract: structuredClone(row.contract) } : {}),
});

const publicBot = (row) => Object.freeze({
  id: row.id,
  name: row.name,
  lifecycle: row.lifecycle,
  tenancy: row.tenancy,
  activeRevisionId: row.active_revision_id || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  retiredAt: row.retired_at || null,
});

const safeFinding = (finding) => ({
  code: finding.code,
  relativePath: finding.relativePath,
  message: finding.message,
  severity: finding.severity,
});

const packageFromScan = (skillName, scan) => {
  if (!scan.files.some((file) => file.relativePath === 'SKILL.md')) {
    fail('A Bot skill package must contain SKILL.md', 'bot_skill_manifest_missing', 400);
  }
  if (scan.findings.length > 0) {
    fail(
      'The skill contains files that cannot be assigned to a Bot',
      'bot_skill_package_unsafe',
      400,
      { findings: scan.findings.slice(0, 20).map(safeFinding) },
    );
  }
  if (scan.files.length > MAX_SKILL_FILES
    || scan.files.some((file) => file.size > MAX_SKILL_FILE_BYTES)) {
    fail('The skill package is too large', 'bot_skill_package_too_large', 413);
  }
  const files = scan.files.map((file) => Object.freeze({
    path: file.relativePath,
    content: file.text,
    sha256: file.sha256,
    size: file.size,
  })).sort((left, right) => left.path.localeCompare(right.path));
  const value = Object.freeze({
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    name: skillName,
    files,
  });
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  if (bytes.byteLength > MAX_SKILL_PACKAGE_BYTES) {
    bytes.fill(0);
    fail('The skill package is too large', 'bot_skill_package_too_large', 413);
  }
  return { value, bytes, digest: hashCanonicalBotJson(value) };
};

const parsePackage = (bytes, expected) => {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength > MAX_SKILL_PACKAGE_BYTES) {
    fail('The encrypted skill package is too large', 'bot_skill_package_too_large', 413);
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('The encrypted skill package is invalid', 'bot_skill_binding_integrity_failed', 502);
  }
  if (!parsed || parsed.format !== PACKAGE_FORMAT || parsed.version !== PACKAGE_VERSION
    || parsed.name !== expected.skill_name || !SKILL_NAME_PATTERN.test(parsed.name)
    || !Array.isArray(parsed.files) || parsed.files.length < 1 || parsed.files.length > MAX_SKILL_FILES
    || hashCanonicalBotJson(parsed) !== expected.package_digest) {
    fail('The encrypted skill package failed integrity checks', 'bot_skill_binding_integrity_failed', 502);
  }
  const paths = new Set();
  let totalBytes = 0;
  const files = parsed.files.map((file) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)
      || Object.keys(file).sort().join('\0') !== ['content', 'path', 'sha256', 'size'].join('\0')
      || typeof file.path !== 'string' || typeof file.content !== 'string'
      || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)
      || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_SKILL_FILE_BYTES) {
      fail('The encrypted skill package failed integrity checks', 'bot_skill_binding_integrity_failed', 502);
    }
    const relativePath = path.posix.normalize(file.path.replaceAll('\\', '/'));
    const contentBytes = Buffer.byteLength(file.content, 'utf8');
    totalBytes += contentBytes;
    if (!relativePath || relativePath === '.' || relativePath === '..'
      || relativePath.startsWith('../') || path.posix.isAbsolute(relativePath)
      || relativePath.split('/').some((segment) => !segment || segment === '..')
      || paths.has(relativePath) || contentBytes !== file.size
      || crypto.createHash('sha256').update(file.content, 'utf8').digest('hex') !== file.sha256
      || totalBytes > MAX_SKILL_PACKAGE_BYTES) {
      fail('The encrypted skill package failed integrity checks', 'bot_skill_binding_integrity_failed', 502);
    }
    paths.add(relativePath);
    return Object.freeze({
      path: relativePath,
      content: file.content,
      sha256: file.sha256,
    });
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (!paths.has('SKILL.md')) {
    fail('The encrypted skill package is missing SKILL.md', 'bot_skill_binding_integrity_failed', 502);
  }
  return Object.freeze({
    id: expected.id,
    name: parsed.name,
    digest: expected.package_digest,
    files: Object.freeze(files),
  });
};

export function createBotCapabilityBindings({
  store,
  authorization,
  blobStore,
  encryption,
  scanner,
  discoverSkills,
  listMcpConfigs,
  resolveMcpOAuthCredential = () => null,
  resolveDirectory,
  mcpHost,
  getCredentialVault = () => null,
  compileRevision = async () => null,
  audit = async () => {},
  uuid = randomUUID,
} = {}) {
  if (!store?.repositories?.bot_skill_packages || !store?.repositories?.bot_mcp_bindings
    || !store?.repositories?.bot_revisions || !store?.repositories?.bot_credentials
    || !authorization || typeof authorization.requireManager !== 'function'
    || typeof authorization.requireActiveMembership !== 'function'
    || !blobStore || typeof blobStore.createLibraryObject !== 'function'
    || typeof blobStore.downloadAuthorized !== 'function'
    || !scanner || typeof scanner.scan !== 'function'
    || typeof discoverSkills !== 'function' || typeof listMcpConfigs !== 'function'
    || typeof resolveMcpOAuthCredential !== 'function'
    || typeof resolveDirectory !== 'function' || !mcpHost || typeof mcpHost.preflight !== 'function'
    || typeof mcpHost.describeBinding !== 'function'
    || typeof getCredentialVault !== 'function' || typeof compileRevision !== 'function'
    || typeof audit !== 'function' || typeof uuid !== 'function') {
    throw new TypeError('Bot capability bindings service is misconfigured');
  }

  const listRows = async (repository, filters) => (
    await repository.list({ filters, limit: 100 })
  ).items;

  const resolveCapabilityDirectory = async (principal, value) => {
    const requested = normalizeDirectory(value);
    if (!requested) return undefined;
    const resolved = await resolveDirectory(principal, requested);
    if (!resolved) {
      fail(
        'The selected project is not assigned to this user',
        'bot_capability_directory_forbidden',
        403,
      );
    }
    return normalizeDirectory(resolved);
  };

  const normalizeConfiguredMcpCandidate = (configured, { includeCredentials = true } = {}) => {
    if (configured.enabled === false) {
      fail('The configured MCP Server is disabled', 'bot_mcp_server_disabled', 409);
    }
    if (configured.type === 'local') {
      return normalizeBotMcpCandidate({
        name: configured.name,
        type: 'local',
        command: configured.command,
        environment: configured.environment,
      });
    }
    const configuredHeaders = configured.headers && typeof configured.headers === 'object'
      ? configured.headers
      : {};
    const hasAuthorizationHeader = Object.keys(configuredHeaders)
      .some((name) => name.toLowerCase() === 'authorization');
    const oauthCredential = !includeCredentials || configured.oauth === false || hasAuthorizationHeader
      ? null
      : resolveMcpOAuthCredential(configured.name, configured.url);
    if (oauthCredential?.expired === true) {
      fail(
        'Re-authenticate this MCP Server in Coding Agents before assigning it to a Bot',
        'bot_mcp_oauth_expired',
        409,
      );
    }
    return normalizeBotMcpCandidate({
      name: configured.name,
      type: 'remote',
      url: configured.url,
      headers: oauthCredential?.authorization
        ? { ...configuredHeaders, Authorization: oauthCredential.authorization }
        : configuredHeaders,
      timeout: configured.timeout,
    });
  };

  const preflightMcpCandidate = async (candidate) => {
    try {
      return await mcpHost.preflight({ descriptor: candidate.descriptor, secret: candidate.secret });
    } catch (error) {
      if (error instanceof BotCapabilityBindingsError) throw error;
      if (typeof error?.code === 'string' && error.code.startsWith('bot_mcp_')
        && Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 500) {
        throw error;
      }
      fail(
        'Could not connect to this MCP Server. Check that it is connected in Coding Agents, then try again',
        'bot_mcp_preflight_failed',
        409,
      );
    }
  };

  const configuredMcpCandidate = (serverName, directory) => {
    const name = validateBoundedString(serverName, 'serverName', { maximum: 120 });
    const configured = listMcpConfigs(directory).find((server) => server.name === name);
    if (!configured) fail('Configured MCP Server not found', 'bot_mcp_server_not_found', 404);
    return normalizeConfiguredMcpCandidate(configured);
  };

  const availableSkillSummaries = (directory) => {
    const byName = new Map();
    for (const skill of discoverSkills(directory)) {
      if (!skill || typeof skill.name !== 'string' || !SKILL_NAME_PATTERN.test(skill.name)
        || byName.has(skill.name) || !skill.path
        || path.basename(skill.path).toLowerCase() !== 'skill.md') continue;
      const description = typeof skill.description === 'string'
        ? skill.description.replace(/[\u0000\r\n]+/gu, ' ').trim().slice(0, 240)
        : '';
      const scope = typeof skill.scope === 'string'
        ? skill.scope.replace(/[\u0000\r\n]+/gu, ' ').trim().slice(0, 40)
        : 'installed';
      byName.set(skill.name, Object.freeze({ name: skill.name, description, scope }));
    }
    return Object.freeze([...byName.values()].sort((left, right) => left.name.localeCompare(right.name)));
  };

  const readDecision = async (principal, botId) => {
    if (!principal?.id) fail('Authentication required', 'bot_authentication_required', 401);
    const id = validateUuid(botId, 'botId');
    const bot = await store.repositories.bots.get({ id });
    if (!bot) fail('Bot not found', 'bot_not_found', 404);
    try {
      await authorization.requireManager(principal, id);
      return { bot, canManage: true };
    } catch (managerError) {
      await authorization.requireActiveMembership(principal, id).catch(() => { throw managerError; });
      return { bot, canManage: false };
    }
  };

  const requireDraft = async (principal, botId, revisionId, expectedUpdatedAt) => {
    const decision = await readDecision(principal, botId);
    if (!decision.canManage) fail('A Bot Manager is required', 'bot_manager_required', 403);
    const revision = await store.repositories.bot_revisions.get({
      id: validateUuid(revisionId, 'revisionId'),
      bot_id: decision.bot.id,
    });
    if (!revision) fail('Bot revision not found', 'bot_revision_not_found', 404);
    if (revision.activated_at !== null) {
      fail('Active Bot revisions are read only', 'bot_revision_active', 409);
    }
    return { ...decision, revision, expectedUpdatedAt: normalizeExpectedUpdatedAt(expectedUpdatedAt) };
  };

  const updateContract = async (context, contract) => {
    const normalized = validateBotRevisionRuntimeContract(contract);
    return store.repositories.bot_revisions.updateIfRevision(
      { id: context.revision.id, bot_id: context.bot.id },
      { contract: normalized, compiled_hash: hashCanonicalBotJson(normalized) },
      context.expectedUpdatedAt,
    );
  };

  const withKey = async (operation) => {
    if (typeof encryption?.getKey !== 'function') {
      fail('Bot encryption key is unavailable', 'bot_os_encryption_unavailable', 503);
    }
    const supplied = await encryption.getKey();
    const key = Buffer.from(supplied || []);
    try {
      if (key.byteLength !== 32) fail('Bot encryption key is unavailable', 'bot_os_encryption_unavailable', 503);
      return await operation(key);
    } finally {
      key.fill(0);
      if (Buffer.isBuffer(supplied) || supplied instanceof Uint8Array) supplied.fill(0);
    }
  };

  const cleanupAttempt = async (failures, step, operation) => {
    try {
      await operation();
    } catch (error) {
      failures.push(Object.freeze({
        step,
        code: typeof error?.code === 'string' ? error.code.slice(0, 120) : 'cleanup_failed',
      }));
    }
  };

  const rethrowAfterCleanup = (error, failures) => {
    if (failures.length > 0) {
      fail(
        'The capability change failed and candidate cleanup is incomplete',
        'bot_capability_rollback_partial',
        500,
        {
          originalCode: typeof error?.code === 'string' ? error.code.slice(0, 120) : 'capability_change_failed',
          cleanupFailures: failures,
        },
      );
    }
    throw error;
  };

  const cleanupObject = async (object, failures) => {
    if (!object) return;
    await cleanupAttempt(failures, 'skill_storage_object', () => (
      store.storage.delete(object.storage_bucket, [object.storage_object_name])
    ));
    await cleanupAttempt(failures, 'skill_object_record', () => (
      store.deleteCreated('bot_objects', { id: object.id })
    ));
  };

  const resolveSkillPackages = async ({ revisionId, bindings } = {}) => {
    if (!Array.isArray(bindings)) fail('Bot skill binding list is invalid');
    const revision = await store.repositories.bot_revisions.get({
      id: validateUuid(revisionId, 'revisionId'),
    });
    if (!revision) fail('Bot revision not found', 'bot_revision_not_found', 404);
    const output = [];
    for (const reference of bindings) {
      const row = await store.repositories.bot_skill_packages.get({ id: reference.id });
      if (!row || row.bot_id !== revision.bot_id || row.package_digest !== reference.digest) {
        fail('A pinned Bot skill package is unavailable', 'bot_skill_binding_unavailable', 409);
      }
      const downloaded = await blobStore.downloadAuthorized({ botId: row.bot_id, objectId: row.package_object_id });
      try {
        output.push(parsePackage(downloaded.bytes, row));
      } finally {
        downloaded.bytes.fill(0);
      }
    }
    return Object.freeze(output);
  };

  const snapshotDiscoveredSkill = async (skillName, directory) => {
    const normalizedName = validateBoundedString(skillName, 'skillName', {
      maximum: 64,
      pattern: SKILL_NAME_PATTERN,
    });
    const discovered = discoverSkills(normalizeDirectory(directory));
    const skill = discovered.find((entry) => entry.name === normalizedName);
    if (!skill?.path || path.basename(skill.path).toLowerCase() !== 'skill.md') {
      fail('Installed skill not found', 'bot_skill_not_found', 404);
    }
    const scan = await scanner.scan({ selectedPath: path.dirname(skill.path) });
    try {
      return packageFromScan(normalizedName, scan);
    } finally {
      wipeBotSourceScan(scan);
    }
  };

  const attachSkill = async (principal, botId, revisionId, request) => {
    assertExactObject(request, {
      label: 'Bot skill attachment',
      required: ['skillName', 'expectedUpdatedAt'],
      optional: ['directory'],
    });
    const context = await requireDraft(principal, botId, revisionId, request.expectedUpdatedAt);
    const directory = await resolveCapabilityDirectory(principal, request.directory);
    const currentRows = await Promise.all((context.revision.contract.skillBindings || []).map(
      (binding) => store.repositories.bot_skill_packages.get({ id: binding.id }),
    ));
    if (currentRows.some((row) => row?.skill_name === request.skillName)) {
      fail('This skill is already assigned to the Draft', 'bot_skill_binding_duplicate', 409);
    }
    const snapshot = await snapshotDiscoveredSkill(request.skillName, directory);
    let object = null;
    let packageRow = null;
    let committed = false;
    try {
      object = await blobStore.createLibraryObject({
        principal,
        botId: context.bot.id,
        contentType: 'application/json',
        bytes: snapshot.bytes,
        provenance: { kind: 'bot_skill_package', skillName: snapshot.value.name, digest: snapshot.digest },
      });
      packageRow = await store.repositories.bot_skill_packages.insert({
        id: uuid(),
        bot_id: context.bot.id,
        skill_name: snapshot.value.name,
        display_metadata: { name: snapshot.value.name, fileCount: snapshot.value.files.length },
        manifest: {
          version: 1,
          files: snapshot.value.files.map((file) => ({ path: file.path, sha256: file.sha256, size: file.size })),
        },
        package_object_id: object.id,
        package_digest: snapshot.digest,
        created_by: validateUuid(principal.id, 'principal.id'),
      });
      const contract = {
        ...context.revision.contract,
        operatingInstructions: '',
        prohibitedInstructions: '',
        advancedPrompt: '',
        skillBindings: [
          ...(context.revision.contract.skillBindings || []),
          { id: packageRow.id, digest: packageRow.package_digest },
        ],
        mcpBindings: [],
      };
      const revision = await updateContract(context, contract);
      committed = true;
      await audit({
        principal,
        botId: context.bot.id,
        targetType: 'bot_skill_package',
        targetId: packageRow.id,
        action: 'bot.skill.attach',
        result: 'success',
        metadata: { revisionId: revision.id, skillName: packageRow.skill_name, digest: packageRow.package_digest },
      });
      return Object.freeze({ revision: publicRevision(revision, true) });
    } catch (error) {
      if (!committed) {
        const failures = [];
        if (packageRow) {
          await cleanupAttempt(failures, 'skill_package_record', () => (
            store.deleteCreated('bot_skill_packages', { id: packageRow.id })
          ));
        }
        await cleanupObject(object, failures);
        rethrowAfterCleanup(error, failures);
      }
      throw error;
    } finally {
      snapshot.bytes.fill(0);
    }
  };

  const detachSkill = async (principal, botId, revisionId, bindingId, request) => {
    assertExactObject(request, { label: 'Bot skill detachment', required: ['expectedUpdatedAt'] });
    const context = await requireDraft(principal, botId, revisionId, request.expectedUpdatedAt);
    const id = validateUuid(bindingId, 'bindingId');
    if (!(context.revision.contract.skillBindings || []).some((binding) => binding.id === id)) {
      fail('Skill binding not found', 'bot_skill_binding_not_found', 404);
    }
    const contract = {
      ...context.revision.contract,
      operatingInstructions: '',
      prohibitedInstructions: '',
      advancedPrompt: '',
      skillBindings: (context.revision.contract.skillBindings || []).filter((binding) => binding.id !== id),
      mcpBindings: [],
    };
    const revision = await updateContract(context, contract);
    await audit({
      principal,
      botId: context.bot.id,
      targetType: 'bot_skill_package',
      targetId: id,
      action: 'bot.skill.detach',
      result: 'success',
      metadata: { revisionId: revision.id },
    });
    return Object.freeze({ revision: publicRevision(revision, true) });
  };

  const createCredential = async ({ principal, bot, binding, secret, confirmSharedCredential }) => {
    const credentialRequired = binding.display_metadata.credentialRequired === true;
    if (!credentialRequired) return null;
    if (bot.tenancy === 'team' && confirmSharedCredential !== true) {
      fail(
        'Importing a shared team credential requires explicit confirmation',
        'bot_mcp_shared_credential_confirmation_required',
        409,
      );
    }
    const vault = getCredentialVault();
    if (!vault || typeof vault.create !== 'function') {
      fail('Bot credential vault is unavailable', 'bot_credential_vault_unavailable', 503);
    }
    const id = uuid();
    const metadata = await vault.create({
      id,
      botId: bot.id,
      provider: binding.credential_provider,
      kind: binding.credential_kind,
      credentialScope: bot.tenancy === 'team' ? 'team' : 'user',
      ownerUserId: bot.tenancy === 'team' ? null : principal.id,
      createdBy: principal.id,
      metadata: { bindingId: binding.id, serverName: binding.server_name },
      secret,
    });
    try {
      const row = await store.repositories.bot_credentials.insert({
        id: metadata.id,
        bot_id: metadata.botId,
        provider: metadata.provider,
        kind: metadata.kind,
        credential_scope: metadata.credentialScope,
        owner_user_id: metadata.ownerUserId,
        local_vault_reference: metadata.localVaultReference,
        metadata: metadata.metadata,
        status: metadata.status,
        created_by: metadata.createdBy,
        revoked_at: metadata.revokedAt,
      });
      return row;
    } catch (error) {
      await vault.deleteCreated?.(id).catch(() => undefined);
      throw error;
    }
  };

  const cleanupCredential = async (credential, failures) => {
    if (!credential) return;
    await cleanupAttempt(failures, 'credential_record', () => (
      store.deleteCreated('bot_credentials', { id: credential.id })
    ));
    await cleanupAttempt(failures, 'credential_vault', async () => {
      const vault = getCredentialVault();
      if (typeof vault?.deleteCreated !== 'function') {
        throw Object.assign(new Error('Bot credential vault cleanup is unavailable'), {
          code: 'bot_credential_vault_unavailable',
        });
      }
      await vault.deleteCreated(credential.id);
    });
  };

  const attachMcp = async () => {
    fail(
      'MCP servers are no longer attached to Bots. Use a protected API key or sign in on the Bot computer.',
      'bot_mcp_assignments_removed',
      410,
    );
  };

  const detachMcp = async (principal, botId, revisionId, bindingId, request) => {
    assertExactObject(request, { label: 'Bot MCP detachment', required: ['expectedUpdatedAt'] });
    const context = await requireDraft(principal, botId, revisionId, request.expectedUpdatedAt);
    const id = validateUuid(bindingId, 'bindingId');
    if (!(context.revision.contract.mcpBindings || []).some((binding) => binding.id === id)) {
      fail('MCP binding not found', 'bot_mcp_binding_not_found', 404);
    }
    const contract = {
      ...context.revision.contract,
      skillBindings: [...(context.revision.contract.skillBindings || [])],
      mcpBindings: (context.revision.contract.mcpBindings || []).filter((binding) => binding.id !== id),
    };
    const revision = await updateContract(context, contract);
    await audit({
      principal,
      botId: context.bot.id,
      targetType: 'bot_mcp_binding',
      targetId: id,
      action: 'bot.mcp.detach',
      result: 'success',
      metadata: { revisionId: revision.id },
    });
    return Object.freeze({ revision: publicRevision(revision, true) });
  };

  const rotateMcpCredential = async (principal, botId, revisionId, bindingId, request) => {
    assertExactObject(request, {
      label: 'Bot MCP credential rotation',
      required: ['serverName', 'expectedUpdatedAt', 'confirmSharedCredential'],
      optional: ['directory'],
    });
    const context = await requireDraft(principal, botId, revisionId, request.expectedUpdatedAt);
    const id = validateUuid(bindingId, 'bindingId');
    if (!(context.revision.contract.mcpBindings || []).some((binding) => binding.id === id)) {
      fail('MCP binding not found', 'bot_mcp_binding_not_found', 404);
    }
    const binding = await store.repositories.bot_mcp_bindings.get({ id, bot_id: context.bot.id });
    const directory = await resolveCapabilityDirectory(principal, request.directory);
    const candidate = configuredMcpCandidate(request.serverName, directory);
    if (!binding || candidate.serverName !== binding.server_name
      || digestBotMcpDescriptor(candidate.descriptor) !== binding.descriptor_digest) {
      fail('Credential rotation cannot change the pinned MCP server', 'bot_mcp_binding_changed', 409);
    }
    if (context.bot.tenancy === 'team' && request.confirmSharedCredential !== true) {
      fail('Rotating a shared team credential requires explicit confirmation', 'bot_mcp_shared_credential_confirmation_required', 409);
    }
    const preflight = await preflightMcpCandidate(candidate);
    if (preflight.manifestDigest !== binding.manifest_digest) {
      fail(
        'The MCP server tool manifest changed; update the Draft binding before rotating its credential',
        'bot_mcp_manifest_drift',
        409,
      );
    }
    const credentials = await listRows(store.repositories.bot_credentials, {
      bot_id: context.bot.id,
      provider: binding.credential_provider,
    });
    const credential = credentials.find((row) => row.status === 'active' && row.revoked_at === null
      && (context.bot.tenancy === 'team'
        ? row.credential_scope === 'team' && row.owner_user_id === null
        : row.credential_scope === 'user' && row.owner_user_id === principal.id));
    const vault = getCredentialVault();
    if (!credential) {
      let importedCredential = null;
      let committed = false;
      try {
        importedCredential = await createCredential({
          principal,
          bot: context.bot,
          binding,
          secret: candidate.secret,
          confirmSharedCredential: request.confirmSharedCredential,
        });
        if (!importedCredential) {
          fail('This MCP binding does not require a credential', 'bot_mcp_credential_not_required', 409);
        }
        const revision = await updateContract(context, {
          ...context.revision.contract,
          skillBindings: [...(context.revision.contract.skillBindings || [])],
          mcpBindings: [...(context.revision.contract.mcpBindings || [])],
        });
        committed = true;
        await mcpHost.closeBinding(id);
        await audit({
          principal,
          botId: context.bot.id,
          targetType: 'bot_credential',
          targetId: importedCredential.id,
          action: 'bot.mcp.credential.import',
          result: 'success',
          metadata: { revisionId: revision.id, bindingId: id },
        });
        return Object.freeze({ revision: publicRevision(revision, true) });
      } catch (error) {
        if (!committed) {
          const failures = [];
          await cleanupCredential(importedCredential, failures);
          rethrowAfterCleanup(error, failures);
        }
        throw error;
      }
    }
    if (!vault || typeof vault.read !== 'function' || typeof vault.rotate !== 'function') {
      fail('Bot credential vault is unavailable', 'bot_credential_vault_unavailable', 503);
    }
    const previous = await vault.read(credential.id);
    let rotated = null;
    let updatedCredential = null;
    let committed = false;
    try {
      rotated = await vault.rotate(credential.id, candidate.secret);
      updatedCredential = await store.repositories.bot_credentials.updateIfRevision(
        { id: credential.id, bot_id: context.bot.id },
        { metadata: rotated.metadata, status: rotated.status, revoked_at: rotated.revokedAt },
        credential.updated_at,
      );
      const revision = await updateContract(context, {
        ...context.revision.contract,
        skillBindings: [...(context.revision.contract.skillBindings || [])],
        mcpBindings: [...(context.revision.contract.mcpBindings || [])],
      });
      committed = true;
      await mcpHost.closeBinding(id);
      await audit({
        principal,
        botId: context.bot.id,
        targetType: 'bot_credential',
        targetId: credential.id,
        action: 'bot.mcp.credential.rotate',
        result: 'success',
        metadata: { revisionId: revision.id, bindingId: id },
      });
      return Object.freeze({ revision: publicRevision(revision, true) });
    } catch (error) {
      if (!committed && rotated) {
        const failures = [];
        let restored = null;
        await cleanupAttempt(failures, 'credential_vault_restore', async () => {
          restored = await vault.rotate(credential.id, previous.secret);
        });
        if (restored && updatedCredential) {
          await cleanupAttempt(failures, 'credential_record_restore', () => (
            store.repositories.bot_credentials.updateIfRevision(
              { id: credential.id, bot_id: context.bot.id },
              { metadata: restored.metadata, status: restored.status, revoked_at: restored.revokedAt },
              updatedCredential.updated_at,
            )
          ));
        }
        rethrowAfterCleanup(error, failures);
      }
      throw error;
    } finally {
      previous.secret = null;
    }
  };

  const safeCredentialState = async (bot, binding, principal) => {
    if (binding.display_metadata?.credentialRequired !== true) return 'not-required';
    const credentials = await listRows(store.repositories.bot_credentials, {
      bot_id: bot.id,
      provider: binding.credential_provider,
    });
    const active = credentials.filter((row) => row.status === 'active' && row.revoked_at === null);
    if (bot.tenancy === 'team') {
      return active.some((row) => row.credential_scope === 'team' && row.owner_user_id === null)
        ? 'connected'
        : 'required';
    }
    return active.some((row) => row.credential_scope === 'user' && row.owner_user_id === principal.id)
      ? 'connected'
      : 'required';
  };

  const list = async (principal, botId, revisionId, { directory, checkLive = false } = {}) => {
    const decision = await readDecision(principal, botId);
    const resolvedDirectory = decision.canManage
      ? await resolveCapabilityDirectory(principal, directory)
      : undefined;
    const revision = await store.repositories.bot_revisions.get({
      id: validateUuid(revisionId, 'revisionId'),
      bot_id: decision.bot.id,
    });
    if (!revision) fail('Bot revision not found', 'bot_revision_not_found', 404);
    const skillRows = await Promise.all((revision.contract.skillBindings || []).map(
      (binding) => store.repositories.bot_skill_packages.get({ id: binding.id, bot_id: decision.bot.id }),
    ));
    const mcpRows = await Promise.all((revision.contract.mcpBindings || []).map(
      (binding) => store.repositories.bot_mcp_bindings.get({ id: binding.id, bot_id: decision.bot.id }),
    ));
    const skills = [];
    for (const [index, row] of skillRows.entries()) {
      const reference = revision.contract.skillBindings[index];
      if (!row) {
        skills.push(Object.freeze({
          id: reference.id,
          name: 'Unavailable skill',
          digest: reference.digest,
          fileCount: 0,
          updateAvailable: false,
          integrity: 'failed',
        }));
        continue;
      }
      let updateAvailable = false;
      if (decision.canManage) {
        try {
          const snapshot = await snapshotDiscoveredSkill(row.skill_name, resolvedDirectory);
          updateAvailable = snapshot.digest !== row.package_digest;
          snapshot.bytes.fill(0);
        } catch {
          updateAvailable = true;
        }
      }
      skills.push(Object.freeze({
        id: row.id,
        name: row.skill_name,
        digest: row.package_digest,
        fileCount: Number(row.display_metadata?.fileCount || row.manifest?.files?.length || 0),
        updateAvailable,
        integrity: revision.contract.skillBindings[index]?.digest === row.package_digest ? 'pinned' : 'failed',
      }));
    }
    const mcp = [];
    for (const [index, row] of mcpRows.entries()) {
      const reference = revision.contract.mcpBindings[index];
      if (!row) {
        mcp.push(Object.freeze({
          id: reference.id,
          serverName: 'Unavailable MCP Server',
          transport: 'streamable_http',
          descriptorDigest: reference.descriptorDigest,
          manifestDigest: reference.manifestDigest,
          toolCount: 0,
          credentialState: 'required',
          updateAvailable: false,
          connectivity: 'unavailable',
          integrity: 'failed',
        }));
        continue;
      }
      let updateAvailable = false;
      let connectivity = 'not-checked';
      if (checkLive && decision.canManage) {
        try {
          await mcpHost.checkBinding({
            botId: decision.bot.id,
            revisionId: revision.id,
            bindingId: row.id,
            ownerUserId: principal.id,
          });
          connectivity = 'connected';
        } catch (error) {
          updateAvailable = error?.code === 'bot_mcp_manifest_drift';
          connectivity = updateAvailable ? 'manifest-drift' : 'unavailable';
        }
      }
      mcp.push(Object.freeze({
        id: row.id,
        serverName: row.server_name,
        transport: row.transport,
        descriptorDigest: row.descriptor_digest,
        manifestDigest: row.manifest_digest,
        toolCount: Number(row.display_metadata?.toolCount || row.tool_manifest?.length || 0),
        credentialState: await safeCredentialState(decision.bot, row, principal),
        updateAvailable,
        connectivity,
        integrity: revision.contract.mcpBindings[index]?.manifestDigest === row.manifest_digest
          && revision.contract.mcpBindings[index]?.descriptorDigest === row.descriptor_digest
          ? 'pinned'
          : 'failed',
      }));
    }
    return Object.freeze({
      bot: publicBot(decision.bot),
      canManage: decision.canManage,
      revision: publicRevision(revision, decision.canManage),
      skills: Object.freeze(skills),
      mcp: Object.freeze(mcp),
      availableSkills: decision.canManage ? availableSkillSummaries(resolvedDirectory) : Object.freeze([]),
      availableMcp: Object.freeze([]),
    });
  };

  const runtimeCatalog = async ({ revisionId } = {}) => {
    const revision = await store.repositories.bot_revisions.get({
      id: validateUuid(revisionId, 'revisionId'),
    });
    if (!revision) fail('Bot revision not found', 'bot_revision_not_found', 404);
    return Object.freeze({ mcpServers: Object.freeze([]), invocation: null });
  };

  const preflightRevision = async ({ revision, contract }) => {
    let skillResult;
    try {
      await compileRevision({ channelId: revision.id, revisionId: revision.id, contract });
      skillResult = Object.freeze({
        count: (contract.skillBindings || []).length,
        materialized: true,
        error: null,
      });
    } catch (error) {
      skillResult = Object.freeze({
        count: (contract.skillBindings || []).length,
        materialized: false,
        error: error instanceof Error ? error.message.slice(0, 500) : 'Skill preflight failed',
      });
    }
    return Object.freeze({
      skills: skillResult,
      mcp: Object.freeze([]),
      mcpReady: true,
      mcpError: null,
    });
  };

  return Object.freeze({
    list,
    attachSkill,
    detachSkill,
    attachMcp,
    detachMcp,
    rotateMcpCredential,
    resolveSkillPackages,
    runtimeCatalog,
    preflightRevision,
  });
}
