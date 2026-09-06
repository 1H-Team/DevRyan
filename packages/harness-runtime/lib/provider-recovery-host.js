import path from 'node:path';
import { createPrimaryRecoveryController } from './provider-recovery.js';
import { recoveryError, inspectRecoveryTurn, RECOVERY_CONTINUATION, RECOVERY_READ_TOOLS } from './provider-recovery-policy.js';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function createPrimaryRecoveryManagedAdapter(rpc) {
  return {
    managedBarrier: (rootSessionId) => rpc({ method: 'barrier_status', params: { rootSessionId } }),
    async cancelDescendants(rootSessionId) {
      const snapshot = await rpc({ method: 'snapshot', params: { rootSessionId } });
      if (!Array.isArray(snapshot?.tasks)) throw recoveryError('managed_stop_unconfirmed');
      for (const task of snapshot.tasks) {
        if (!['queued', 'starting', 'running'].includes(task.status)) continue;
        await rpc({ method: 'cancel', params: { taskId: task.taskId, rootSessionId,
          directory: task.directory, cascade: true, reason: 'user_stop' } });
      }
    },
  };
}

// Shared by web and Electron hosts. No renderer
// state, credentials, or OpenCode process lifecycle decisions belong here.
export function createPrimaryRecoveryHost(options) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const request = async (pathname, directory, init = {}) => {
    const url = new URL(options.buildOpenCodeUrl(pathname));
    if (directory) url.searchParams.set('directory', directory);
    const response = await fetchImpl(url, { ...init,
      headers: { 'content-type': 'application/json', ...options.getOpenCodeAuthHeaders?.() },
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
    if (!response.ok) throw recoveryError('recovery_observation_unavailable', 503);
    if (response.status === 204) return { data: null, response };
    const reader = response.body?.getReader();
    const chunks = [];
    let bytes = 0;
    if (!reader) throw recoveryError('recovery_response_unavailable', 503);
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 16 * 1024 * 1024) throw recoveryError('recovery_response_too_large', 503);
        chunks.push(value);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      return { data: text ? JSON.parse(text) : null, response, bytes };
    } finally { await reader.cancel().catch(() => {}); }
  };
  const session = async (id, directory, init) => {
    if (!/^ses_[a-zA-Z0-9]+$/.test(id)) throw recoveryError('invalid_session_id', 400);
    const { data } = await request(`/session/${id}`, directory, init);
    if (!object(data) || data.id !== id || typeof data.directory !== 'string') throw recoveryError('invalid_session_observation');
    return data;
  };
  const observeTurn = async (record, init = {}) => {
    const started = Date.now();
    const messages = [];
    let cursor;
    let complete = false;
    const seen = new Set();
    let totalBytes = 0;
    // A bound is a failure, never proof that a partial transcript is complete.
    while (!complete && messages.length < 10_000 && Date.now() - started < 15_000) {
      const query = new URLSearchParams({ limit: '100', ...(cursor ? { before: cursor } : {}) });
      const { data, response, bytes } = await request(`/session/${record.sessionID}/message?${query}`, record.directory, init);
      totalBytes += bytes;
      if (totalBytes > 32 * 1024 * 1024) throw recoveryError('recovery_transcript_too_large');
      if (!Array.isArray(data) || data.some((m) => !object(m.info) || !Array.isArray(m.parts))) {
        throw recoveryError('invalid_message_observation');
      }
      messages.unshift(...data);
      complete = messages.some((m) => m.info.id === record.anchorID && m.info.role === 'user');
      cursor = response.headers.get('x-next-cursor');
      if (!cursor || seen.has(cursor)) break;
      seen.add(cursor);
    }
    const [currentSession, statuses, permissions, questions, barrier] = await Promise.all([
      session(record.sessionID, record.directory, init), request('/session/status', record.directory, init),
      request('/permission', record.directory, init), request('/question', record.directory, init),
      options.managedBarrier(record.sessionID),
    ]);
    if (!object(statuses.data) || Object.values(statuses.data).some((s) => !object(s) || !['idle', 'busy', 'retry'].includes(s.type))
      || !Array.isArray(permissions.data) || !Array.isArray(questions.data) || !object(barrier) || typeof barrier.state !== 'string') {
      throw recoveryError('invalid_live_observation');
    }
    // OpenCode 1.18.25 removes idle entries from a successful status map. A
    // missing entry alone is insufficient: existence, transcript and blockers
    // are independently checked here and by inspectRecoveryTurn.
    return { session: currentSession, messages, complete,
      status: statuses.data[record.sessionID]?.type ?? 'idle',
      blocked: barrier.state !== 'clear' || [...permissions.data, ...questions.data].some((p) => p.sessionID === record.sessionID) };
  };
  const abortSession = (r) => request(`/session/${r.sessionID}/abort`, r.directory, { method: 'POST', body: '{}' });
  const controller = createPrimaryRecoveryController({
    directory: path.join(options.dataDirectory, 'harness', 'provider-recovery'),
    mode: options.mode ?? process.env.DEVRYAN_PRIMARY_RECOVERY_MODE ?? 'observe',
    progressTimeoutMs: options.progressTimeoutMs ?? (process.env.DEVRYAN_PROVIDER_PROGRESS_TIMEOUT_MS === '0' ? false
      : process.env.DEVRYAN_PROVIDER_PROGRESS_TIMEOUT_MS ? Number(process.env.DEVRYAN_PROVIDER_PROGRESS_TIMEOUT_MS) : undefined),
    isManaged: options.isManaged, authorize: options.authorize,
    publishEvent: options.publishEvent, recordIncident: options.recordIncident,
    observeTurn, abortSession,
    getToolPolicy: async (record) => {
      const { data } = await request('/experimental/tool/ids', record.directory);
      if (!Array.isArray(data) || data.length > 4096 || data.some((id) => typeof id !== 'string' || id.length > 256)) throw recoveryError('recovery_tool_catalog_unavailable');
      return { toolIDs: data, allowedReadTools: RECOVERY_READ_TOOLS.filter((id) => data.filter((candidate) => candidate === id).length === 1) };
    },
    promptSession: (r, body) => request(`/session/${r.sessionID}/prompt_async`, r.directory,
      { method: 'POST', body: JSON.stringify(body) }),
  });
  const initialization = controller.initialize();

  return { ...controller,
    async plugin(input) {
      if (input.action !== 'hello') return controller.plugin(input);
      const { data } = await request('/global/health');
      if (!object(data) || data.healthy !== true || typeof data.version !== 'string') throw recoveryError('recovery_runtime_unverified');
      return controller.plugin({ ...input, version: data.version });
    },
    // Returns null to continue the ordinary proxy; otherwise returns a local
    // response. Both hosts use this exact path, including their Stop endpoint.
    async handleRequest(method, rawPath, body, context = {}) {
      const url = new URL(rawPath, 'http://recovery.invalid');
      const match = url.pathname.replace(/^\/api(?=\/)/, '').match(/^\/session\/([^/]+)\/(prompt_async|message|abort|recovery(?:\/(?:cancel|continue|intent))?)$/);
      if (!match) return null;
      const [, id, action] = match;
      if (method === 'GET' && action !== 'recovery') return null;
      if (!['GET', 'POST'].includes(method)) return null;
      try {
        await initialization;
        if (!/^ses_[a-zA-Z0-9]+$/.test(id)) throw recoveryError('invalid_session_id', 400);
        // Auth/ownership is enforced by the host router. Durable status and
        // cancellation remain available while the OpenCode transport is down.
        if (action === 'recovery' && method === 'GET') return { status: 200, body: await controller.getSnapshot(id) };
        const snapshot = await controller.getSnapshot(id);
        if (action === 'abort' && !snapshot.record) return null;
        if (action.startsWith('recovery/')) {
          if (!object(body) || !Number.isSafeInteger(body.revision) || body.revision < 1) throw recoveryError('recovery_revision_required', 400);
          if (action === 'recovery/intent') {
            if (snapshot.record && ['recovering', 'recovery_reserved', 'stopping'].includes(snapshot.record.state)) throw recoveryError('recovery_in_progress');
            return { status: 200, body: await controller.control(id, 'intent', body.revision) };
          }
          if (action === 'recovery/continue') {
            // Explicit continuation releases admission only after live settlement.
            // The UI sends a NEW ordinary user prompt with its normal restrictions.
            if (!snapshot.record || snapshot.record.revision !== body.revision) throw recoveryError('recovery_revision_conflict');
            const stored = await controller.readRecord(id);
            const observed = await observeTurn(stored);
            const check = inspectRecoveryTurn(stored, observed);
            const executing = observed.messages.some((m) => m.parts.some((p) => p.type === 'tool'
              && !['completed', 'error'].includes(p.state?.status)));
            if (observed.status !== 'idle' || observed.blocked || executing || !check.last?.info.time?.completed) throw recoveryError('provider_stop_unconfirmed');
            if (!/^msg_[a-zA-Z0-9]+$/.test(body.messageID ?? '') || !await options.authorize(stored)) throw recoveryError('recovery_continuation_unavailable');
            await controller.control(id, 'supersede', body.revision);
            const prompt = { messageID: body.messageID, model: { providerID: stored.providerID, modelID: stored.modelID },
              agent: stored.agent, ...(stored.variant ? { variant: stored.variant } : {}), tools: stored.tools,
              parts: [{ type: 'text', text: `${RECOVERY_CONTINUATION} The user has now explicitly requested continuation with the original execution permissions. Review any uncertain outcomes before taking further action.` }] };
            await controller.admit({ sessionID: id, directory: stored.directory, primary: true, owner: stored.owner, body: prompt });
            // Explicit user action, still a single POST. A lost acknowledgement
            // must be reconciled through GET, never silently retried.
            await request(`/session/${id}/prompt_async`, stored.directory, { method: 'POST', body: JSON.stringify(prompt) });
            return { status: 200, body: await controller.getSnapshot(id) };
          }
        }
        if (action === 'abort' || action === 'recovery/cancel') {
          const cancelled = await controller.control(id, 'stop', action === 'abort' ? undefined : body.revision);
          const stored = await controller.readRecord(id);
          if (!stored) throw recoveryError('provider_stop_unconfirmed');
          const stops = await Promise.allSettled([options.cancelDescendants?.(id),
            abortSession({ sessionID: id, directory: stored.directory })]);
          if (stops.some((stop) => stop.status === 'rejected')) throw recoveryError('provider_stop_unconfirmed');
          // Acknowledges a durable cancellation fence, not model settlement.
          return action === 'abort' ? { status: 200, body: true }
            : { status: 200, body: { ...cancelled, stopConfirmed: false } };
        }
        if (method === 'POST' && ['prompt_async', 'message'].includes(action)) {
          const currentSession = await session(id, url.searchParams.get('directory'));
          await controller.admit({ sessionID: id, directory: currentSession.directory,
            primary: !currentSession.parentID, owner: context.owner, body });
        }
        return null;
      } catch (error) {
        return { status: Number.isSafeInteger(error?.statusCode) ? error.statusCode : 503,
          body: { code: error?.code ?? 'provider_recovery_unavailable', error: 'Provider recovery safeguards could not confirm this operation.' } };
      }
    },
  };
}
