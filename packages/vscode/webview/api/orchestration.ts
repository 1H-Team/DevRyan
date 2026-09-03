const DEFAULT_MAX_BODY_BYTES = 128 * 1024;

type BridgeResult = {
  status: number;
  body: unknown;
};

type SendBridge = (type: string, payload?: unknown) => Promise<unknown>;

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const errorResponse = (status: number, code: string, message: string) => jsonResponse(status, {
  ok: false,
  error: { code, message },
});

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const normalizeBridgeResult = (value: unknown): BridgeResult | null => {
  if (!isRecord(value)) return null;
  const status = value.status;
  if (!Number.isSafeInteger(status) || Number(status) < 100 || Number(status) > 599) return null;
  return { status: Number(status), body: value.body ?? null };
};

const decodeTaskId = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

const parseBody = async (readBody: (() => Promise<string>) | undefined, maxBodyBytes: number) => {
  const text = readBody ? await readBody() : '';
  if (new TextEncoder().encode(text).byteLength > maxBodyBytes) {
    return {
      response: errorResponse(413, 'body_too_large', 'Request body is too large'),
      body: null,
    };
  }
  if (!text.trim()) return { response: null, body: {} };
  try {
    const body = JSON.parse(text) as unknown;
    if (!isRecord(body)) {
      return {
        response: errorResponse(400, 'invalid_json', 'Request body must be a JSON object'),
        body: null,
      };
    }
    return { response: null, body };
  } catch {
    return {
      response: errorResponse(400, 'invalid_json', 'Request body is invalid JSON'),
      body: null,
    };
  }
};

export const handleManagedOrchestrationApiRequest = async (options: {
  url: URL;
  method: string;
  send: SendBridge;
  readBody?: () => Promise<string>;
  maxBodyBytes?: number;
}): Promise<Response | null> => {
  const method = options.method.toUpperCase();
  const pathname = options.url.pathname.replace(/\/+$/, '') || '/';
  let payload: Record<string, unknown> | null = null;

  if (pathname === '/api/orchestration/handoff') {
    if (method !== 'POST') {
      return errorResponse(405, 'method_not_allowed', 'Method not allowed');
    }
    const parsed = await parseBody(options.readBody, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
    if (parsed.response) return parsed.response;
    payload = { action: 'handoff', body: parsed.body ?? {} };
  } else if (pathname === '/api/orchestration/snapshot' && method === 'GET') {
    payload = {
      action: 'snapshot',
      rootSessionId: options.url.searchParams.get('rootSessionId')?.trim() || undefined,
    };
  } else {
    const match = pathname.match(/^\/api\/orchestration\/task\/([^/]+)(?:\/(cancel|acknowledge|auto-resume))?$/);
    if (!match) return null;
    const taskId = decodeTaskId(match[1]);
    if (!taskId) return errorResponse(400, 'invalid_request', 'Task ID is invalid');
    const action = match[2];

    if (!action && method === 'GET') {
      payload = {
        action: 'status',
        taskId,
        rootSessionId: options.url.searchParams.get('rootSessionId')?.trim() || undefined,
        directory: options.url.searchParams.get('directory')?.trim() || undefined,
      };
    } else if ((action === 'cancel' || action === 'acknowledge' || action === 'auto-resume') && method === 'POST') {
      const parsed = await parseBody(options.readBody, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
      if (parsed.response) return parsed.response;
      payload = { action: action === 'auto-resume' ? 'auto_resume' : action, taskId, body: parsed.body ?? {} };
    } else {
      return errorResponse(405, 'method_not_allowed', 'Method not allowed');
    }
  }

  try {
    const result = normalizeBridgeResult(await options.send('api:orchestration:request', payload));
    if (!result) {
      return errorResponse(502, 'invalid_bridge_response', 'Managed orchestration bridge returned an invalid response');
    }
    return jsonResponse(result.status, result.body);
  } catch {
    return errorResponse(500, 'managed_orchestration_error', 'Managed orchestration request failed');
  }
};
