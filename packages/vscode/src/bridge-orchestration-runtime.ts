import type { BridgeRequest, BridgeResponse } from './bridge';
type OrchestrationRuntime = {
  getSnapshot(options?: { rootSessionId?: string }): Promise<unknown>;
  handleRpc(request: { method: string; params?: Record<string, unknown> }): Promise<unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const optionalText = (value: unknown) => typeof value === 'string' && value.trim()
  ? value.trim()
  : undefined;

const errorResponse = (id: string, type: string, error: unknown): BridgeResponse => {
  const code = isRecord(error) && typeof error.code === 'string' && error.code
    ? error.code
    : 'managed_orchestration_error';
  const statusCode = isRecord(error)
    && Number.isSafeInteger(error.statusCode)
    && Number(error.statusCode) >= 400
    && Number(error.statusCode) <= 599
    ? Number(error.statusCode)
    : 500;
  const message = code !== 'managed_orchestration_error' && error instanceof Error
    ? error.message
    : 'Managed orchestration request failed';
  return {
    id,
    type,
    success: true,
    data: {
      status: statusCode,
      body: { ok: false, error: { code, message } },
    },
  };
};

export const handleManagedOrchestrationBridgeMessage = async (
  message: BridgeRequest,
  runtime?: OrchestrationRuntime,
): Promise<BridgeResponse | null> => {
  if (message.type !== 'api:orchestration:request') return null;
  const { id, type } = message;
  if (!runtime) {
    return errorResponse(id, type, Object.assign(new Error('Managed orchestration runtime is unavailable'), {
      code: 'managed_runtime_unavailable',
      statusCode: 503,
    }));
  }

  try {
    const payload = isRecord(message.payload) ? message.payload : {};
    const action = optionalText(payload.action);
    const rootSessionId = optionalText(payload.rootSessionId);
    const taskId = optionalText(payload.taskId);
    const body = isRecord(payload.body) ? payload.body : {};
    let result: unknown;

    if (action === 'snapshot') {
      result = await runtime.getSnapshot(rootSessionId ? { rootSessionId } : {});
    } else if (action === 'status') {
      result = await runtime.handleRpc({
        method: 'status',
        params: {
          taskId,
          rootSessionId,
          directory: optionalText(payload.directory),
        },
      });
    } else if (action === 'cancel' || action === 'acknowledge') {
      result = await runtime.handleRpc({
        method: action,
        params: {
          ...body,
          taskId,
        },
      });
    } else {
      throw Object.assign(new Error(`Unsupported managed orchestration bridge action: ${action ?? '(missing)'}`), {
        code: 'invalid_request',
        statusCode: 400,
      });
    }

    return {
      id,
      type,
      success: true,
      data: { status: 200, body: result },
    };
  } catch (error) {
    return errorResponse(id, type, error);
  }
};
