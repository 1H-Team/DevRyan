const writeError = (response, error) => {
  const hasCode = typeof error?.code === 'string' && error.code.length > 0;
  const statusCode = Number.isSafeInteger(error?.statusCode)
    && error.statusCode >= 400
    && error.statusCode <= 599
    ? error.statusCode
    : 500;
  response.status(statusCode).json({
    ok: false,
    error: {
      code: hasCode ? error.code : 'managed_orchestration_error',
      message: hasCode && error instanceof Error
        ? error.message
        : 'Managed orchestration request failed',
    },
  });
};

const queryString = (value) => (typeof value === 'string' ? value.trim() : '');

export const captureRequiredCheckUserAuthority = async (request, scope, options) => {
  const owner = options.connection.authenticateLocalOwner(request);
  const principal = owner ?? (request.headers.cookie ? await options.resolvePrincipal(request) : null);
  const local = principal?.scope === 'local-admin'
    ? options.connection.captureAuthorization(principal) ?? options.authController?.captureAuthorization?.(principal) : null;
  // An open loopback API or a made-up cookie cannot attest a human decision.
  if (!principal?.id || principal.accountKind === 'agent_test' || !['local-admin', 'managed'].includes(principal.scope) || principal.offlineGrace || principal.scope === 'local-admin'
    && (!local || !owner && (options.authController?.enabled !== true || !options.getUiSessionToken(request)))) return null;
  const recheck = async () => {
    if (principal.scope === 'local-admin' && !await local() || !await options.ownsSession(principal, scope.rootSessionId)
      || principal.scope === 'managed' && !(await options.resolveCurrentNativeOperationContext({ principal,
        sessionID: scope.rootSessionId, directory: scope.directory }))) {
      throw Object.assign(new Error('User waiver authorization expired'), { code: 'user_waiver_required', statusCode: 403 });
    }
  };
  await recheck(); return { userId: principal.id, recheck };
};

export const authorizeObjectiveRead = async (request, scope, options) => {
  // Open local mode has already passed the application boundary used by snapshot reads.
  if (!options.enabled) return true;
  const principal = request.principal ?? await options.resolvePrincipal?.(request);
  if (!principal) return false;
  if (principal.scope === 'local-admin') {
    const recheck = options.connection.captureAuthorization(principal) ?? options.authController?.captureAuthorization?.(principal);
    return Boolean(recheck && await recheck());
  }
  return principal.scope === 'managed' && await options.ownsSession(principal, scope.rootSessionId)
    && Boolean(await options.resolveCurrentNativeOperationContext({ principal, sessionID: scope.rootSessionId, directory: scope.directory }));
};

export const registerManagedOrchestrationRoutes = (app, options = {}) => {
  const runtime = options.runtime;
  const express = options.express;
  if (!runtime || typeof runtime.getSnapshot !== 'function' || typeof runtime.handleRpc !== 'function') {
    throw new TypeError('managed orchestration runtime is required');
  }
  if (!express || typeof express.json !== 'function') {
    throw new TypeError('express runtime is required');
  }
  const jsonParser = express.json({ limit: options.jsonLimit ?? '128kb' });
  const parseJson = (request, response, next) => {
    jsonParser(request, response, (error) => {
      if (!error) {
        next();
        return;
      }
      const tooLarge = error?.type === 'entity.too.large' || error?.status === 413;
      writeError(response, Object.assign(
        new Error(tooLarge ? 'Request body is too large' : 'Request body is invalid JSON'),
        {
          code: tooLarge ? 'body_too_large' : 'invalid_json',
          statusCode: tooLarge ? 413 : 400,
        },
      ));
    });
  };
  const run = (handler) => async (request, response) => {
    try {
      response.json(await handler(request));
    } catch (error) {
      writeError(response, error);
    }
  };

  app.get('/api/orchestration/snapshot', run(async (request) => {
    const rootSessionId = queryString(request.query?.rootSessionId);
    return await runtime.getSnapshot(rootSessionId ? { rootSessionId } : {});
  }));

  app.post('/api/orchestration/handoff', parseJson, run(async (request) => (
    await runtime.handleRpc({
      method: 'handoff',
      params: request.body ?? {},
    })
  )));

  app.get('/api/orchestration/task/:taskId', run(async (request) => (
    await runtime.handleRpc({
      method: 'status',
      params: {
        taskId: request.params.taskId,
        rootSessionId: queryString(request.query?.rootSessionId),
        directory: queryString(request.query?.directory),
      },
    })
  )));

  app.post('/api/orchestration/task/:taskId/cancel', parseJson, run(async (request) => (
    await runtime.handleRpc({
      method: 'cancel',
      params: {
        ...(request.body ?? {}),
        taskId: request.params.taskId,
      },
    }, { userStoppedRecovery: true })
  )));

  app.post('/api/orchestration/task/:taskId/auto-resume', parseJson, run(async (request) => (
    await runtime.handleRpc({
      method: 'set_auto_resume',
      params: {
        ...(request.body ?? {}),
        taskId: request.params.taskId,
      },
    })
  )));

  app.post('/api/orchestration/task/:taskId/acknowledge', parseJson, run(async (request) => (
    await runtime.handleRpc({
      method: 'acknowledge',
      params: {
        ...(request.body ?? {}),
        taskId: request.params.taskId,
      },
    }, { userStoppedRecovery: true })
  )));

  const objectiveAuthority = async (request, scope) => {
    const authority = await options.authorizeUserWaiver?.(request, scope);
    if (!authority || typeof authority.userId !== 'string' || typeof authority.recheck !== 'function')
      throw Object.assign(new Error('An authenticated UI user must access verification'), { code: 'user_waiver_required', statusCode: 403 });
    if (typeof options.currentObjective !== 'function') throw Object.assign(new Error('Current objective unavailable'), { code: 'objective_unavailable', statusCode: 409 });
    const recheck = async () => {
      await authority.recheck();
      const objectiveId = await options.currentObjective(scope);
      if (!objectiveId || scope.objectiveId && scope.objectiveId !== objectiveId)
        throw Object.assign(new Error('Current objective changed'), { code: 'objective_changed', statusCode: 409 });
      return objectiveId;
    };
    return { authority, recheck };
  };
  app.get('/api/orchestration/objective/verification', run(async request => {
    const scope = { rootSessionId: queryString(request.query?.rootSessionId), directory: queryString(request.query?.directory) };
    const authorize = async () => {
      if (typeof options.authorizeObjectiveRead !== 'function' || !await options.authorizeObjectiveRead(request, scope))
        throw Object.assign(new Error('Session access required'), { code: 'objective_read_forbidden', statusCode: 403 });
    };
    await authorize();
    if (typeof options.currentObjective !== 'function') throw Object.assign(new Error('Current objective unavailable'), { code: 'objective_unavailable', statusCode: 409 });
    const objectiveId = await options.currentObjective(scope);
    if (!objectiveId) throw Object.assign(new Error('Current objective unavailable'), { code: 'objective_unavailable', statusCode: 409 });
    const expectedObjectiveId = queryString(request.query?.expectedObjectiveId);
    if (expectedObjectiveId && expectedObjectiveId !== objectiveId) throw Object.assign(new Error('Current objective changed'), { code: 'objective_changed', statusCode: 409 });
    const originatingMessageId = queryString(request.query?.originatingMessageId);
    let capturedTurn;
    const checkTurn = async () => {
      if (!originatingMessageId) return;
      const turn = await options.currentObjectiveTurn?.(scope);
      if (!turn || turn.objectiveId !== objectiveId || turn.userMessageId !== originatingMessageId)
        throw Object.assign(new Error('Current objective turn changed'), { code: 'objective_changed', statusCode: 409 });
      if (capturedTurn && (capturedTurn.owner !== turn.owner || capturedTurn.cancellationGeneration !== turn.cancellationGeneration
        || capturedTurn.executionGeneration !== turn.executionGeneration))
        throw Object.assign(new Error('Current objective turn changed'), { code: 'objective_changed', statusCode: 409 });
      capturedTurn = turn;
    };
    await checkTurn();
    const verification = await runtime.getObjectiveVerification({ ...scope, objectiveId });
    await authorize();
    if (await options.currentObjective(scope) !== objectiveId) throw Object.assign(new Error('Current objective changed'), { code: 'objective_changed', statusCode: 409 });
    await checkTurn();
    return { objectiveId, verification, ...(originatingMessageId ? { originatingMessageId } : {}) };
  }));
  app.post('/api/orchestration/objective/verification/waive', parseJson, run(async request => {
    const params = { ...(request.body ?? {}) };
    delete params.taskId;
    if (typeof params.objectiveId !== 'string' || !params.objectiveId) throw Object.assign(new Error('Objective required'), { code: 'objective_unavailable', statusCode: 400 });
    const grant = await objectiveAuthority(request, params);
    await grant.recheck();
    return runtime.waiveRequiredChecks(params, { userId: grant.authority.userId, recheck: async () => { await grant.recheck(); } });
  }));

  app.post('/api/orchestration/task/:taskId/verification/waive', parseJson, run(async request => {
    const params = { ...(request.body ?? {}), taskId: request.params.taskId };
    const authority = await options.authorizeUserWaiver?.(request, params);
    if (!authority || typeof authority.userId !== 'string' || typeof authority.recheck !== 'function') {
      throw Object.assign(new Error('An authenticated UI user must waive verification'), { code: 'user_waiver_required', statusCode: 403 });
    }
    await authority.recheck();
    return runtime.waiveRequiredChecks(params, authority);
  }));
};
