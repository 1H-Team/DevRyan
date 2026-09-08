import path from 'node:path';
import fs from 'node:fs/promises';
import { createSessionChangeRuntime } from './session-changes.js';

const READ_ONLY = new Set(['read', 'oc_read', 'glob', 'grep', 'list', 'webfetch', 'websearch', 'todowrite', 'todoread', 'question', 'task', 'devryan_task', 'council_session']);
const FILE_TOOLS = new Set(['edit', 'oc_edit', 'write', 'oc_write', 'apply_patch', 'multiedit']);

const error = (code, status = 409) => Object.assign(new Error(code), { code, status });

// Authenticated host routers own principal authorization. Plugin calls arrive
// only on the bearer-authenticated private bridge; validate their session and
// directory against OpenCode before touching the filesystem.
export function createSessionChangeHost(options) {
  const runtime = createSessionChangeRuntime({ directory: path.join(options.dataDirectory, 'harness', 'session-changes'),
    onDiagnostic: options.onDiagnostic,
    onChange: ({ directory, sessionID }) => options.publishEvent?.({ type: 'session.changes.updated', properties: { sessionID } }, { directory }),
  });
  const request = async (pathname, directory) => {
    const url = new URL(options.buildOpenCodeUrl(pathname));
    if (directory) url.searchParams.set('directory', directory);
    const response = await (options.fetchImpl ?? fetch)(url, {
      headers: options.getOpenCodeAuthHeaders?.(), signal: AbortSignal.timeout(15_000),
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
  const history = async (id, directory) => {
    const saved = await runtime.historyState({ directory, sessionID: id });
    const state = saved ?? { complete: false, cursor: null, first: null, newestID: null };
    const deadline = Date.now() + 20_000;
    const seen = new Set();
    let cursor = state.complete ? null : state.cursor;
    let newestID = state.newestID;
    let limit = 100;
    for (;;) {
      if (Date.now() >= deadline) return { first: state.first?.id ?? null, complete: false };
      const query = new URLSearchParams({ limit: String(limit), ...(cursor ? { before: cursor } : {}) });
      let result;
      try { result = await request(`/session/${id}/message?${query}`, directory); }
      catch (cause) {
        if (cause.code === 'history_limit' && limit > 1) { limit = Math.max(1, Math.floor(limit / 2)); continue; }
        throw cause;
      }
      if (!Array.isArray(result.data)) throw error('invalid_session_history', 503);
      const receipts = [], messages = [];
      let reachedSavedHead = false;
      for (const record of result.data) {
        if (!record.info?.id || typeof record.info.time?.created !== 'number') throw error('invalid_session_history', 503);
        if (record.info.id === saved?.newestID) reachedSavedHead = true;
        if (!cursor && (!newestID || record.info.time.created > (result.data.find((entry) => entry.info.id === newestID)?.info.time.created ?? -1))) newestID = record.info.id;
        const calls = [];
        for (const part of record.parts ?? []) {
          if (part.type === 'tool' && !READ_ONLY.has(part.tool)) calls.push(part.callID ?? part.id);
          const metadata = part.state?.metadata;
          if (!FILE_TOOLS.has(part.tool) || !part.callID || !metadata || !['completed', 'error'].includes(part.state?.status)) continue;
          const diffs = metadata.filediff ? [metadata.filediff] : Array.isArray(metadata.files) ? metadata.files : [];
          const files = [];
          for (const diff of diffs) {
            const file = diff?.file ?? diff?.filePath ?? part.state?.input?.filePath;
            if (typeof file !== 'string' || typeof diff?.before !== 'string' || typeof diff?.after !== 'string') continue;
            files.push({ path: file, before: metadata.exists === false || diff.type === 'added' ? null : diff.before,
              after: diff.type === 'deleted' ? null : diff.after });
          }
          if (files.length && files.length === diffs.length) receipts.push({ sessionID: id, callID: part.callID,
            messageID: record.info.id, userMessageID: record.info.parentID, createdAt: part.state?.time?.start ?? record.info.time.created, files, directory });
        }
        messages.push({ id: record.info.id, createdAt: record.info.time.created, calls });
        if (record.info.role === 'user' && (!state.first || record.info.time.created < state.first.createdAt)) state.first = { id: record.info.id, createdAt: record.info.time.created };
      }
      await runtime.importHistorical(receipts);
      const complete = !result.cursor || Boolean(saved?.complete && reachedSavedHead);
      if (result.cursor && seen.has(result.cursor)) throw error('invalid_history_cursor', 503);
      state.complete = complete; state.cursor = complete ? null : result.cursor; state.newestID = newestID;
      await runtime.historyState({ directory, sessionID: id, state, messages });
      if (complete) return { first: state.first?.id ?? null, complete: true };
      seen.add(result.cursor); cursor = result.cursor;
    }
  };
  const plugin = async (input) => {
    const captureDeadline = Date.now() + 30_000;
    const current = await session(input.sessionID, input.directory);
    const scope = { directory: input.directory, sessionID: input.sessionID, callID: input.callID, captureDeadline, parentID: current.parentID ?? null };
    if (input.action === 'message') return runtime.registerSession({ ...scope, userMessageID: input.userMessageID });
    if (!['before', 'after'].includes(input.action) || typeof input.callID !== 'string' || !input.callID) throw error('invalid_capture_identity', 400);
    const { data } = await request(`/session/${input.sessionID}/message?limit=100`, input.directory);
    const invoking = Array.isArray(data) ? data.find((record) => record.info?.role === 'assistant'
      && record.parts?.some((part) => part.type === 'tool' && part.callID === input.callID)) : null;
    if (!invoking?.info.id) throw error('capture_call_unresolved', 503);
    const part = invoking.parts.find((entry) => entry.type === 'tool' && entry.callID === input.callID);
    if (['edit', 'oc_edit', 'write', 'oc_write'].includes(part.tool) && typeof part.state?.input?.filePath === 'string') {
      scope.paths = [part.state.input.filePath];
    }
    scope.messageID = invoking.info.id;
    scope.userMessageID = invoking.info.parentID;
    return input.action === 'before' ? runtime.begin(scope) : runtime.finish(scope);
  };
  return { ...runtime, plugin,
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
            revision: url.searchParams.get('revision'), file: url.searchParams.get('file'), cursor: url.searchParams.get('cursor') }) };
        }
        if (method === 'GET' && !action && url.searchParams.has('revision')) {
          await session(rootSessionID, directory);
          return { status: 200, body: await runtime.summaryPage({ directory, rootSessionID,
            revision: url.searchParams.get('revision'), cursor: url.searchParams.get('cursor') }) };
        }
        const sessions = await tree(rootSessionID, directory);
        if (method === 'GET' && !action) {
          const histories = [];
          for (let start = 0; start < sessions.length; start += 4) {
            histories.push(...await Promise.all(sessions.slice(start, start + 4).map((entry) => history(entry.id, directory))));
          }
          const firstUserMessageID = histories[0].first;
          return { status: 200, body: await runtime.summarize({ directory, rootSessionID, sessions, firstUserMessageID,
            reverts: sessions.filter((entry) => entry.revert?.messageID).map((entry) => ({ sessionID: entry.id, messageID: entry.revert.messageID })),
            coverageReasons: [...(sessions.some((entry) => entry.revert?.messageID) ? ['native_revert_active'] : []),
              ...(histories.some((entry) => !entry.complete) ? ['history_pending'] : [])] }) };
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
