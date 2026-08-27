import express from 'express';
import { performance } from 'node:perf_hooks';

import { BOT_PROFILE_AVATAR_MAX_BYTES, publicBotObject } from './blob-store.js';
import { productionBotsMigrationFailurePayload } from '../multi-user/auth-compat.js';
import {
  assertExactObject,
  BotValidationError,
  jsonError,
  validateBotProfileUpdateRequest,
  validateObjectUploadRequest,
  validatePublishObjectRequest,
  validateUuid,
} from './validation.js';

const publicIssues = (issues) => (Array.isArray(issues) ? issues.slice(0, 20).map((issue) => ({
  code: typeof issue?.code === 'string' ? issue.code.slice(0, 120) : 'bot_runtime_issue',
  message: typeof issue?.message === 'string'
    ? issue.message.replace(/[\r\n\0]/g, ' ').slice(0, 500)
    : 'Bot runtime issue',
})) : []);

const validateComputerFilesPath = (value) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 1_024
    || value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    throw new BotValidationError('Bot computer-files path is invalid');
  }
  const segments = value.split('/');
  if (segments.length > 32 || segments.some((segment) => (
    segment === '' || segment === '.' || segment === '..'
    || Buffer.byteLength(segment, 'utf8') > 255
  ))) {
    throw new BotValidationError('Bot computer-files path is invalid');
  }
  return value;
};

const capability = ({
  state,
  code,
  owner,
  runtime = null,
  available = false,
  requiredMigration = null,
}) => ({
  available,
  state,
  code,
  owner,
  canManageRuntime: owner === 'electron',
  ...(requiredMigration ? { requiredMigration } : {}),
  runtime: runtime ? {
    state: typeof runtime.state === 'string' ? runtime.state : null,
    code: typeof runtime.code === 'string' ? runtime.code : null,
    issues: publicIssues(runtime.issues),
    canSetup: runtime.canSetup === true,
    canRepair: runtime.canRepair === true,
    canUpdate: runtime.canUpdate === true,
    canRollback: runtime.canRollback === true,
  } : null,
});

export const resolveBotCapabilities = async ({
  hasSupabase,
  botHost,
  encryption,
  schemaFailure = null,
  controlPlaneFailure = null,
  executionFailure = null,
} = {}) => {
  const owner = typeof botHost?.owner === 'string' ? botHost.owner : 'unsupported';
  if (!hasSupabase) {
    return capability({
      state: 'supabase_unavailable',
      code: 'bots_supabase_unavailable',
      owner,
    });
  }
  if (schemaFailure) {
    return capability({
      state: 'migration_required',
      code: schemaFailure.code,
      owner,
      requiredMigration: schemaFailure.requiredMigration,
    });
  }
  if (controlPlaneFailure) {
    return capability({
      state: 'supabase_unavailable',
      code: controlPlaneFailure.code || 'bots_supabase_unavailable',
      owner,
    });
  }
  if (owner !== 'electron') {
    return capability({
      state: 'unsupported_host',
      code: 'bots_host_unsupported',
      owner,
    });
  }
  if (typeof encryption?.getKey !== 'function') {
    return capability({
      state: 'encryption_unavailable',
      code: 'bot_os_encryption_unavailable',
      owner,
    });
  }
  let encryptionKey = null;
  let providedKey = null;
  try {
    providedKey = await encryption.getKey();
    encryptionKey = Buffer.from(providedKey || []);
    if (encryptionKey.byteLength !== 32) throw new Error('invalid Bot encryption key');
  } catch (error) {
    return capability({
      state: 'encryption_unavailable',
      code: typeof error?.code === 'string' ? error.code : 'bot_os_encryption_unavailable',
      owner,
    });
  } finally {
    encryptionKey?.fill(0);
    if (Buffer.isBuffer(providedKey) || providedKey instanceof Uint8Array) providedKey.fill(0);
  }
  if (typeof botHost?.getStatus !== 'function') {
    return capability({
      state: 'runtime_unavailable',
      code: 'bot_runtime_unavailable',
      owner,
    });
  }

  let runtime;
  try {
    runtime = await botHost.getStatus();
  } catch (error) {
    return capability({
      state: 'runtime_unavailable',
      code: typeof error?.code === 'string' ? error.code : 'bot_runtime_unavailable',
      owner,
    });
  }
  const indexState = runtime?.indexState || runtime?.index?.state || null;
  if (['building', 'rebuilding', 'rebuild_required'].includes(indexState)
    || runtime?.state === 'index_rebuilding') {
    return capability({
      state: 'index_rebuilding',
      code: 'bot_index_rebuilding',
      owner,
      runtime,
    });
  }

  const states = {
    docker_not_installed: ['docker_not_installed', 'bot_runtime_docker_not_installed'],
    docker_unavailable: ['docker_stopped', 'bot_runtime_docker_unavailable'],
    setup_required: ['setup_required', 'bot_runtime_setup_required'],
    runtime_update_required: ['image_update_available', 'bot_runtime_update_required'],
    degraded: ['runtime_degraded', 'bot_runtime_degraded'],
    healthy: ['healthy', null],
  };
  const [state, code] = states[runtime?.state] || ['runtime_unavailable', 'bot_runtime_unavailable'];
  if (state === 'healthy' && executionFailure) {
    return capability({
      state: 'runtime_degraded',
      code: executionFailure.code || 'bot_runtime_execution_unavailable',
      owner,
      runtime,
    });
  }
  return capability({
    state,
    code: runtime?.code || code,
    owner,
    runtime,
    available: state === 'healthy',
  });
};

export function registerBotRoutes(app, {
  store,
  management = null,
  blobStore,
  channels = null,
  memoryRuntime = null,
  routineRuntime = null,
  libraryRuntime = null,
  computerResources = null,
  environmentSecrets = null,
  artifactService = null,
  sharedFileService = null,
  dispatcher = null,
  eventStream = null,
  approvalService = null,
  browserService = null,
  evidenceService = null,
  actionGateway = null,
  capabilityBindings = null,
  agentConnections = null,
  botSpecService = null,
  recoveryBundle = null,
  purgeRuntime = null,
  botHost,
  encryption,
  getSchemaFailure = () => null,
  getControlPlaneFailure = () => null,
  getExecutionFailure = () => null,
  resolveCapabilities = null,
  getRuntimeServices = null,
} = {}) {
  if (!app || typeof app.get !== 'function') throw new TypeError('Bot routes require an Express app');

  const runtimeService = (name, initialValue) => (
    typeof getRuntimeServices === 'function'
      ? getRuntimeServices()?.[name] || null
      : initialValue
  );

  const requireManagerWithoutRuntime = async (principal, botId, message) => {
    if (typeof management?.getDetail !== 'function') {
      throw Object.assign(new Error(message), {
        code: 'bots_unavailable', statusCode: 503,
      });
    }
    const detail = await management.getDetail(principal, botId);
    if (!detail.canManage) {
      throw Object.assign(new Error('Bot Manager access is required'), {
        code: 'bot_manager_required', statusCode: 403,
      });
    }
  };

  app.get('/api/bots/capabilities', async (req, res) => {
    try {
      const resolved = typeof resolveCapabilities === 'function'
        ? await resolveCapabilities()
        : await resolveBotCapabilities({
            hasSupabase: store?.available === true,
            botHost,
            encryption,
            schemaFailure: getSchemaFailure(),
            controlPlaneFailure: getControlPlaneFailure(),
            executionFailure: getExecutionFailure(),
          });
      return res.json({
        ...resolved,
        canCreateBot: management?.canCreateBot?.(req.principal) === true,
      });
    } catch (error) {
      return botRouteError(res, error, 503);
    }
  });

  if (typeof app.use === 'function') {
    app.use(
      ['/api/bots', '/api/bot-actions', '/api/bot-channels', '/api/bot-runs'],
      (_req, res, next) => {
        const failure = getSchemaFailure();
        if (!failure) return next();
        return res.status(failure.status || 503).json({
          error: failure.error || 'Database migration required',
          code: failure.code || 'bot_schema_migration_required',
          requiredMigration: failure.requiredMigration,
        });
      },
    );
  }

  // Register the static SSE path before `/:botId`; otherwise Express treats
  // `events` as a Bot identifier and the event stream becomes unreachable.
  app.get('/api/bots/events', async (req, res) => {
    try {
      if (!eventStream) throw Object.assign(new Error('Bot event stream is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      await eventStream.writeSse({ principal: req.principal, request: req, response: res });
      return undefined;
    } catch (error) {
      if (res.headersSent) return res.end?.();
      return botRouteError(res, error);
    }
  });

  app.post(
    '/api/bots/recovery/restore',
    express.raw({ type: 'application/vnd.devryan.bot-recovery', limit: '512mb' }),
    async (req, res) => {
      try {
        if (!recoveryBundle) throw Object.assign(new Error('Bot recovery is unavailable'), {
          code: 'bots_unavailable', statusCode: 503,
        });
        const passphrase = req.headers?.['x-devryan-recovery-passphrase'];
        const mode = req.headers?.['x-devryan-recovery-mode'];
        if (!Buffer.isBuffer(req.body)) {
          throw Object.assign(new Error('Encrypted Bot recovery bundle is required'), {
            code: 'bot_recovery_invalid', statusCode: 400,
          });
        }
        return res.json(await recoveryBundle.restoreBundle(req.principal, {
          passphrase,
          mode,
          bundle: req.body,
        }));
      } catch (error) {
        return botRouteError(res, error);
      }
    },
  );

  app.get('/api/bots', async (req, res) => {
    try {
      if (!management) throw Object.assign(new Error('Bot management is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await management.listCatalog(req.principal));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots', async (req, res) => {
    try {
      if (!management) throw Object.assign(new Error('Bot management is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.status(201).json(await management.create(req.principal, req.body));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.get('/api/bots/:botId', async (req, res) => {
    try {
      if (!management) throw Object.assign(new Error('Bot management is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await management.getDetail(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.patch('/api/bots/:botId/profile', async (req, res) => {
    let avatarBytes = null;
    try {
      if (!management) throw Object.assign(new Error('Bot management is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      const input = validateBotProfileUpdateRequest(req.body, BOT_PROFILE_AVATAR_MAX_BYTES);
      avatarBytes = input.avatar?.bytes || null;
      return res.json(await management.updateProfile(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        input,
      ));
    } catch (error) {
      return botRouteError(res, error);
    } finally {
      avatarBytes?.fill(0);
    }
  });

  app.get('/api/bots/:botId/avatar', async (req, res) => {
    try {
      if (!management) throw Object.assign(new Error('Bot management is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      const result = await management.downloadAvatar(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
      );
      res.setHeader('Content-Type', result.object.content_type);
      res.setHeader('Content-Length', String(result.bytes.byteLength));
      res.setHeader('Cache-Control', 'no-store, private');
      return res.send(result.bytes);
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.get('/api/bots/:botId/model-options', async (req, res) => {
    try {
      if (!management) throw Object.assign(new Error('Bot management is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await management.modelOptions(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.get('/api/bots/:botId/agent-connections', async (req, res) => {
    try {
      const service = runtimeService('agentConnections', agentConnections);
      if (!service) throw Object.assign(new Error('Bot agent connections are unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await service.list(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots/:botId/agent-connections', async (req, res) => {
    try {
      const service = runtimeService('agentConnections', agentConnections);
      if (!service) throw Object.assign(new Error('Bot agent connections are unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.status(201).json(await service.create(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        req.body,
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.put('/api/bots/:botId/agent-connections/:connectionId', async (req, res) => {
    try {
      const service = runtimeService('agentConnections', agentConnections);
      if (!service) throw Object.assign(new Error('Bot agent connections are unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await service.update(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        validateUuid(req.params.connectionId, 'connectionId'),
        req.body,
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots/:botId/agent-connections/:connectionId/test', async (req, res) => {
    try {
      const service = runtimeService('agentConnections', agentConnections);
      if (!service) throw Object.assign(new Error('Bot agent connections are unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      assertExactObject(req.body || {}, {
        label: 'Bot agent connection test',
        required: [],
      });
      return res.json(await service.test(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        validateUuid(req.params.connectionId, 'connectionId'),
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.delete('/api/bots/:botId/agent-connections/:connectionId', async (req, res) => {
    try {
      const service = runtimeService('agentConnections', agentConnections);
      if (!service) throw Object.assign(new Error('Bot agent connections are unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await service.revoke(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        validateUuid(req.params.connectionId, 'connectionId'),
        req.body,
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots/:botId/revisions', async (req, res) => {
    try {
      if (!management) throw Object.assign(new Error('Bot management is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.status(201).json(await management.createRevision(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        req.body,
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.patch('/api/bots/:botId/revisions/:revisionId', async (req, res) => {
    try {
      if (!management) throw Object.assign(new Error('Bot management is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await management.updateDraftRevision(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        validateUuid(req.params.revisionId, 'revisionId'),
        req.body,
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.get('/api/bots/:botId/revisions/:revisionId/capability-bindings', async (req, res) => {
    try {
      if (!capabilityBindings) throw Object.assign(new Error('Bot capability assignments are unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await capabilityBindings.list(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        validateUuid(req.params.revisionId, 'revisionId'),
        {
          directory: typeof req.query.directory === 'string' ? req.query.directory : undefined,
          checkLive: req.query.checkLive === 'true',
        },
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots/:botId/revisions/:revisionId/skill-bindings', async (req, res) => {
    try {
      if (!capabilityBindings) throw Object.assign(new Error('Bot skill assignments are unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.status(201).json(await capabilityBindings.attachSkill(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        validateUuid(req.params.revisionId, 'revisionId'),
        req.body,
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.delete('/api/bots/:botId/revisions/:revisionId/skill-bindings/:bindingId', async (req, res) => {
    try {
      if (!capabilityBindings) throw Object.assign(new Error('Bot skill assignments are unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await capabilityBindings.detachSkill(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        validateUuid(req.params.revisionId, 'revisionId'),
        validateUuid(req.params.bindingId, 'bindingId'),
        req.body,
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots/:botId/revisions/:revisionId/mcp-bindings', async (req, res) => {
    try {
      if (!capabilityBindings) throw Object.assign(new Error('Bot MCP assignments are unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.status(201).json(await capabilityBindings.attachMcp(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        validateUuid(req.params.revisionId, 'revisionId'),
        req.body,
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.delete('/api/bots/:botId/revisions/:revisionId/mcp-bindings/:bindingId', async (req, res) => {
    try {
      if (!capabilityBindings) throw Object.assign(new Error('Bot MCP assignments are unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await capabilityBindings.detachMcp(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        validateUuid(req.params.revisionId, 'revisionId'),
        validateUuid(req.params.bindingId, 'bindingId'),
        req.body,
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots/:botId/revisions/:revisionId/mcp-bindings/:bindingId/credential', async (req, res) => {
    try {
      if (!capabilityBindings) throw Object.assign(new Error('Bot MCP credentials are unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await capabilityBindings.rotateMcpCredential(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        validateUuid(req.params.revisionId, 'revisionId'),
        validateUuid(req.params.bindingId, 'bindingId'),
        req.body,
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.get('/api/bots/:botId/revisions/:revisionId/activation-health', async (req, res) => {
    try {
      if (!management) throw Object.assign(new Error('Bot management is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await management.activationHealth(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        validateUuid(req.params.revisionId, 'revisionId'),
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots/:botId/revisions/:revisionId/activate', async (req, res) => {
    try {
      if (!management) throw Object.assign(new Error('Bot management is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      assertExactObject(req.body, { label: 'Bot revision activation', required: [] });
      return res.json(await management.activateRevision(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        validateUuid(req.params.revisionId, 'revisionId'),
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots/:botId/revisions/:revisionId/publish', async (req, res) => {
    let avatarBytes = null;
    try {
      if (!management) throw Object.assign(new Error('Bot management is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      let input = req.body;
      if (input && typeof input === 'object' && !Array.isArray(input)
        && Object.hasOwn(input, 'profile')) {
        const profile = validateBotProfileUpdateRequest(
          input.profile,
          BOT_PROFILE_AVATAR_MAX_BYTES,
        );
        avatarBytes = profile.avatar?.bytes || null;
        input = { ...input, profile };
      }
      return res.json(await management.publishRevision(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        validateUuid(req.params.revisionId, 'revisionId'),
        input,
      ));
    } catch (error) {
      return botRouteError(res, error);
    } finally {
      avatarBytes?.fill(0);
    }
  });

  app.get('/api/bots/:botId/revisions/:revisionId/export', async (req, res) => {
    try {
      if (!botSpecService) throw Object.assign(new Error('Bot specification export is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      const result = await botSpecService.exportRevision(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        validateUuid(req.params.revisionId, 'revisionId'),
      );
      res.setHeader('Content-Type', `${result.mediaType}; charset=utf-8`);
      res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
      res.setHeader('Cache-Control', 'no-store, private');
      res.setHeader('X-DevRyan-Bot-Spec-Hash', result.specHash);
      return res.send(result.source);
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bot-specs/import/preview', async (req, res) => {
    try {
      if (!botSpecService) throw Object.assign(new Error('Bot specification import is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await botSpecService.previewImport(req.principal, req.body));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bot-specs/import', async (req, res) => {
    try {
      if (!botSpecService) throw Object.assign(new Error('Bot specification import is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.status(201).json(await botSpecService.importDraft(req.principal, req.body));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.put('/api/bots/:botId/revisions/:revisionId/import-bindings', async (req, res) => {
    try {
      if (!botSpecService) throw Object.assign(new Error('Bot binding resolution is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await botSpecService.resolveDraftBindings(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        validateUuid(req.params.revisionId, 'revisionId'),
        req.body,
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.get('/api/bot-signers/trust', async (req, res) => {
    try {
      if (!botSpecService) throw Object.assign(new Error('Bot signer trust is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await botSpecService.listTrust(
        req.principal,
        typeof req.query.botId === 'string' ? validateUuid(req.query.botId, 'botId') : null,
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.put('/api/bot-signers/trust', async (req, res) => {
    try {
      if (!botSpecService) throw Object.assign(new Error('Bot signer trust is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await botSpecService.setTrust(req.principal, req.body));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots/:botId/lifecycle', async (req, res) => {
    try {
      if (!management) throw Object.assign(new Error('Bot management is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await management.transitionLifecycle(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        req.body,
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots/:botId/memberships', async (req, res) => {
    try {
      if (!management) throw Object.assign(new Error('Bot management is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await management.setMembership(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        req.body,
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.delete('/api/bots/:botId/memberships/:userId', async (req, res) => {
    try {
      if (!management) throw Object.assign(new Error('Bot management is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await management.revokeMembership(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        validateUuid(req.params.userId, 'userId'),
        req.body,
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.get('/api/bots/:botId/directory', async (req, res) => {
    try {
      if (!management) throw Object.assign(new Error('Bot management is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await management.searchDirectory(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        {
          query: typeof req.query?.q === 'string' ? req.query.q : '',
          limit: req.query?.limit,
        },
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots/:botId/credentials', async (req, res) => {
    try {
      if (!management) throw Object.assign(new Error('Bot management is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      if (Object.hasOwn(req.body || {}, 'secret')) {
        return res.status(201).json(await management.createCredentialConnection(
          req.principal,
          validateUuid(req.params.botId, 'botId'),
          req.body,
        ));
      }
      if (req.body?.kind === 'oauth' && Object.hasOwn(req.body, 'connectionId')) {
        return res.status(201).json(await management.createOAuthCredentialConnection(
          req.principal,
          validateUuid(req.params.botId, 'botId'),
          req.body,
        ));
      }
      return res.status(req.body?.id ? 200 : 201).json(await management.saveCredentialMetadata(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        req.body,
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots/:botId/credentials/:credentialId/rotate', async (req, res) => {
    try {
      if (!management) throw Object.assign(new Error('Bot management is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await management.rotateCredentialConnection(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        validateUuid(req.params.credentialId, 'credentialId'),
        req.body,
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.get('/api/bots/:botId/eval-cases', async (req, res) => {
    try {
      if (!management) throw Object.assign(new Error('Bot management is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json({
        evalCases: await management.listEvalCases(
          req.principal,
          validateUuid(req.params.botId, 'botId'),
        ),
      });
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots/:botId/eval-cases', async (req, res) => {
    try {
      if (!management) throw Object.assign(new Error('Bot management is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      throw Object.assign(
        new Error('Bot evaluations are read-only compatibility data'),
        { code: 'bot_evaluations_deprecated', statusCode: 410 },
      );
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots/:botId/eval-cases/:evalCaseId/run', async (req, res) => {
    try {
      if (!management) throw Object.assign(new Error('Bot management is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      throw Object.assign(
        new Error('Bot evaluations are read-only compatibility data'),
        { code: 'bot_evaluations_deprecated', statusCode: 410 },
      );
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.get('/api/bots/:botId/purge-preview', async (req, res) => {
    try {
      if (!management) throw Object.assign(new Error('Bot management is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await management.purgePreview(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots/:botId/recovery/export', async (req, res) => {
    try {
      if (!recoveryBundle) throw Object.assign(new Error('Bot recovery is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      const result = await recoveryBundle.exportBundle(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        req.body,
      );
      res.setHeader('Content-Type', 'application/vnd.devryan.bot-recovery');
      res.setHeader('Content-Length', String(result.bundle.byteLength));
      res.setHeader('Cache-Control', 'private, no-store, no-transform');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="DevRyan-Bot-Recovery-${result.bot.id}.drbr"`,
      );
      return res.send(result.bundle);
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.get('/api/bots/:botId/purge', async (req, res) => {
    try {
      if (!purgeRuntime) throw Object.assign(new Error('Bot purge is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json({
        purge: await purgeRuntime.get(
          req.principal,
          validateUuid(req.params.botId, 'botId'),
        ),
      });
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots/:botId/purge', async (req, res) => {
    try {
      if (!purgeRuntime) throw Object.assign(new Error('Bot purge is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      const purge = await purgeRuntime.start(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        req.body,
      );
      return res.status(purge.complete ? 200 : 202).json({ purge });
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots/:botId/purge/complete', async (req, res) => {
    try {
      if (!purgeRuntime) throw Object.assign(new Error('Bot purge is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      const purge = await purgeRuntime.startComplete(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        req.body,
      );
      return res.status(purge.complete ? 200 : 202).json({ purge });
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots/:botId/purge/retry', async (req, res) => {
    try {
      if (!purgeRuntime) throw Object.assign(new Error('Bot purge is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      const purge = await purgeRuntime.retry(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        req.body,
      );
      return res.status(purge.complete ? 200 : 202).json({ purge });
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.get('/api/bots/:botId/routines', async (req, res) => {
    try {
      const runtime = runtimeService('routineRuntime', routineRuntime);
      if (!runtime) throw Object.assign(new Error('Bot routines are unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await runtime.listForManager(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        { cursor: req.query?.cursor || null, limit: req.query?.limit },
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots/:botId/routines/draft', async (req, res) => {
    try {
      const runtime = runtimeService('routineRuntime', routineRuntime);
      if (!runtime) throw Object.assign(new Error('Bot routines are unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await runtime.draft(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        req.body,
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots/:botId/routines', async (req, res) => {
    try {
      const runtime = runtimeService('routineRuntime', routineRuntime);
      if (!runtime) throw Object.assign(new Error('Bot routines are unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.status(201).json(await runtime.createDraft(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        req.body,
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.patch('/api/bots/:botId/routines/:routineId', async (req, res) => {
    try {
      const runtime = runtimeService('routineRuntime', routineRuntime);
      if (!runtime) throw Object.assign(new Error('Bot routines are unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await runtime.updateDraft(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        validateUuid(req.params.routineId, 'routineId'),
        req.body,
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots/:botId/routines/:routineId/lifecycle', async (req, res) => {
    try {
      const runtime = runtimeService('routineRuntime', routineRuntime);
      if (!runtime) throw Object.assign(new Error('Bot routines are unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await runtime.transition(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        validateUuid(req.params.routineId, 'routineId'),
        req.body,
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.get('/api/bots/:botId/memories', async (req, res) => {
    try {
      const runtime = runtimeService('memoryRuntime', memoryRuntime);
      if (!runtime) throw Object.assign(new Error('Bot memory is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await runtime.listForManager(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        { cursor: req.query?.cursor || null, limit: req.query?.limit },
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.get('/api/bots/:botId/memories/:memoryId', async (req, res) => {
    try {
      const runtime = runtimeService('memoryRuntime', memoryRuntime);
      if (!runtime) throw Object.assign(new Error('Bot memory is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await runtime.getForManager(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        validateUuid(req.params.memoryId, 'memoryId'),
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.patch('/api/bots/:botId/memories/:memoryId', async (req, res) => {
    try {
      const runtime = runtimeService('memoryRuntime', memoryRuntime);
      if (!runtime) throw Object.assign(new Error('Bot memory is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await runtime.editMemory(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        validateUuid(req.params.memoryId, 'memoryId'),
        req.body,
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots/:botId/memories/merge', async (req, res) => {
    try {
      const runtime = runtimeService('memoryRuntime', memoryRuntime);
      if (!runtime) throw Object.assign(new Error('Bot memory is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await runtime.mergeMemories(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        req.body,
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  for (const operation of ['tombstone', 'restore']) {
    app.post(`/api/bots/:botId/memories/:memoryId/${operation}`, async (req, res) => {
      try {
        const runtime = runtimeService('memoryRuntime', memoryRuntime);
        if (!runtime) throw Object.assign(new Error('Bot memory is unavailable'), {
          code: 'bots_unavailable', statusCode: 503,
        });
        const method = operation === 'tombstone' ? 'tombstoneMemory' : 'restoreMemory';
        return res.json(await runtime[method](
          req.principal,
          validateUuid(req.params.botId, 'botId'),
          validateUuid(req.params.memoryId, 'memoryId'),
          req.body,
        ));
      } catch (error) {
        return botRouteError(res, error);
      }
    });
  }

  app.post('/api/bots/:botId/memory-index/rebuild', async (req, res) => {
    try {
      const runtime = runtimeService('memoryRuntime', memoryRuntime);
      if (!runtime) throw Object.assign(new Error('Bot memory is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      assertExactObject(req.body, { label: 'Bot memory index rebuild', required: [] });
      return res.status(202).json(await runtime.rebuildIndex(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.get('/api/bots/:botId/library-sources', async (req, res) => {
    try {
      const botId = validateUuid(req.params.botId, 'botId');
      const runtime = runtimeService('libraryRuntime', libraryRuntime);
      if (!runtime) {
        await requireManagerWithoutRuntime(req.principal, botId, 'Bot Library is unavailable');
        return res.json({
          available: false,
          state: 'runtime_unavailable',
          code: getExecutionFailure()?.code || 'bot_runtime_execution_unavailable',
          sources: [],
          nextCursor: null,
        });
      }
      return res.json(await runtime.listForManager(
        req.principal,
        botId,
        { cursor: req.query?.cursor || null, limit: req.query?.limit },
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.get('/api/bots/:botId/computer-files', async (req, res) => {
    try {
      assertExactObject(req.query || {}, {
        label: 'Bot computer-files query',
        optional: ['path'],
      });
      const requestedPath = validateComputerFilesPath(req.query?.path);
      const botId = validateUuid(req.params.botId, 'botId');
      const runtime = runtimeService('libraryRuntime', libraryRuntime);
      if (!runtime) {
        await requireManagerWithoutRuntime(
          req.principal,
          botId,
          'Bot computer files are unavailable',
        );
        return res.json({
          available: false,
          state: 'runtime_unavailable',
          code: getExecutionFailure()?.code || 'bot_runtime_execution_unavailable',
          scope: req.principal?.role === 'admin' ? 'container' : 'workspace',
          rootLabel: req.principal?.role === 'admin' ? 'Computer' : 'Workspace',
          path: '',
          entries: [],
          truncated: false,
        });
      }
      return res.json(await runtime.listComputerFiles(
        req.principal,
        botId,
        { path: requestedPath },
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.get('/api/bots/:botId/computer-resources', async (req, res) => {
    try {
      const runtime = runtimeService('computerResources', computerResources);
      if (!runtime) throw Object.assign(new Error('Bot computer resources are unavailable'), {
        code: 'bot_computer_resources_unavailable', statusCode: 503,
      });
      return res.json(await runtime.list(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots/:botId/computer-resources/import', async (req, res) => {
    try {
      const runtime = runtimeService('computerResources', computerResources);
      if (!runtime) throw Object.assign(new Error('Bot computer resources are unavailable'), {
        code: 'bot_computer_resources_unavailable', statusCode: 503,
      });
      return res.status(201).json(await runtime.importPath(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        req.body,
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.get('/api/bots/:botId/environment-secrets', async (req, res) => {
    try {
      const runtime = runtimeService('environmentSecrets', environmentSecrets);
      if (!runtime) throw Object.assign(new Error('Bot environment secrets are unavailable'), {
        code: 'bot_environment_secrets_unavailable', statusCode: 503,
      });
      return res.json(await runtime.list(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.put('/api/bots/:botId/environment-secrets/:name', async (req, res) => {
    try {
      const runtime = runtimeService('environmentSecrets', environmentSecrets);
      if (!runtime) throw Object.assign(new Error('Bot environment secrets are unavailable'), {
        code: 'bot_environment_secrets_unavailable', statusCode: 503,
      });
      return res.json(await runtime.put(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        req.params.name,
        req.body || {},
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.delete('/api/bots/:botId/environment-secrets/:name', async (req, res) => {
    try {
      const runtime = runtimeService('environmentSecrets', environmentSecrets);
      if (!runtime) throw Object.assign(new Error('Bot environment secrets are unavailable'), {
        code: 'bot_environment_secrets_unavailable', statusCode: 503,
      });
      return res.json(await runtime.remove(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        req.params.name,
        req.body || {},
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots/:botId/library-sources/scan', async (req, res) => {
    try {
      const runtime = runtimeService('libraryRuntime', libraryRuntime);
      if (!runtime) throw Object.assign(new Error('Bot Library is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await runtime.scanImport(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        req.body,
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots/:botId/library-sources/:sourceId/scan', async (req, res) => {
    try {
      const runtime = runtimeService('libraryRuntime', libraryRuntime);
      if (!runtime) throw Object.assign(new Error('Bot Library is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await runtime.scanRefresh(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        validateUuid(req.params.sourceId, 'sourceId'),
        req.body,
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots/:botId/library-scans/:scanId/publish', async (req, res) => {
    try {
      const runtime = runtimeService('libraryRuntime', libraryRuntime);
      if (!runtime) throw Object.assign(new Error('Bot Library is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.status(201).json(await runtime.publishScan(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        validateUuid(req.params.scanId, 'scanId'),
        req.body,
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.get('/api/bots/:botId/library-versions/:versionId', async (req, res) => {
    try {
      const runtime = runtimeService('libraryRuntime', libraryRuntime);
      if (!runtime) throw Object.assign(new Error('Bot Library is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await runtime.getVersionForManager(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        validateUuid(req.params.versionId, 'versionId'),
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots/:botId/library-index/rebuild', async (req, res) => {
    try {
      const runtime = runtimeService('libraryRuntime', libraryRuntime);
      if (!runtime) throw Object.assign(new Error('Bot Library is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      assertExactObject(req.body, { label: 'Bot Library index rebuild', required: [] });
      return res.status(202).json(await runtime.rebuildIndex(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots/:botId/channel', async (req, res) => {
    try {
      if (!channels) throw Object.assign(new Error('Bot channels are unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      const channel = await channels.getOrCreateOwnerChannel({
        principal: req.principal,
        botId: validateUuid(req.params.botId, 'botId'),
      });
      return res.json({ channel });
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.get('/api/bot-channels/:channelId/messages', async (req, res) => {
    try {
      if (!channels) throw Object.assign(new Error('Bot channels are unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      const page = await channels.listMessages({
        principal: req.principal,
        channelId: validateUuid(req.params.channelId, 'channelId'),
        cursor: req.query?.cursor || null,
        limit: req.query?.limit,
        breakGlassReason: req.headers?.['x-devryan-break-glass-reason'] || null,
      });
      return res.json(page);
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.delete('/api/bot-channels/:channelId', async (req, res) => {
    try {
      const runtime = runtimeService('memoryRuntime', memoryRuntime);
      if (!runtime) throw Object.assign(new Error('Bot memory is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      const result = await runtime.deleteChannel(
        req.principal,
        validateUuid(req.params.channelId, 'channelId'),
        req.body,
      );
      runtimeService('dispatcher', dispatcher)?.invalidateChannel?.(req.params.channelId);
      return res.json(result);
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bot-channels/:channelId/messages', async (req, res) => {
    const startedAt = performance.now();
    const stages = new Map();
    const setServerTiming = () => {
      stages.set('total', Math.max(0, performance.now() - startedAt));
      res.setHeader('Server-Timing', [...stages]
        .map(([name, durationMs]) => `${name};dur=${durationMs.toFixed(1)}`)
        .join(', '));
    };
    try {
      const runtime = runtimeService('dispatcher', dispatcher);
      if (!runtime) throw Object.assign(new Error('Bot dispatcher is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      const result = await runtime.enqueueMessage({
        principal: req.principal,
        channelId: validateUuid(req.params.channelId, 'channelId'),
        message: req.body,
        timing: (name, durationMs) => stages.set(name, durationMs),
      });
      setServerTiming();
      return res.status(202).json(result);
    } catch (error) {
      setServerTiming();
      return botRouteError(res, error);
    }
  });

  app.post('/api/bot-channels/:channelId/prewarm', async (req, res) => {
    try {
      const runtime = runtimeService('dispatcher', dispatcher);
      if (!runtime || typeof runtime.prewarmChannel !== 'function') {
        throw Object.assign(new Error('Bot prewarm is unavailable'), {
          code: 'bots_unavailable', statusCode: 503,
        });
      }
      assertExactObject(req.body, { label: 'Bot channel prewarm', required: [] });
      return res.json(await runtime.prewarmChannel({
        principal: req.principal,
        channelId: validateUuid(req.params.channelId, 'channelId'),
      }));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.delete('/api/bot-channels/:channelId/prewarm/:leaseId', async (req, res) => {
    try {
      const runtime = runtimeService('dispatcher', dispatcher);
      if (!runtime || typeof runtime.releasePrewarm !== 'function') {
        throw Object.assign(new Error('Bot prewarm is unavailable'), {
          code: 'bots_unavailable', statusCode: 503,
        });
      }
      return res.json(await runtime.releasePrewarm({
        principal: req.principal,
        channelId: validateUuid(req.params.channelId, 'channelId'),
        leaseId: validateUuid(req.params.leaseId, 'leaseId'),
      }));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.get('/api/bot-runs/:runId/status', async (req, res) => {
    try {
      const runtime = runtimeService('dispatcher', dispatcher);
      if (!runtime) throw Object.assign(new Error('Bot dispatcher is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      const run = await runtime.getRunStatus({
        principal: req.principal,
        runId: validateUuid(req.params.runId, 'runId'),
      });
      return res.json({ run });
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bot-runs/:runId/cancel', async (req, res) => {
    try {
      const runtime = runtimeService('dispatcher', dispatcher);
      if (!runtime) throw Object.assign(new Error('Bot dispatcher is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      const run = await runtime.cancelRun({
        principal: req.principal,
        runId: validateUuid(req.params.runId, 'runId'),
      });
      return res.json({ run });
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bot-runs/:runId/retry', async (req, res) => {
    try {
      const runtime = runtimeService('dispatcher', dispatcher);
      if (!runtime || typeof runtime.retryRun !== 'function') {
        throw Object.assign(new Error('Bot run retry is unavailable'), {
          code: 'bots_unavailable', statusCode: 503,
        });
      }
      assertExactObject(req.body, { label: 'Bot run retry', required: [] });
      const run = await runtime.retryRun({
        principal: req.principal,
        runId: validateUuid(req.params.runId, 'runId'),
      });
      return res.status(202).json({ run });
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.get('/api/bot-actions/pending', async (req, res) => {
    try {
      if (!approvalService) throw Object.assign(new Error('Bot approvals are unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await approvalService.listPending({
        principal: req.principal,
        limit: req.query?.limit === undefined ? 100 : Number(req.query.limit),
      }));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bot-actions/:actionId/decision', async (req, res) => {
    try {
      if (!approvalService) throw Object.assign(new Error('Bot approvals are unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      const result = await approvalService.decide({
        principal: req.principal,
        actionAttemptId: validateUuid(req.params.actionId, 'actionId'),
        request: req.body,
      });
      return res.json(result);
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.get('/api/bot-actions/:actionId', async (req, res) => {
    try {
      if (!actionGateway) throw Object.assign(new Error('Bot actions are unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await actionGateway.getAction({
        principal: req.principal,
        actionAttemptId: validateUuid(req.params.actionId, 'actionId'),
      }));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bot-actions/:actionId/reconcile', async (req, res) => {
    try {
      if (!actionGateway) throw Object.assign(new Error('Bot actions are unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await actionGateway.reconcile({
        principal: req.principal,
        actionAttemptId: validateUuid(req.params.actionId, 'actionId'),
        request: req.body,
      }));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.get('/api/bot-actions/:actionId/evidence/:objectId', async (req, res) => {
    try {
      if (!actionGateway || !evidenceService) {
        throw Object.assign(new Error('Bot evidence is unavailable'), {
          code: 'bots_unavailable', statusCode: 503,
        });
      }
      const actionAttemptId = validateUuid(req.params.actionId, 'actionId');
      const { action } = await actionGateway.getAction({
        principal: req.principal,
        actionAttemptId,
      });
      const result = await evidenceService.download({
        principal: req.principal,
        botId: action.botId,
        actionAttemptId,
        objectId: validateUuid(req.params.objectId, 'objectId'),
      });
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Length', String(result.bytes.byteLength));
      res.setHeader('Cache-Control', 'private, no-store');
      return res.send(result.bytes);
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.get('/api/bots/:botId/computer/status', async (req, res) => {
    try {
      if (!browserService) throw Object.assign(new Error('Bot computer is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await browserService.status({
        principal: req.principal,
        botId: validateUuid(req.params.botId, 'botId'),
      }));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  for (const operation of ['take', 'heartbeat', 'return']) {
    app.post(`/api/bots/:botId/computer/control/${operation}`, async (req, res) => {
      try {
        if (!browserService) throw Object.assign(new Error('Bot computer is unavailable'), {
          code: 'bots_unavailable', statusCode: 503,
        });
        assertExactObject(req.body, {
          label: `Bot computer control ${operation}`,
          required: operation === 'take' ? [] : ['leaseId'],
        });
        const method = operation === 'take'
          ? 'takeControl'
          : operation === 'heartbeat'
            ? 'heartbeatControl'
            : 'returnControl';
        return res.json(await browserService[method]({
          principal: req.principal,
          botId: validateUuid(req.params.botId, 'botId'),
          ...(operation === 'take' ? {} : { leaseId: req.body.leaseId }),
        }));
      } catch (error) {
        return botRouteError(res, error);
      }
    });
  }

  app.post('/api/bots/:botId/computer/control/command', async (req, res) => {
    try {
      if (!browserService) throw Object.assign(new Error('Bot computer is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      assertExactObject(req.body, {
        label: 'Bot human computer command',
        required: ['leaseId', 'command', 'args'],
      });
      return res.json({
        result: await browserService.humanCommand({
          principal: req.principal,
          botId: validateUuid(req.params.botId, 'botId'),
          leaseId: req.body.leaseId,
          command: req.body.command,
          args: req.body.args,
        }),
      });
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots/:botId/computer/view', async (req, res) => {
    try {
      if (!browserService) throw Object.assign(new Error('Bot computer is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      assertExactObject(req.body, { label: 'Bot computer view', required: ['channelId'] });
      return res.status(201).json(await browserService.startComputerView({
        principal: req.principal,
        botId: validateUuid(req.params.botId, 'botId'),
        channelId: validateUuid(req.body.channelId, 'channelId'),
      }));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.get('/api/bots/:botId/computer/view/:viewId/stream', async (req, res) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once?.('close', abort);
    const botId = req.params.botId;
    const viewId = req.params.viewId;
    try {
      if (!browserService) throw Object.assign(new Error('Bot computer is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      const upstream = await browserService.openComputerView({
        principal: req.principal,
        botId: validateUuid(botId, 'botId'),
        viewId,
        signal: controller.signal,
      });
      res.status?.(200);
      res.setHeader(
        'Content-Type',
        upstream.headers.get('content-type') || 'multipart/x-mixed-replace; boundary=devryan-bot-jpeg',
      );
      res.setHeader('Cache-Control', 'private, no-store, no-transform');
      res.setHeader('X-DevRyan-Frames-Recorded', 'false');
      res.flushHeaders?.();
      const reader = upstream.body.getReader();
      while (!controller.signal.aborted && !res.writableEnded && !res.destroyed) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise((resolve) => {
            const finish = () => {
              res.off?.('drain', finish);
              res.off?.('close', finish);
              controller.signal.removeEventListener('abort', finish);
              resolve();
            };
            res.once('drain', finish);
            res.once('close', finish);
            controller.signal.addEventListener('abort', finish, { once: true });
          });
        }
      }
      await reader.cancel().catch(() => undefined);
      return res.end?.();
    } catch (error) {
      if (res.headersSent) return res.end?.();
      return botRouteError(res, error);
    } finally {
      req.off?.('close', abort);
      controller.abort();
      if (browserService) {
        await browserService.stopComputerView({
          principal: req.principal,
          botId,
          viewId,
        }).catch(() => undefined);
      }
    }
  });

  app.delete('/api/bots/:botId/computer/view/:viewId', async (req, res) => {
    try {
      if (!browserService) throw Object.assign(new Error('Bot computer is unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await browserService.stopComputerView({
        principal: req.principal,
        botId: validateUuid(req.params.botId, 'botId'),
        viewId: req.params.viewId,
      }));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots/:botId/channels/:channelId/objects', async (req, res) => {
    let bytes = null;
    try {
      const input = validateObjectUploadRequest(req.body);
      bytes = input.bytes;
      const object = await blobStore.uploadPrivate({
        principal: req.principal,
        botId: validateUuid(req.params.botId, 'botId'),
        channelId: validateUuid(req.params.channelId, 'channelId'),
        contentType: input.contentType,
        bytes,
        provenance: input.provenance,
      });
      return res.status(201).json({ object: publicBotObject(object) });
    } catch (error) {
      return botRouteError(res, error);
    } finally {
      bytes?.fill(0);
    }
  });

  app.get('/api/bots/:botId/channels/:channelId/shared-files', async (req, res) => {
    try {
      const service = runtimeService('sharedFileService', sharedFileService);
      if (!service) throw Object.assign(new Error('Bot Shared files are unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json(await service.listChannel({
        principal: req.principal,
        botId: validateUuid(req.params.botId, 'botId'),
        channelId: validateUuid(req.params.channelId, 'channelId'),
      }));
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots/:botId/channels/:channelId/shared-files/:id/retry', async (req, res) => {
    try {
      assertExactObject(req.body || {}, { label: 'Bot Shared retry', required: [] });
      const service = runtimeService('sharedFileService', sharedFileService);
      if (!service) throw Object.assign(new Error('Bot Shared files are unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      return res.json({
        sharedFile: await service.retry({
          principal: req.principal,
          botId: validateUuid(req.params.botId, 'botId'),
          channelId: validateUuid(req.params.channelId, 'channelId'),
          sharedFileId: validateUuid(req.params.id, 'sharedFileId'),
        }),
      });
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.get('/api/bots/:botId/objects/:objectId', async (req, res) => {
    try {
      const result = await blobStore.download({
        principal: req.principal,
        botId: validateUuid(req.params.botId, 'botId'),
        objectId: validateUuid(req.params.objectId, 'objectId'),
        breakGlassReason: req.headers?.['x-devryan-break-glass-reason'] || null,
      });
      res.setHeader('Content-Type', result.object.content_type);
      res.setHeader('Content-Length', String(result.bytes.byteLength));
      res.setHeader('Cache-Control', 'no-store');
      return res.send(result.bytes);
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.delete('/api/bots/:botId/objects/:objectId', async (req, res) => {
    try {
      const result = await blobStore.deleteObject({
        principal: req.principal,
        botId: validateUuid(req.params.botId, 'botId'),
        objectId: validateUuid(req.params.objectId, 'objectId'),
      });
      return res.status(result.cleanupRequired ? 202 : 200).json({
        object: publicBotObject(result.object),
        storageDeleted: result.storageDeleted,
        cleanupRequired: result.cleanupRequired,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      });
    } catch (error) {
      return botRouteError(res, error);
    }
  });

  app.post('/api/bots/:botId/objects/:objectId/publish', async (req, res) => {
    try {
      const runtime = runtimeService('artifactService', artifactService);
      if (!runtime) throw Object.assign(new Error('Bot artifacts are unavailable'), {
        code: 'bots_unavailable', statusCode: 503,
      });
      const input = validatePublishObjectRequest(req.body);
      return res.status(201).json(await runtime.publishPrivate(
        req.principal,
        validateUuid(req.params.botId, 'botId'),
        validateUuid(req.params.objectId, 'objectId'),
        input,
      ));
    } catch (error) {
      return botRouteError(res, error);
    }
  });
}

const botRouteError = (res, error, fallbackStatus = 500) => {
  const migration = productionBotsMigrationFailurePayload(error);
  if (migration) return res.status(migration.status).json({
    error: migration.error,
    code: migration.code,
    requiredMigration: migration.requiredMigration,
  });
  if (error?.details && typeof error?.code === 'string') {
    return res.status(error.statusCode || 400).json({
      error: error.message,
      code: error.code,
      details: error.details,
    });
  }
  return jsonError(res, error, fallbackStatus);
};
