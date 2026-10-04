import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { withExecutionAdmission } from './execution-admission.js';
import { createPrimaryRecoveryController } from './provider-recovery.js';
import { recoveryError, inspectRecoveryTurn, RECOVERY_CONTINUATION, RECOVERY_READ_TOOLS } from './provider-recovery-policy.js';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function createPrimaryRecoveryManagedAdapter(rpc) {
  return {
    managedBarrier: (rootSessionId) => rpc({ method: 'barrier_status', params: { rootSessionId } }),
    verifyRecoveredCollection: (record, collection) => rpc({ method: 'verify_recovered_collection', params: {
      taskId: collection.taskId, claimantId: collection.claimantId,
      rootSessionId: record.sessionID, directory: record.directory,
    } }),
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
  const promptContext = new AsyncLocalStorage();
  let recoveredInputOwner;
  const recoveredIdentity = value => {
    if (!object(value) || Object.keys(value).length !== 3
      || Object.keys(value).some(key => !['revision','messageID','payloadHash'].includes(key))
      || typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision)
      || typeof value.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.payloadHash)
      || typeof value.messageID !== 'string' || value.messageID.length > 256 || !/^msg_[A-Za-z0-9]+$/.test(value.messageID)) {
      throw recoveryError('recovered_input_identity_required', 400);
    }
    return { revision: value.revision, messageID: value.messageID, payloadHash: value.payloadHash };
  };
  const recoverySnapshot = async (id, snapshot) => ({ ...(snapshot ?? await controller.getSnapshot(id)),
    recoveredInput: await recoveredInputOwner?.snapshot(id) });
  const gen2Client = () => {
    const client = typeof options.openCodeClient === 'function' ? options.openCodeClient() : options.openCodeClient;
    const generation = typeof client?.generation === 'function' ? client.generation() : undefined;
    if (generation !== 2) throw recoveryError('opencode_generation_invalid', 503);
    return client;
  };
  const requestDomain = async (client, pathname, directory, init) => {
    const url = new URL(pathname, 'http://recovery.invalid');
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
    let bytes = 0;
    const readOptions = { directory, signal, timeoutMs: 5000, maxResponseBytes: 16 * 1024 * 1024,
      onResponseRead: ({ phase, bytes: count }) => {
        if (phase !== 'chunk') return;
        bytes += count;
        // One domain operation can read several wire pages for projection.
        if (bytes > 16 * 1024 * 1024) throw recoveryError('recovery_response_too_large', 503);
      } };
    const match = url.pathname.match(/^\/session\/([^/]+)(?:\/(message|todo|abort|prompt_async))?$/);
    let data, cursor;
    try {
      if (url.pathname === '/global/health') {
        const health = await client.health.probe(readOptions);
        data = { healthy: health?.ready === true, version: health?.version };
      } else if (url.pathname === '/api/info') {
        data = await client.health.runtimeInfo(readOptions);
      } else if (url.pathname === '/session/status') data = await client.sessions.status({ directory }, readOptions);
      else if (url.pathname === '/permission') data = await client.interaction.permissions.list({ directory }, readOptions);
      else if (url.pathname === '/question') data = await client.interaction.questions.list({ directory }, readOptions);
      else if (url.pathname === '/experimental/tool/ids') data = (await client.catalog.tools({ directory }, readOptions))?.ids;
      else if (match) {
        const [, id, action] = match;
        if (!action) data = await client.sessions.get(id, readOptions);
        else if (action === 'message') {
          const page = await client.sessions.messages(id, { limit: Number(url.searchParams.get('limit')) || 100,
            before: url.searchParams.get('before') ?? undefined }, readOptions);
          data = page.records; cursor = page.cursor;
        } else if (action === 'todo') data = await client.sessions.todo(id, readOptions);
        else if (action === 'abort') data = await client.sessions.abort(id, readOptions);
        else data = await client.prompts.prompt(id, JSON.parse(init.body), { ...readOptions,
          ...(init.primaryAdmission ? { beforePromptDispatch: (receipt, context) => admitNativePrompt(receipt, { ...init.primaryAdmission, ...context }),
            onPromptDispatchFailure: (receipt) => controller.markPromptDispatchUncertain(receipt) } : {}) });
      } else throw recoveryError('recovery_observation_unavailable', 503);
      signal.throwIfAborted();
      const projectedBytes = Buffer.byteLength(JSON.stringify(data ?? null));
      if (projectedBytes > 16 * 1024 * 1024) throw recoveryError('recovery_response_too_large', 503);
      return { data, cursor, bytes: Math.max(bytes, projectedBytes) };
    } catch (cause) {
      if (cause?.code === 'opencode_runtime_changed' || cause?.code === 'opencode_generation_invalid') throw cause;
      if (cause?.code === 'opencode_response_too_large') throw recoveryError('recovery_response_too_large', 503);
      if (cause?.code?.startsWith('recovery_')) throw cause;
      throw Object.assign(recoveryError('recovery_observation_unavailable', 503), { upstreamStatus: cause?.statusCode, cause });
    }
  };
  const request = async (pathname, directory, init = {}) => {
    const client = gen2Client();
    return requestDomain(client, pathname, directory, init);
  };
  const session = async (id, directory, init) => {
    if (!/^ses_[a-zA-Z0-9]+$/.test(id)) throw recoveryError('invalid_session_id', 400);
    // Only the session route itself can prove the session is gone.
    const { data } = await request(`/session/${id}`, directory, init).catch((error) => {
      if (error?.upstreamStatus === 404) error.sessionMissing = true;
      throw error;
    });
    if (!object(data) || data.id !== id || typeof data.directory !== 'string') throw recoveryError('invalid_session_observation');
    return data;
  };
  const observeTurn = async (record, init = {}) => {
    const { includeTodos, includeExecutionOutcomes, ...requestInit } = init;
    const started = Date.now();
    const messages = [];
    let cursor;
    let complete = false;
    const seen = new Set();
    let totalBytes = 0;
    // A bound is a failure, never proof that a partial transcript is complete.
    while (!complete && messages.length < 10_000 && Date.now() - started < 15_000) {
      const query = new URLSearchParams({ limit: '100', ...(cursor ? { before: cursor } : {}) });
      const { data, cursor: nextCursor, bytes } = await request(`/session/${record.sessionID}/message?${query}`, record.directory, requestInit)
        .catch(async (error) => {
          // The transcript route answers first; only the session route can
          // confirm the session itself is gone.
          if (error?.upstreamStatus === 404) await session(record.sessionID, record.directory, requestInit);
          throw error;
        });
      totalBytes += bytes;
      if (totalBytes > 32 * 1024 * 1024) throw recoveryError('recovery_transcript_too_large');
      if (!Array.isArray(data) || data.some((m) => !object(m.info) || !Array.isArray(m.parts))) {
        throw recoveryError('invalid_message_observation');
      }
      messages.unshift(...data);
      complete = messages.some((m) => m.info.id === record.anchorID && m.info.role === 'user');
      cursor = nextCursor;
      if (!cursor || seen.has(cursor)) break;
      seen.add(cursor);
    }
    const [currentSession, statuses, permissions, questions, barrier, todos] = await Promise.all([
      session(record.sessionID, record.directory, requestInit), request('/session/status', record.directory, requestInit),
      request('/permission', record.directory, requestInit), request('/question', record.directory, requestInit),
      options.managedBarrier(record.sessionID),
      includeTodos ? request(`/session/${record.sessionID}/todo`, record.directory, requestInit) : null,
    ]);
    if (!object(statuses.data) || Object.values(statuses.data).some((s) => !object(s) || !['idle', 'busy', 'retry'].includes(s.type))
      || !Array.isArray(permissions.data) || !Array.isArray(questions.data) || !object(barrier) || typeof barrier.state !== 'string') {
      throw recoveryError('invalid_live_observation');
    }
    // OpenCode 1.18.25 removes idle entries from a successful status map. A
    // missing entry alone is insufficient: existence, transcript and blockers
    // are independently checked here and by inspectRecoveryTurn.
    const blockedByRequests = [...permissions.data, ...questions.data].some((p) => p.sessionID === record.sessionID);
    const failedCalls = messages.filter(message => message.info.role === 'assistant')
      .flatMap(message => message.parts.filter(part => part.type === 'tool' && part.state?.status === 'error')
        .map(part => ({ messageID: message.info.id, callID: part.callID })));
    // Missing/expired evidence leaves the existing uncertainty fence intact;
    // evidence that could not be READ (e.g. a busy ledger) is reported so a
    // collection is retried instead of fenced permanently.
    let executionOutcomesUnavailable = false;
    const executionOutcomes = includeExecutionOutcomes && failedCalls.length && options.executionOutcomes
      ? await withExecutionAdmission({ sessionID: record.sessionID },
        () => options.executionOutcomes({ directory: record.directory, sessionID: record.sessionID, calls: failedCalls }),
        { timeoutMs: 4000, signal: init.signal }).catch(() => { executionOutcomesUnavailable = true; return []; }) : [];
    return { session: currentSession, messages, complete, blockedByRequests, managedBarrierState: barrier.state,
      executionOutcomes, executionOutcomesUnavailable,
      ...(includeTodos ? { todos: todos?.data } : {}),
      status: statuses.data[record.sessionID]?.type ?? 'idle',
      blocked: barrier.state !== 'clear' || blockedByRequests };
  };
  // A slow ownership store (e.g. Supabase) must not hold an explicit user
  // continuation open; an unanswered authorization denies it.
  const authorizeWithin = async (record, timeoutMs) => {
    let timer;
    try {
      return await Promise.race([Promise.resolve(options.authorize(record)).catch(() => false),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
    } finally { clearTimeout(timer); }
  };
  const abortSession = (r) => request(`/session/${r.sessionID}/abort`, r.directory, { method: 'POST', body: '{}' });
  const controller = createPrimaryRecoveryController({
    directory: path.join(options.dataDirectory, 'harness', 'provider-recovery'),
    mode: options.mode ?? process.env.DEVRYAN_PRIMARY_RECOVERY_MODE,
    anthropicMode: options.anthropicMode ?? process.env.DEVRYAN_ANTHROPIC_RECOVERY_MODE,
    isAnthropicConformant: options.isAnthropicConformant,
    progressTimeoutMs: options.progressTimeoutMs ?? (process.env.DEVRYAN_PROVIDER_PROGRESS_TIMEOUT_MS === '0' ? false
      : process.env.DEVRYAN_PROVIDER_PROGRESS_TIMEOUT_MS ? Number(process.env.DEVRYAN_PROVIDER_PROGRESS_TIMEOUT_MS) : undefined),
    isManaged: options.isManaged, authorize: options.authorize, classifyFailure: options.classifyFailure,
    isNativeFallbackError: options.isNativeFallbackError,
    publishEvent: (event, context) => {
      const properties = event?.properties;
      // Controller publication runs under durable owner locks. It has no native
      // inventory authority and must never call the child to enrich this event.
      const projected = object(properties?.recovery) ? { ...event, properties: { ...properties,
        recovery: { ...properties.recovery, recoveredInputPartial: true } } } : event;
      return options.publishEvent?.(projected, context);
    }, recordIncident: options.recordIncident,
    observeTurn, abortSession, verifyRecoveredCollection: options.verifyRecoveredCollection,
    verifyOwnedNativeContinuation: options.verifyOwnedNativeContinuation,
    isNativeRecoveryDispatchPending: (record, liveDispatch) => recoveredInputOwner?.isRecoveryDispatchPending?.(record, liveDispatch) ?? false,
    getToolPolicy: async (record) => {
      const { data } = await request('/experimental/tool/ids', record.directory);
      if (!Array.isArray(data) || data.length > 4096 || data.some((id) => typeof id !== 'string' || id.length > 256)) throw recoveryError('recovery_tool_catalog_unavailable');
      return { toolIDs: data, allowedReadTools: RECOVERY_READ_TOOLS.filter((id) => data.filter((candidate) => candidate === id).length === 1) };
    },
    promptSession: (r, body) => {
      gen2Client();
      if (r.executionGeneration !== 2) throw recoveryError('recovery_execution_selection_uncertain');
      if (r.recoveryExecution) {
        if(typeof options.dispatchNativeRecovery !== 'function')throw recoveryError('native_fallback_dispatch_owner_required');
        return options.dispatchNativeRecovery(r,body);
      }
      return request(`/session/${r.sessionID}/prompt_async`, r.directory,
      { method: 'POST', body: JSON.stringify(body) });
    },
  });
  const initialization = controller.initialize();
  // Called only by the trusted gen-2 admission owner after accepted selection.
  // This context carries request ownership without a session/global authority map.
  const admitNativePrompt = async (receipt, explicitContext) => {
    const reserved = await controller.readRecord(receipt.sessionID);
    if (!receipt.queuedAfterChildren && reserved?.executionGeneration === 2 && reserved.recoveryID === receipt.messageID && reserved.recoveryExecution) {
      const captured = await controller.captureNativeRecoveryDispatch({sessionID:receipt.sessionID,directory:receipt.directory,messageID:receipt.messageID});
      const expected = captured.record.recoveryExecution;
      if (!['recovery_reserved','recovering'].includes(reserved.state) || ['providerID','modelID','agent','variant'].some(key => receipt.execution?.[key] !== expected[key])
        || receipt.body?.agent !== expected.agent || receipt.body?.model?.providerID !== expected.providerID || receipt.body?.model?.modelID !== expected.modelID
        || receipt.body?.variant !== expected.variant || receipt.directory !== reserved.directory
        || JSON.stringify(receipt.body?.parts) !== JSON.stringify(reserved.recoveryPrompt?.parts)
        || JSON.stringify(receipt.body?.tools) !== JSON.stringify(reserved.recoveryPrompt?.tools)
        || !await options.authorize(reserved)) throw recoveryError('native_fallback_fenced');
      await captured.recheck();return;
    }
    if (!receipt.queuedAfterChildren && reserved?.nativeContinuation?.messageID === receipt.messageID) {
      const captured = await controller.captureNativeContinuationDispatch({sessionID:receipt.sessionID,directory:receipt.directory,
        messageID:receipt.messageID});
      if (receipt.execution?.providerID !== captured.record.providerID || receipt.execution?.modelID !== captured.record.modelID
        || receipt.execution?.agent !== captured.record.agent || receipt.execution?.variant !== captured.record.variant
        || receipt.body?.agent !== captured.prompt.agent || receipt.body?.model?.providerID !== captured.prompt.model.providerID
        || receipt.body?.model?.modelID !== captured.prompt.model.modelID || receipt.body?.variant !== captured.prompt.variant
        || (receipt.objectiveID ?? receipt.body?.objectiveID) !== captured.prompt.objectiveID
        || JSON.stringify(receipt.body?.tools) !== JSON.stringify(captured.prompt.tools)
        || !Array.isArray(receipt.body?.parts) || receipt.body.parts.length !== captured.prompt.parts.length
        || receipt.body.parts.some((part,index)=>!object(part) || Object.keys(part).some(key=>!['type','text','synthetic'].includes(key))
          || part.type!=='text' || part.synthetic!==true || part.text!==captured.prompt.parts[index].text)) throw recoveryError('native_primary_continuation_fenced');
      await captured.recheck(); return;
    }
    const context = { ...promptContext.getStore(), ...explicitContext };
    if (!options.isManaged() || (!explicitContext&&!promptContext.getStore()) || receipt.parentID || (context.sessionID !== undefined && context.sessionID !== receipt.sessionID)) return;
    // Preserve the existing opt-out for implicit/non-primary admissions.
    // An already tracked objective still requires explicit execution selection.
    if (!receipt.queuedAfterChildren && (!receipt.body?.agent || !receipt.body.model?.providerID || !receipt.body.model?.modelID)) {
      return controller.admit({ sessionID: receipt.sessionID, directory: receipt.directory, primary: true,
        owner: context.owner, body: receipt.body }, context.authorizeWrite);
    }
    if (!receipt.execution || !receipt.directory) throw recoveryError('recovery_execution_selection_required', 409);
    const execution = receipt.execution;
    if (![execution.providerID, execution.modelID, execution.agent, execution.variant].every(value => typeof value === 'string' && value.length > 0)) {
      throw recoveryError('recovery_execution_selection_required', 409);
    }
    await controller.admit({ sessionID: receipt.sessionID, directory: receipt.directory, primary: !receipt.parentID,
      owner: context.owner, objectiveID: context.objectiveID ?? receipt.objectiveID, executionGeneration: 2,
      body: { ...receipt.body, messageID: receipt.messageID, agent: execution.agent,
        model: { providerID: execution.providerID, modelID: execution.modelID }, variant: execution.variant } }, context.authorizeWrite);
  };
  const withPromptAdmissionContext = (method, rawPath, context, action) => {
    const match = new URL(rawPath, 'http://recovery.invalid').pathname.match(/^\/api\/session\/([^/]+)\/(prompt_async|message)$/);
    return method === 'POST' && match && gen2Client()
      ? promptContext.run({ sessionID: match[1], owner: context.owner }, action) : action();
  };

  return { ...controller, admitNativePrompt, withPromptAdmissionContext,
    async authorizeRecoveredInputOwner(record) {
      if (!await authorizeWithin(record, 5000)) throw recoveryError('native_recovered_input_fenced', 403);
    },
    // Constructor-only attachment; plugin and HTTP payloads cannot replace it.
    setRecoveredInputOwner(adapter) {
      if (!object(adapter) || ['has','snapshot','details','action'].some(key => typeof adapter[key] !== 'function')) {
        throw new TypeError('Recovered input owner required');
      }
      recoveredInputOwner = adapter;
    },
    requiresNativePromptSelection: () => options.isManaged() && Boolean(promptContext.getStore()),
    markNativePromptUncertain: (receipt) => controller.markPromptDispatchUncertain(receipt),
    // Constructor-owned native Step handoff only. This is deliberately absent
    // from plugin/RPC actions: a caller-supplied transport cannot bypass full
    // readiness. The pinned canonical native version binds step identity; it
    // does not assert readiness or enable provider transport recovery.
    async helloNative({ policyVersion, instanceID }, owner) {
      gen2Client();
      const { data } = await request('/api/info');
      if (!object(data) || data.version !== '2.0.20') throw recoveryError('recovery_runtime_unverified');
      return controller.plugin({ action: 'hello', policyVersion, instanceID,
        transport: 'native-v2', version: data.version }, undefined, undefined, owner);
    },
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
      const match = url.pathname.replace(/^\/api(?=\/)/, '').match(/^\/session\/([^/]+)\/(prompt_async|message|abort|recovery(?:\/(?:cancel|continue|intent|input|resume-input|discard-input))?)$/);
      if (!match) return null;
      const [, id, action] = match;
      if (method === 'GET' && !['recovery','recovery/input'].includes(action)) return null;
      if (method === 'POST' && action === 'recovery/input') return null;
      if (!['GET', 'POST'].includes(method)) return null;
      try {
        await initialization;
        if (!/^ses_[a-zA-Z0-9]+$/.test(id)) throw recoveryError('invalid_session_id', 400);
        // Auth/ownership is enforced by the host router. Durable status and
        // cancellation remain available while the OpenCode transport is down.
        if (action === 'recovery' && method === 'GET') return { status: 200, body: await recoverySnapshot(id) };
        if (action === 'recovery/input') {
          if (['revision','messageID','payloadHash'].some(key => url.searchParams.getAll(key).length !== 1)) {
            throw recoveryError('recovered_input_identity_required', 400);
          }
          const identity = recoveredIdentity(Object.fromEntries(['revision','messageID','payloadHash'].map(key => [key,url.searchParams.get(key)])));
          if (!recoveredInputOwner) throw recoveryError('recovered_input_unavailable');
          return { status: 200, body: await recoveredInputOwner.details(id, identity) };
        }
        if (['recovery/resume-input','recovery/discard-input'].includes(action)) {
          const identity = recoveredIdentity(body);
          if (!recoveredInputOwner) throw recoveryError('recovered_input_unavailable');
          await recoveredInputOwner.action(id, action.slice('recovery/'.length), identity, { owner: context.owner });
          return { status: 200, body: await recoverySnapshot(id) };
        }
        const snapshot = await controller.getSnapshot(id);
        if (action === 'abort' && !snapshot.record) return null;
        if (action.startsWith('recovery/')) {
          if (['recovery/intent','recovery/continue'].includes(action) && recoveredInputOwner?.has(id)) {
            throw recoveryError('recovered_input_pending');
          }
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
            const collectBlockedResult = Boolean(stored.collectionIssue && observed.blockedByRequests === false
              && observed.managedBarrierState === 'awaiting_acknowledgement');
            if (observed.status !== 'idle' || check.superseded || (observed.blocked && !collectBlockedResult) || executing || !check.last?.info.time?.completed) throw recoveryError('provider_stop_unconfirmed');
            if (!/^msg_[a-zA-Z0-9]+$/.test(body.messageID ?? '') || !await authorizeWithin(stored, 5000)) throw recoveryError('recovery_continuation_unavailable');
            await controller.control(id, 'supersede', body.revision);
            gen2Client();
            if (stored.executionGeneration !== 2) throw recoveryError('recovery_execution_selection_uncertain');
            const prompt = { messageID: body.messageID, model: { providerID: stored.providerID, modelID: stored.modelID },
              agent: stored.agent, ...(stored.variant ? { variant: stored.variant } : {}), tools: stored.tools,
              parts: [{ type: 'text', text: `${collectBlockedResult ? 'Continue from the existing progress and completed tool results.' : RECOVERY_CONTINUATION} The user has now explicitly requested continuation with the original execution permissions. Review any uncertain outcomes before taking further action.${collectBlockedResult ? ` Collect and disposition the existing managed result for ${stored.collectionIssue.taskId} using devryan_task wait, then continue the unfinished objective. Do not repeat the completed child.` : ''}` }] };
            // Explicit user action, still a single POST. A lost acknowledgement
            // must be reconciled through GET, never silently retried.
            await request(`/session/${id}/prompt_async`, stored.directory, { method: 'POST', body: JSON.stringify(prompt),
              primaryAdmission: { owner: stored.owner, objectiveID: stored.objectiveID ?? stored.anchorID } });
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
            : { status: 200, body: await recoverySnapshot(id, { ...cancelled, stopConfirmed: false }) };
        }
        return null;
      } catch (error) {
        return { status: Number.isSafeInteger(error?.statusCode) ? error.statusCode : 503,
          body: { code: error?.code ?? 'provider_recovery_unavailable', error: 'Provider recovery safeguards could not confirm this operation.' } };
      }
    },
  };
}
