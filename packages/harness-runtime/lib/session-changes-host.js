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
      if (entries.length > 1000) throw error('session_tree_limit', 503);
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
  const history = async (id, directory, revertMessageID, budget) => {
    let first = null;
    const calls = new Map();
    const receipts = [];
    const messageTimes = new Map();
    const deadline = Date.now() + 30_000;
    let cursor = null;
    const seen = new Set();
    for (let page = 0; page < 100; page++) {
      if (Date.now() >= deadline) throw error('history_limit', 503);
      const query = new URLSearchParams({ limit: '100', ...(cursor ? { before: cursor } : {}) });
      const result = await request(`/session/${id}/message?${query}`, directory);
      budget.bytes += result.bytes;
      if (budget.bytes > 64 * 1024 * 1024) throw error('history_limit', 503);
      if (!Array.isArray(result.data)) throw error('invalid_session_history', 503);
      for (const record of result.data) {
        if (record.info?.id && typeof record.info.time?.created === 'number') messageTimes.set(record.info.id, record.info.time.created);
        for (const part of record.parts ?? []) {
          if (part.type === 'tool' && !READ_ONLY.has(part.tool)) calls.set(part.callID ?? part.id, { sessionID: id, callID: part.callID ?? part.id });
          const metadata = part.state?.metadata;
          if (!FILE_TOOLS.has(part.tool) || !part.callID || !metadata) continue;
          const diffs = metadata.filediff ? [metadata.filediff] : Array.isArray(metadata.files) ? metadata.files : [];
          const files = [];
          for (const diff of diffs) {
            const file = diff?.file ?? diff?.filePath ?? part.state?.input?.filePath;
            if (typeof file !== 'string' || typeof diff?.before !== 'string' || typeof diff?.after !== 'string') continue;
            files.push({ path: file, before: metadata.exists === false || diff.type === 'added' ? null : diff.before,
              after: diff.type === 'deleted' ? null : diff.after });
          }
          if (files.length && files.length === diffs.length) receipts.push({ sessionID: id, callID: part.callID,
            messageID: record.info.id, userMessageID: record.info.parentID, createdAt: part.state?.time?.start ?? record.info.time.created, files });
        }
        if (record.info?.role === 'user' && (!first || record.info.time.created < first.time.created)) first = record.info;
      }
      if (!result.cursor) {
        const boundary = messageTimes.get(revertMessageID);
        if (revertMessageID && boundary === undefined) throw error('revert_boundary_unavailable', 503);
        const hiddenMessages = boundary === undefined ? [] : [...messageTimes].filter(([, time]) => time >= boundary).map(([messageID]) => ({ sessionID: id, messageID }));
        return { first: first?.id ?? null, calls: [...calls.values()], receipts, hiddenMessages };
      }
      if (seen.has(result.cursor)) break;
      seen.add(result.cursor); cursor = result.cursor;
    }
    throw error('history_limit', 503);
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
        const sessions = await tree(rootSessionID, directory);
        if (method === 'GET' && !action) {
          const histories = [];
          const budget = { bytes: 0 };
          for (let start = 0; start < sessions.length; start += 4) {
            histories.push(...await Promise.all(sessions.slice(start, start + 4).map((entry) => history(entry.id, directory, entry.revert?.messageID, budget))));
          }
          const receipts = histories.flatMap((entry) => entry.receipts).sort((a, b) => a.createdAt - b.createdAt);
          await runtime.importHistorical(receipts.map((receipt) => ({ ...receipt, directory,
            parentID: sessions.find((entry) => entry.id === receipt.sessionID)?.parentID ?? null })));
          const firstUserMessageID = histories[0].first;
          return { status: 200, body: await runtime.summarize({ directory, rootSessionID, sessions, firstUserMessageID, expectedCalls: histories.flatMap((entry) => entry.calls),
            hiddenMessages: histories.flatMap((entry) => entry.hiddenMessages),
            coverageReasons: sessions.some((entry) => entry.revert?.messageID) ? ['native_revert_active'] : [] }) };
        }
        if (method === 'GET' && action === 'diff') return { status: 200, body: await runtime.diff({ directory, rootSessionID,
          revision: url.searchParams.get('revision'), file: url.searchParams.get('file') }) };
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
