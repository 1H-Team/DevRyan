import {
  createHarnessError,
  createHarnessSuccess,
  createHarnessWarning,
  withHarnessResult,
} from './harness-result.js';
import { isDeepStrictEqual } from 'node:util';
import { canReadSettingsPage } from '../multi-user/policy.js';

const sanitizeModel = (model) => {
  if (typeof model === 'string') return model;
  if (!model || typeof model !== 'object' || Array.isArray(model)) return undefined;
  const providerID = typeof model.providerID === 'string' ? model.providerID : undefined;
  const modelID = typeof model.modelID === 'string' ? model.modelID : undefined;
  return providerID && modelID ? { providerID, modelID } : undefined;
};

export const sanitizeAgentRuntimeMetadata = (agent) => {
  const sanitized = { name: String(agent?.name || '') };
  const model = sanitizeModel(agent?.model);
  if (model) sanitized.model = model;
  if (Object.prototype.hasOwnProperty.call(agent || {}, 'variant')) {
    sanitized.variant = typeof agent.variant === 'string' ? agent.variant : null;
  }
  if (Array.isArray(agent?.modelRefs)) {
    sanitized.modelRefs = agent.modelRefs.filter((entry) => typeof entry === 'string' && entry.trim());
  }
  if (Array.isArray(agent?.councillors)) {
    sanitized.councillors = agent.councillors.flatMap((entry) => {
      const councillorModel = sanitizeModel(entry?.model);
      if (!councillorModel) return [];
      return [{
        model: councillorModel,
        ...(Object.prototype.hasOwnProperty.call(entry || {}, 'variant')
          ? { variant: typeof entry.variant === 'string' ? entry.variant : null }
          : {}),
      }];
    });
  }
  if (agent?.modelResolution && typeof agent.modelResolution === 'object' && !Array.isArray(agent.modelResolution)) {
    const source = ['root-override', 'preset', 'root'].includes(agent.modelResolution.source)
      ? agent.modelResolution.source
      : null;
    if (source) {
      sanitized.modelResolution = {
        presetName: typeof agent.modelResolution.presetName === 'string' ? agent.modelResolution.presetName : null,
        source,
        presetModelRef: typeof agent.modelResolution.presetModelRef === 'string' ? agent.modelResolution.presetModelRef : null,
        presetVariant: typeof agent.modelResolution.presetVariant === 'string' ? agent.modelResolution.presetVariant : null,
      };
    }
  }
  return sanitized;
};

const canReadFullAgentConfig = (principal) => (
  !principal
  || principal.scope === 'local-admin'
  || principal.role === 'admin'
  || canReadSettingsPage(principal, 'agents')
);

export const registerConfigEntityRoutes = (app, dependencies) => {
  const {
    resolveProjectDirectory,
    resolveOptionalProjectDirectory,
    markConfigChange,
    getAgentSources,
    getAgentConfig,
    listAgentModelOverrides,
    listStaleAgentModelOverrides,
    writeAgentModelOverride,
    deleteAgentModelOverride,
    writeAgentBackupModel,
    deleteAgentBackupModel,
    listConfigAgents,
    getCommandSources,
    createCommand,
    updateCommand,
    deleteCommand,
    listMcpConfigs,
    getMcpConfig,
    createMcpConfig,
    updateMcpConfig,
    deleteMcpConfig,
    recoverMcpConfigs,
  } = dependencies;
  const listStaleOverrides = typeof listStaleAgentModelOverrides === 'function'
    ? listStaleAgentModelOverrides
    : () => [];
  const formatErrorMessage = (error, fallback) => (
    error instanceof Error && error.message ? error.message : fallback
  );
  const getAgentModelRef = (agentConfig) => {
    const modelRefs = Array.isArray(agentConfig?.modelRefs) ? agentConfig.modelRefs : [];
    const firstModelRef = modelRefs.find((entry) => typeof entry === 'string' && entry.trim());
    if (firstModelRef) return firstModelRef.trim();

    const model = agentConfig?.model;
    if (typeof model === 'string' && model.trim()) return model.trim();
    if (model && typeof model === 'object' && !Array.isArray(model)) {
      const providerID = typeof model.providerID === 'string' ? model.providerID.trim() : '';
      const modelID = typeof model.modelID === 'string' ? model.modelID.trim() : '';
      if (providerID && modelID) return `${providerID}/${modelID}`;
    }

    return undefined;
  };
  const getAgentRuntimeExpectation = (agent) => {
    const config = agent?.config && typeof agent.config === 'object' && !Array.isArray(agent.config)
      ? agent.config
      : null;
    if (!config) return {};
    return {
      expectedAgentModelRef: getAgentModelRef(config),
      ...(Object.prototype.hasOwnProperty.call(config, 'variant') ? { expectedAgentVariant: config.variant } : {}),
    };
  };
  const authResetWarningFields = (mutationResult, existingWarning = null) => {
    const authReset = mutationResult?.authReset;
    if (!authReset || authReset.ok !== false) {
      return existingWarning ? { warning: existingWarning } : {};
    }
    const authWarning = authReset.warning || authReset.error || 'MCP OAuth cache could not be reset';
    return {
      authResetFailed: true,
      warning: [existingWarning, authWarning].filter(Boolean).join(' '),
    };
  };
  const sendMcpMutationError = (res, payload, {
    statusCode = 400,
    summary,
    nextActions = [],
    rootCauseHint,
    safeRetry,
    stopCondition,
    retryable = true,
  }) => res.status(statusCode).json(withHarnessResult(payload, createHarnessError({
    summary,
    nextActions,
    recovery: {
      rootCauseHint,
      safeRetry,
      stopCondition,
      retryable,
    },
  })));

  app.get('/api/config/agents', async (req, res) => {
    try {
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      const fullAccess = canReadFullAgentConfig(req.principal);
      const agents = listConfigAgents(directory);
      res.json({
        agents: fullAccess ? agents : agents.map(sanitizeAgentRuntimeMetadata),
        staleOverrides: fullAccess ? listStaleOverrides(directory) : [],
      });
    } catch (error) {
      console.error('Failed to list project agents:', error);
      res.status(500).json({ error: 'Failed to list project agents' });
    }
  });

  app.get('/api/config/agent-overrides', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return sendMcpMutationError(res, { error }, {
          summary: 'MCP recovery failed',
          rootCauseHint: error,
          safeRetry: 'Retry with a valid project directory or without a directory filter',
          stopCondition: 'Stop if the requested project directory is unavailable',
          retryable: false,
        });
      }
      res.json({
        overrides: listAgentModelOverrides(),
        staleOverrides: directory ? listStaleOverrides(directory) : [],
      });
    } catch (error) {
      console.error('Failed to list agent model overrides:', error);
      res.status(500).json({ error: 'Failed to list agent model overrides' });
    }
  });

  const completeMcpMutation = async (res, action, name, applyChange) => {
    const mutationResult = applyChange();
    const authResetFields = authResetWarningFields(mutationResult);

    try {
      const applyResult = await markConfigChange(
        `mcp ${action}`,
        {},
        mutationResult?.changed !== false,
      );
      return res.json(withHarnessResult({
        success: true,
        ...applyResult,
        message: applyResult.runtimeMessage || `MCP server "${name}" ${action}d. Changes are pending.`,
        ...authResetFields,
      }, createHarnessSuccess({
        summary: `MCP server "${name}" ${action} completed`,
        nextActions: ['Apply the pending configuration before testing the MCP server'],
        artifacts: [name],
      })));
    } catch (error) {
      console.error(`[API:MCP ${action}] Reload failed after config write:`, error);
      const reloadWarning = formatErrorMessage(error, 'The configuration change could not be queued for apply');
      return res.json(withHarnessResult({
        success: true,
        requiresReload: false,
        reloadFailed: true,
        message: `MCP server "${name}" ${action}d, but the apply request could not be recorded.`,
        ...authResetWarningFields(mutationResult, reloadWarning),
      }, createHarnessWarning({
        summary: `MCP server "${name}" ${action} completed with reload warning`,
        nextActions: ['Reload OpenCode before relying on the changed MCP server'],
        artifacts: [name],
        recovery: {
          rootCauseHint: reloadWarning,
          safeRetry: 'Retry OpenCode reload after checking MCP configuration',
          stopCondition: 'Stop if OpenCode still cannot reload with the changed MCP config',
          retryable: true,
        },
      })));
    }
  };

  const completeAgentOverrideMutation = async (res, reason, agentName, payload, shouldRefresh = true) => {
    try {
      const applyResult = await markConfigChange(reason, {
        agentName,
        ...getAgentRuntimeExpectation(payload?.agent),
      }, shouldRefresh);
      return res.json({
        ...payload,
        ...applyResult,
      });
    } catch (error) {
      console.error(`[API:Agent override] Reload failed after ${reason}:`, error);
      return res.json({
        ...payload,
        requiresReload: false,
        runtimeApplied: false,
        reloadFailed: true,
        warning: formatErrorMessage(error, 'The agent change could not be queued for apply'),
      });
    }
  };

  app.get('/api/config/agents/:name', async (req, res) => {
    try {
      const agentName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }
      const sources = getAgentSources(agentName, directory);

      const scope = sources.md.exists
        ? sources.md.scope
        : (sources.json.exists ? sources.json.scope : null);

      res.json({
        name: agentName,
        sources: sources,
        scope,
        source: scope,
        isPackaged: scope === 'packaged',
        isBuiltIn: scope === 'packaged',
      });
    } catch (error) {
      console.error('Failed to get agent sources:', error);
      res.status(500).json({ error: 'Failed to get agent configuration metadata' });
    }
  });

  app.get('/api/config/agents/:name/config', async (req, res) => {
    try {
      const agentName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      const configInfo = getAgentConfig(agentName, directory);
      res.json(configInfo);
    } catch (error) {
      console.error('Failed to get agent config:', error);
      res.status(500).json({ error: 'Failed to get agent configuration' });
    }
  });

  app.put('/api/config/agents/:name/override', async (req, res) => {
    try {
      const agentName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      const previousAgent = getAgentConfig(agentName, directory);
      const override = writeAgentModelOverride(agentName, req.body || {}, directory);
      const agent = getAgentConfig(agentName, directory);
      return completeAgentOverrideMutation(
        res,
        `agent ${agentName} model override`,
        agentName,
        { success: true, override, agent },
        !isDeepStrictEqual(previousAgent?.config, agent?.config),
      );
    } catch (error) {
      console.error('Failed to write agent model override:', error);
      const message = formatErrorMessage(error, 'Failed to write agent model override');
      const status = message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: message });
    }
  });

  app.delete('/api/config/agents/:name/override', async (req, res) => {
    try {
      const agentName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      const deleted = deleteAgentModelOverride(agentName, { workingDirectory: directory });
      const agent = getAgentConfig(agentName, directory);
      return completeAgentOverrideMutation(
        res,
        `agent ${agentName} model override reset`,
        agentName,
        { success: true, deleted, agent },
        deleted,
      );
    } catch (error) {
      console.error('Failed to delete agent model override:', error);
      res.status(500).json({ error: formatErrorMessage(error, 'Failed to delete agent model override') });
    }
  });

  // Backup models are DevRyan-only sidecar state (OpenCode never reads them), so
  // these routes deliberately skip markConfigChange: nothing needs an apply/restart.
  app.put('/api/config/agents/:name/backup-model', async (req, res) => {
    try {
      const agentName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }
      if (typeof writeAgentBackupModel !== 'function') {
        return res.status(501).json({ error: 'Agent backup models are not supported by this host' });
      }

      const backupModel = writeAgentBackupModel(agentName, req.body || {}, directory);
      const agent = getAgentConfig(agentName, directory);
      return res.json({ success: true, backupModel, agent });
    } catch (error) {
      console.error('Failed to write agent backup model:', error);
      const message = formatErrorMessage(error, 'Failed to write agent backup model');
      const status = message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: message });
    }
  });

  app.delete('/api/config/agents/:name/backup-model', async (req, res) => {
    try {
      const agentName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }
      if (typeof deleteAgentBackupModel !== 'function') {
        return res.status(501).json({ error: 'Agent backup models are not supported by this host' });
      }

      const deleted = deleteAgentBackupModel(agentName, { workingDirectory: directory });
      const agent = getAgentConfig(agentName, directory);
      return res.json({ success: true, deleted, backupModel: null, agent });
    } catch (error) {
      console.error('Failed to delete agent backup model:', error);
      res.status(500).json({ error: formatErrorMessage(error, 'Failed to delete agent backup model') });
    }
  });

  const rejectAgentMutation = (_req, res) => {
    res.status(405).json({
      error: 'Agent configuration is read-only. Edit project .opencode/agents/*.md files directly.',
    });
  };

  app.post('/api/config/agents/:name', rejectAgentMutation);
  app.patch('/api/config/agents/:name', rejectAgentMutation);
  app.delete('/api/config/agents/:name', rejectAgentMutation);

  app.get('/api/config/mcp', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      const configs = listMcpConfigs(directory);
      res.json(configs);
    } catch (error) {
      console.error('[API:GET /api/config/mcp] Failed:', error);
      res.status(500).json({ error: formatErrorMessage(error, 'Failed to list MCP configs') });
    }
  });

  app.post('/api/config/mcp/recover', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return sendMcpMutationError(res, { error }, {
          summary: 'MCP recovery failed',
          nextActions: ['Retry with a valid MCP project directory'],
          rootCauseHint: error,
          safeRetry: 'Retry with a valid project directory or without a directory filter',
          stopCondition: 'Stop if the requested project directory is unavailable',
          retryable: false,
        });
      }

      const result = recoverMcpConfigs(directory);
      if (result.migrated.length === 0) {
        const applyResult = await markConfigChange('mcp recovery', {}, false);
        return res.json(withHarnessResult({
          ...result,
          ...applyResult,
        }, createHarnessSuccess({
          summary: 'MCP recovery completed with no migrations',
          nextActions: [],
        })));
      }

      try {
        const applyResult = await markConfigChange('mcp recovery');
        return res.json(withHarnessResult({
          ...result,
          ...applyResult,
        }, createHarnessSuccess({
          summary: 'MCP recovery completed',
          nextActions: ['Wait for OpenCode reload before using recovered MCP servers'],
          artifacts: result.migrated.map((entry) => entry.name).filter(Boolean),
        })));
      } catch (error) {
        console.error('[API:MCP recover] Reload failed after recovery:', error);
        const message = formatErrorMessage(error, 'OpenCode reload failed after recovering MCP configuration');
        return res.json(withHarnessResult({
          ...result,
          requiresReload: false,
          reloadFailed: true,
          warning: message,
        }, createHarnessWarning({
          summary: 'MCP recovery completed with reload warning',
          nextActions: ['Reload OpenCode before using recovered MCP servers'],
          artifacts: result.migrated.map((entry) => entry.name).filter(Boolean),
          recovery: {
            rootCauseHint: message,
            safeRetry: 'Retry OpenCode reload after checking recovered MCP configs',
            stopCondition: 'Stop if OpenCode cannot reload with the recovered config',
            retryable: true,
          },
        })));
      }
    } catch (error) {
      console.error('[API:POST /api/config/mcp/recover] Failed:', error);
      const message = formatErrorMessage(error, 'Failed to recover MCP configs');
      res.status(500).json(withHarnessResult(
        { error: message },
        createHarnessError({
          summary: 'MCP recovery failed',
          nextActions: ['Check MCP config readability and retry recovery'],
          recovery: {
            rootCauseHint: message,
            safeRetry: 'Retry after MCP config files are readable',
            stopCondition: 'Stop if recovery source files cannot be read',
            retryable: true,
          },
        }),
      ));
    }
  });

  app.get('/api/config/mcp/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      const config = getMcpConfig(name, directory);
      if (!config) {
        return res.status(404).json({ error: `MCP server "${name}" not found` });
      }
      res.json(config);
    } catch (error) {
      console.error('[API:GET /api/config/mcp/:name] Failed:', error);
      res.status(500).json({ error: formatErrorMessage(error, 'Failed to get MCP config') });
    }
  });

  app.post('/api/config/mcp/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const { scope, ...config } = req.body || {};
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return sendMcpMutationError(res, { error }, {
          summary: `MCP server "${name}" create failed`,
          nextActions: ['Retry with a valid MCP project directory'],
          rootCauseHint: error,
          safeRetry: 'Retry with a valid project directory or without a directory filter',
          stopCondition: 'Stop if the requested project directory is unavailable',
          retryable: false,
        });
      }
      console.log(`[API:POST /api/config/mcp] Creating MCP server: ${name}`);

      await completeMcpMutation(res, 'create', name, () => {
        createMcpConfig(name, config, directory, scope);
      });
    } catch (error) {
      console.error('[API:POST /api/config/mcp/:name] Failed:', error);
      const message = formatErrorMessage(error, 'Failed to create MCP server');
      res.status(500).json(withHarnessResult(
        { error: message },
        createHarnessError({
          summary: `MCP server "${req.params.name}" create failed`,
          nextActions: ['Fix the MCP server payload and retry creation'],
          recovery: {
            rootCauseHint: message,
            safeRetry: 'Retry with a valid MCP server name and configuration',
            stopCondition: 'Stop if the MCP target config cannot be written',
            retryable: true,
          },
        }),
      ));
    }
  });

  app.patch('/api/config/mcp/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const updates = req.body;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return sendMcpMutationError(res, { error }, {
          summary: `MCP server "${name}" update failed`,
          nextActions: ['Retry with a valid MCP project directory'],
          rootCauseHint: error,
          safeRetry: 'Retry with a valid project directory or without a directory filter',
          stopCondition: 'Stop if the requested project directory is unavailable',
          retryable: false,
        });
      }
      console.log(`[API:PATCH /api/config/mcp] Updating MCP server: ${name}`);

      await completeMcpMutation(res, 'update', name, () => {
        updateMcpConfig(name, updates, directory);
      });
    } catch (error) {
      console.error('[API:PATCH /api/config/mcp/:name] Failed:', error);
      const message = formatErrorMessage(error, 'Failed to update MCP server');
      if (message === `MCP server "${req.params.name}" not found`) {
        return res.status(404).json(withHarnessResult(
          { error: message },
          createHarnessError({
            summary: `MCP server "${req.params.name}" update failed`,
            nextActions: ['Refresh MCP configuration before retrying the update'],
            recovery: {
              rootCauseHint: message,
              safeRetry: 'Retry after selecting an existing MCP server',
              stopCondition: 'Stop if the MCP server no longer exists',
              retryable: false,
            },
          }),
        ));
      }
      res.status(500).json(withHarnessResult(
        { error: message },
        createHarnessError({
          summary: `MCP server "${req.params.name}" update failed`,
          nextActions: ['Fix the MCP server payload and retry the update'],
          recovery: {
            rootCauseHint: message,
            safeRetry: 'Retry with a valid MCP server configuration',
            stopCondition: 'Stop if the MCP target config cannot be written',
            retryable: true,
          },
        }),
      ));
    }
  });

  app.delete('/api/config/mcp/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return sendMcpMutationError(res, { error }, {
          summary: `MCP server "${name}" delete failed`,
          nextActions: ['Retry with a valid MCP project directory'],
          rootCauseHint: error,
          safeRetry: 'Retry with a valid project directory or without a directory filter',
          stopCondition: 'Stop if the requested project directory is unavailable',
          retryable: false,
        });
      }
      console.log(`[API:DELETE /api/config/mcp] Deleting MCP server: ${name}`);

      await completeMcpMutation(res, 'delete', name, () => {
        deleteMcpConfig(name, directory);
      });
    } catch (error) {
      console.error('[API:DELETE /api/config/mcp/:name] Failed:', error);
      const message = formatErrorMessage(error, 'Failed to delete MCP server');
      res.status(500).json(withHarnessResult(
        { error: message },
        createHarnessError({
          summary: `MCP server "${req.params.name}" delete failed`,
          nextActions: ['Refresh MCP configuration before retrying deletion'],
          recovery: {
            rootCauseHint: message,
            safeRetry: 'Retry after selecting an existing MCP server',
            stopCondition: 'Stop if the MCP target config cannot be written',
            retryable: true,
          },
        }),
      ));
    }
  });

  app.get('/api/config/commands/:name', async (req, res) => {
    try {
      const commandName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }
      const sources = getCommandSources(commandName, directory);

      const scope = sources.md.exists
        ? sources.md.scope
        : (sources.json.exists ? sources.json.scope : null);

      res.json({
        name: commandName,
        sources: sources,
        scope,
        isBuiltIn: !sources.md.exists && !sources.json.exists
      });
    } catch (error) {
      console.error('Failed to get command sources:', error);
      res.status(500).json({ error: 'Failed to get command configuration metadata' });
    }
  });

  app.post('/api/config/commands/:name', async (req, res) => {
    try {
      const commandName = req.params.name;
      const { scope, ...config } = req.body;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      console.log('[Server] Creating command:', commandName);
      console.log('[Server] Config received:', JSON.stringify(config, null, 2));
      console.log('[Server] Scope:', scope, 'Working directory:', directory);

      createCommand(commandName, config, directory, scope);
      const applyResult = await markConfigChange('command creation', {
        commandName
      });

      res.json({
        success: true,
        ...applyResult,
        message: `Command ${commandName} created successfully. Changes are pending.`,
      });
    } catch (error) {
      console.error('Failed to create command:', error);
      res.status(500).json({ error: error.message || 'Failed to create command' });
    }
  });

  app.patch('/api/config/commands/:name', async (req, res) => {
    try {
      const commandName = req.params.name;
      const updates = req.body;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      console.log(`[Server] Updating command: ${commandName}`);
      console.log('[Server] Updates:', JSON.stringify(updates, null, 2));
      console.log('[Server] Working directory:', directory);

      const changed = updateCommand(commandName, updates, directory);
      const applyResult = await markConfigChange('command update', {}, changed);

      console.log(`[Server] Command ${commandName} updated successfully`);

      res.json({
        success: true,
        ...applyResult,
        message: `Command ${commandName} updated successfully. Changes are pending.`,
      });
    } catch (error) {
      console.error('[Server] Failed to update command:', error);
      console.error('[Server] Error stack:', error.stack);
      res.status(500).json({ error: error.message || 'Failed to update command' });
    }
  });

  app.delete('/api/config/commands/:name', async (req, res) => {
    try {
      const commandName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      deleteCommand(commandName, directory);
      const applyResult = await markConfigChange('command deletion');

      res.json({
        success: true,
        ...applyResult,
        message: `Command ${commandName} deleted successfully. Changes are pending.`,
      });
    } catch (error) {
      console.error('Failed to delete command:', error);
      res.status(500).json({ error: error.message || 'Failed to delete command' });
    }
  });
};
