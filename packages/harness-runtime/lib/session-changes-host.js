import path from 'node:path';
import fs from 'node:fs/promises';
import { createSessionChangeRuntime } from './session-changes.js';

import { SESSION_CHANGE_READ_ONLY_TOOLS, classifySessionChangeTool, isSyntheticSessionChange,
  normalizeSessionChangeTool, sessionChangeCapturePaths, sessionChangeReceipt } from './session-changes-tools.js';

const error = (code, status = 409) => Object.assign(new Error(code), { code, status });

// Authenticated host routers own principal authorization. Plugin calls arrive
// only on the bearer-authenticated private bridge; validate their session and
// directory against OpenCode before touching the filesystem.
export function createSessionChangeHost(options) {
  const runtime = createSessionChangeRuntime({ directory: path.join(options.dataDirectory, 'harness', 'session-changes'),
    onDiagnostic: options.onDiagnostic,
    onChange: ({ directory, sessionID }) => options.publishEvent?.({ type: 'session.changes.updated', properties: { sessionID } }, { directory }),
  });
  const observations = new Map();
  const callMessages = new Map();
  const rememberCall = (directory, sessionID, callID, messageID) => {
    const key = JSON.stringify([directory, sessionID, callID]);
    callMessages.delete(key); callMessages.set(key, messageID);
    while (callMessages.size > 256) callMessages.delete(callMessages.keys().next().value);
  };
  const request = async (pathname, directory, deadline = Date.now() + 15_000) => {
    const url = new URL(options.buildOpenCodeUrl(pathname));
    if (directory) url.searchParams.set('directory', directory);
    const response = await (options.fetchImpl ?? fetch)(url, {
      headers: options.getOpenCodeAuthHeaders?.(), signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - Date.now()))),
    });
    if (!response.ok) throw error('session_observation_unavailable', response.status === 404 ? 404 : 503);
    const reader = response.body?.getReader();
    if (!reader) throw error('session_observation_unavailable', 503);
    const chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 16 * 1024 * 1024) throw error('history_limit', 503);
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    return { data: JSON.parse(Buffer.concat(chunks).toString()), bytes, cursor: response.headers.get('x-next-cursor') };
  };
  const session = async (id, directory) => {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) throw error('invalid_session_id', 400);
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw error('invalid_change_directory', 400);
    const { data } = await request(`/session/${id}`, directory);
    if (data?.id !== id || typeof data.directory !== 'string'
      || await fs.realpath(data.directory) !== await fs.realpath(directory)) throw error('session_directory_mismatch', 403);
    return data;
  };
  const tree = async (id, directory) => {
    const root = await session(id, directory);
    const entries = [root];
    const seen = new Set([id]);
    for (let i = 0; i < entries.length; i++) {
      const { data } = await request(`/session/${entries[i].id}/children`, directory);
      if (!Array.isArray(data)) throw error('invalid_session_tree', 503);
      for (const child of data) {
        if (!child?.id || child.parentID !== entries[i].id) throw error('invalid_session_lineage', 503);
        if (seen.has(child.id)) continue;
        const verified = await session(child.id, directory);
        if (verified.parentID !== entries[i].id) throw error('invalid_session_lineage', 503);
        seen.add(child.id); entries.push(verified);
      }
    }
    return entries;
  };
  const invokingCall = async (input, deadline) => {
    const known = callMessages.get(JSON.stringify([input.directory, input.sessionID, input.callID]))
      ?? await runtime.findCall(input);
    const matches = (record) => record?.info?.role === 'assistant'
      && record.parts?.some((part) => part.type === 'tool' && part.callID === input.callID);
    if (known) {
      try {
        const { data } = await request(`/session/${input.sessionID}/message/${known}`, input.directory, deadline);
        if (matches(data)) return data;
      } catch (cause) { if (cause.status !== 404) throw cause; }
    }
    let cursor = null, limit = 100;
    const seen = new Set();
    for (;;) {
      if (Date.now() >= deadline) throw error('capture_timeout', 503);
      const query = new URLSearchParams({ limit: String(limit), ...(cursor ? { before: cursor } : {}) });
      let result;
      try { result = await request(`/session/${input.sessionID}/message?${query}`, input.directory, deadline); }
      catch (cause) {
        if (cause.code === 'history_limit' && limit > 1) { limit = Math.max(1, Math.floor(limit / 2)); continue; }
        throw cause;
      }
      if (!Array.isArray(result.data)) throw error('invalid_session_history', 503);
      const record = result.data.find(matches);
      if (record) { rememberCall(input.directory, input.sessionID, input.callID, record.info.id); return record; }
      if (!result.cursor) throw error('capture_call_unresolved', 503);
      if (seen.has(result.cursor)) throw error('invalid_history_cursor', 503);
      seen.add(result.cursor); cursor = result.cursor;
    }
  };
  const history = async (verified, directory) => {
    const id = verified.id;
    await runtime.registerSession({ directory, sessionID: id, parentID: verified.parentID ?? null });
    const saved = await runtime.historyState({ directory, sessionID: id });
    const indexed = saved?.repairVersion === 1;
    const state = indexed ? { ...saved } : { complete: false, cursor: null, first: null, newestID: null, repairVersion: 1 };
    const deadline = Date.now() + 20_000;
    const seen = new Set();
    let cursor = state.complete ? null : state.cursor;
    let newestID = state.newestID;
    let limit = 100;
    const visited = new Set();
    const importRecords = async (records) => {
      const receipts = [], messages = [], terminalCalls = [];
      for (const record of records) {
        if (!record.info?.id || typeof record.info.time?.created !== 'number') throw error('invalid_session_history', 503);
        visited.add(record.info.id);
        const calls = [];
        if (record.info.sessionID && record.info.sessionID !== id) throw error('capture_identity_mismatch', 503);
        for (const part of record.parts ?? []) {
          // Native task wrappers need the private execution ledger. Bounded
          // activity previews cannot establish complete edit coverage.
          const nativeTask = normalizeSessionChangeTool(part.tool) === 'task'
            && (record.info.providerID === 'cursor-acp' || part.state?.metadata?.cursorNativeTask?.source === 'cursor-native');
          if (part.type !== 'tool' || isSyntheticSessionChange(part) || classifySessionChangeTool(part.tool) === 'read-only' && !nativeTask) continue;
          if (part.sessionID && part.sessionID !== id || part.messageID && part.messageID !== record.info.id) throw error('capture_identity_mismatch', 503);
          const callID = part.callID ?? part.id;
          if (typeof callID !== 'string' || !callID) throw error('capture_identity_mismatch', 503);
          calls.push(callID);
          rememberCall(directory, id, callID, record.info.id);
          const receipt = sessionChangeReceipt(part);
          if (receipt) receipts.push({ ...receipt, sessionID: id, callID, messageID: record.info.id,
            userMessageID: record.info.parentID, createdAt: part.state?.time?.start ?? record.info.time.created,
            directory, source: record.info.providerID === 'cursor-acp' ? 'cursor' : 'opencode' });
          if (['completed', 'error'].includes(part.state?.status)) terminalCalls.push({ directory, sessionID: id, messageID: record.info.id, callID });
        }
        messages.push({ id: record.info.id, createdAt: record.info.time.created, calls });
        if (record.info.role === 'user' && (!state.first || record.info.time.created < state.first.createdAt)) state.first = { id: record.info.id, createdAt: record.info.time.created };
      }
      await runtime.importHistorical(receipts);
      for (const call of terminalCalls) await runtime.settleHistoricalCall(call);
      return messages;
    };
    const repair = async () => {
      for (;;) {
        const page = await runtime.unresolvedHistory({ directory, sessionID: id, cursor: state.repairCursor });
        for (const entry of page.messages) {
          if (Date.now() >= deadline) { await runtime.historyState({ directory, sessionID: id, state }); return false; }
          if (!visited.has(entry.id)) {
            try {
              const { data } = await request(`/session/${id}/message/${entry.id}`, directory, deadline);
              if (data?.info?.id === entry.id) {
                const messages = await importRecords([data]);
                await runtime.historyState({ directory, sessionID: id, messages });
              }
            } catch (cause) { if (cause.status !== 404) throw cause; }
          }
          state.repairCursor = entry.cursor;
        }
        if (!page.more) state.repairCursor = null;
        await runtime.historyState({ directory, sessionID: id, state });
        if (!page.more) return true;
      }
    };
    for (;;) {
      if (Date.now() >= deadline) return { first: state.first?.id ?? null, complete: false };
      const query = new URLSearchParams({ limit: String(limit), ...(cursor ? { before: cursor } : {}) });
      let result;
      try { result = await request(`/session/${id}/message?${query}`, directory, deadline); }
      catch (cause) {
        if (cause.code === 'history_limit' && limit > 1) { limit = Math.max(1, Math.floor(limit / 2)); continue; }
        throw cause;
      }
      if (!Array.isArray(result.data)) throw error('invalid_session_history', 503);
      const messages = await importRecords(result.data);
      const reachedSavedHead = indexed && result.data.some((record) => record.info.id === saved.newestID);
      if (!cursor && result.data.length) newestID = result.data.reduce((newest, record) => record.info.time.created > newest.info.time.created ? record : newest).info.id;
      const complete = !result.cursor || Boolean(saved?.complete && reachedSavedHead);
      if (result.cursor && seen.has(result.cursor)) throw error('invalid_history_cursor', 503);
      state.complete = complete; state.cursor = complete ? null : result.cursor; state.newestID = newestID;
      await runtime.historyState({ directory, sessionID: id, state, messages });
      if (complete) return { first: state.first?.id ?? null, complete: await repair() };
      seen.add(result.cursor); cursor = result.cursor;
    }
  };
  const plugin = async (input) => {
    if (!['message', 'before', 'after'].includes(input.action)) throw error('invalid_capture_identity', 400);
    // A supplied read-only name can only skip observation. Canonical history
    // still checks every executing call and exposes any missing capture.
    if (input.action !== 'message' && typeof input.tool === 'string' && classifySessionChangeTool(input.tool) === 'read-only') return null;
    const captureDeadline = Date.now() + 30_000;
    const current = await session(input.sessionID, input.directory);
    const scope = { directory: input.directory, sessionID: input.sessionID, callID: input.callID, captureDeadline, parentID: current.parentID ?? null };
    if (input.action === 'message') {
      await runtime.registerSession({ ...scope, userMessageID: input.userMessageID });
      return { readOnlyTools: SESSION_CHANGE_READ_ONLY_TOOLS };
    }
    if (typeof input.callID !== 'string' || !input.callID) throw error('invalid_capture_identity', 400);
    const invoking = await invokingCall(input, captureDeadline);
    if (!invoking?.info.id) throw error('capture_call_unresolved', 503);
    const part = invoking.parts.find((entry) => entry.type === 'tool' && entry.callID === input.callID);
    if (invoking.info.sessionID && invoking.info.sessionID !== input.sessionID
      || part.sessionID && part.sessionID !== input.sessionID
      || part.messageID && part.messageID !== invoking.info.id) throw error('capture_identity_mismatch', 503);
    if (classifySessionChangeTool(part.tool) === 'read-only' || isSyntheticSessionChange(part)) return null;
    scope.paths = sessionChangeCapturePaths(part);
    scope.messageID = invoking.info.id;
    scope.userMessageID = invoking.info.parentID;
    scope.source = invoking.info.providerID === 'cursor-acp' ? 'cursor' : 'opencode';
    scope.tool = normalizeSessionChangeTool(part.tool);
    if (input.action === 'before') return runtime.begin(scope);
    await runtime.finish(scope);
    const receipt = sessionChangeReceipt(part);
    if (receipt) await runtime.recordReceipt({ ...scope, ...receipt });
    return null;
  };
  const observe = async (event, directory) => {
      const part = event?.properties?.part;
      if (part?.sessionID && part.messageID && part.callID) rememberCall(directory, part.sessionID, part.callID, part.messageID);
      await runtime.observe(event, directory);
      const receipt = sessionChangeReceipt(part);
      if (!receipt || typeof directory !== 'string' || !part.sessionID || !part.messageID) return;
      const current = await session(part.sessionID, directory);
      const callID = part.callID ?? part.id;
      if (typeof callID !== 'string' || !callID) return;
      // Events carry canonical tool metadata. Persist before notification; a
      // later paged-history replay is deduplicated by this same identity.
      await runtime.recordReceipt({ ...receipt, directory, sessionID: part.sessionID, messageID: part.messageID,
        callID, parentID: current.parentID ?? null, createdAt: part.state?.time?.start, source: 'canonical-event' });
  };
  return { ...runtime, plugin,
    async acceptExecution(input) {
      if (!input || !['tool', 'stream-gap', 'run-settled', 'interrupted'].includes(input.phase)
        || !['sessionID', ...(input.phase === 'interrupted' ? [] : ['messageID'])].every((key) => typeof input[key] === 'string' && /^[a-zA-Z0-9_-]{1,512}$/.test(input[key]))
        || ['tool', 'stream-gap'].includes(input.phase) && (typeof input.callID !== 'string' || !input.callID || input.callID.length > 512 || input.callID.includes('\0'))
        || input.parentCallID !== undefined && (typeof input.parentCallID !== 'string' || !input.parentCallID || input.parentCallID.length > 512 || input.parentCallID.includes('\0'))
        || input.phase === 'tool' && !['running', 'completed', 'error', 'cancelled'].includes(input.state)) throw error('capture_identity_mismatch', 400);
      const current = await session(input.sessionID, input.directory);
      const receipt = input.phase === 'tool' ? sessionChangeReceipt({ type: 'tool', tool: input.tool,
        state: { status: input.state, input: input.path ? { filePath: input.path } : {}, metadata: input.metadata } }) : null;
      await runtime.recordExecution({ directory: input.directory, sessionID: input.sessionID,
        messageID: input.messageID, userMessageID: input.userMessageID, parentID: current.parentID ?? null,
        callID: input.callID, parentCallID: input.parentCallID, phase: input.phase, state: input.state,
        tool: input.phase === 'stream-gap' ? 'task' : normalizeSessionChangeTool(input.tool), createdAt: input.createdAt, captureFailed: input.captureFailed === true, receipt });
      return { acknowledged: true };
    },
    observe(event, directory) {
      const sessionID = event?.properties?.part?.sessionID ?? event?.properties?.info?.id ?? event?.properties?.sessionID;
      const pending = observations.get(sessionID) ?? new Set();
      const work = observe(event, directory);
      pending.add(work); observations.set(sessionID, pending);
      const settled = () => { pending.delete(work); if (!pending.size) observations.delete(sessionID); };
      void work.then(settled, settled);
      return work;
    },
    async drain() {
      while (observations.size) await Promise.allSettled([...observations.values()].flatMap((pending) => [...pending]));
      await runtime.drain();
    },
    async handleRequest(method, rawPath, body = {}) {
      const url = new URL(rawPath, 'http://session-changes.invalid');
      const match = url.pathname.replace(/^\/api(?=\/)/, '').match(/^\/openchamber\/session\/([^/]+)\/changes(?:\/(diff|undo|redo))?$/);
      if (!match) return null;
      const [, rootSessionID, action] = match;
      const directory = url.searchParams.get('directory');
      try {
        if (method === 'GET' && action === 'diff') {
          await session(rootSessionID, directory);
          return { status: 200, body: await runtime.diff({ directory, rootSessionID,
            revision: url.searchParams.get('revision'), file: url.searchParams.get('file'), cursor: url.searchParams.get('cursor'), segment: url.searchParams.get('segment') }) };
        }
        if (method === 'GET' && !action && url.searchParams.has('revision')) {
          await session(rootSessionID, directory);
          return { status: 200, body: await runtime.summaryPage({ directory, rootSessionID,
            revision: url.searchParams.get('revision'), cursor: url.searchParams.get('cursor') }) };
        }
        const sessions = await tree(rootSessionID, directory);
        if (method === 'GET' && !action || method === 'POST' && ['undo', 'redo'].includes(action)) {
          const receiptStates = [];
          for (const entry of sessions) {
            receiptStates.push(await options.reconcileExecutionReceipts?.({ directory, sessionID: entry.id }));
          }
          const histories = [];
          for (let start = 0; start < sessions.length; start += 4) {
            histories.push(...await Promise.all(sessions.slice(start, start + 4).map((entry) => history(entry, directory))));
          }
          let settleTimer;
          await Promise.race([Promise.allSettled(sessions.flatMap((entry) => [...(observations.get(entry.id) ?? [])])),
            new Promise((resolve) => { settleTimer = setTimeout(resolve, 20_000); })]).finally(() => clearTimeout(settleTimer));
          const firstUserMessageID = histories[0].first;
          const summary = await runtime.summarize({ directory, rootSessionID, sessions, firstUserMessageID,
            reverts: sessions.filter((entry) => entry.revert?.messageID).map((entry) => ({ sessionID: entry.id, messageID: entry.revert.messageID })),
            coverageReasons: [...(sessions.some((entry) => entry.revert?.messageID) ? ['native_revert_active'] : []),
              ...(histories.some((entry) => !entry.complete) ? ['history_pending'] : []),
              ...receiptStates.flatMap((state) => state?.reasons ?? []),
              ...(receiptStates.some((state) => state?.pending) || sessions.some((entry) => observations.get(entry.id)?.size) ? ['receipts_pending'] : [])] });
          if (method === 'GET') return { status: 200, body: summary };
          if (summary.revision !== body?.revision) throw error('summary_revision_changed');
        }
        if (method === 'POST' && ['undo', 'redo'].includes(action)) {
          const { data: statuses } = await request('/session/status', directory);
          if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)
            || Object.values(statuses).some((status) => !['idle', 'busy', 'retry'].includes(status?.type))) throw error('session_status_unavailable', 503);
          if (Object.values(statuses).some((status) => ['busy', 'retry'].includes(status.type))) throw error('directory_busy');
          const result = await runtime.restore({ directory, rootSessionID, revision: body?.revision, redo: action === 'redo' });
          return { status: 200, body: result };
        }
        return { status: 405, body: { code: 'method_not_allowed', error: 'Method not allowed' } };
      } catch (cause) {
        return { status: cause.status ?? 503, body: { code: cause.code ?? 'session_changes_unavailable', error: cause.code ?? 'Session changes unavailable' } };
      }
    },
  };
}
