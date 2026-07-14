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
    })
  )));

  app.post('/api/orchestration/task/:taskId/acknowledge', parseJson, run(async (request) => (
    await runtime.handleRpc({
      method: 'acknowledge',
      params: {
        ...(request.body ?? {}),
        taskId: request.params.taskId,
      },
    })
  )));
};
