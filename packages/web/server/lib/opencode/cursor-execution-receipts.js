import { classifySessionChangeTool, normalizeSessionChangeTool } from '@openchamber/harness-runtime/lib/session-changes-tools.js';

const failure = code => Object.assign(new Error(code), { code, status: 409 });
const MAX_SETTLED_LEASES = 1024;
const MAX_MEMO_BYTES = 16 * 1024 * 1024;

/** The process publication owns bytes; internal calls retain aliases and only
 * non-read-only and native task evidence. Task receipts cover the exact alias;
 * only the outer published process receipt owns file bytes. A failed write never becomes a completed receipt. */
export function createCursorExecutionReceipts({ runtime, recordReceipt, recordReceipts, onDiagnostic }) {
  const leases = new Map();
  let memoBytes = 0;
  const remember = (state, set, id) => {
    if (set.has(id)) return;
    set.add(id);
    const bytes = Buffer.byteLength(id) + 64;
    state.bytes += bytes; memoBytes += bytes;
  };
  const emit = event => { try { onDiagnostic?.({ event: 'session_execution', ...event }); } catch { /* Observer only. */ } };
  return (lease, record) => {
    if (!lease?.token || !Array.isArray(record?.parts)) return Promise.reject(failure('capture_identity_mismatch'));
    const calls = new Map();
    for (const part of record.parts) {
      if (!part || typeof part !== 'object') return Promise.reject(failure('capture_identity_mismatch'));
      if (part.type !== 'tool') continue;
      if (typeof part.callID !== 'string' || !part.callID || typeof part.tool !== 'string'
        || calls.has(part.callID) && calls.get(part.callID) !== part.tool) return Promise.reject(failure('capture_identity_mismatch'));
      calls.set(part.callID, part.tool);
    }
    const key = JSON.stringify([lease.directory, lease.token]);
    let state = leases.get(key);
    if (!state) {
      state = { outer: false, aliases: new Set(), receipts: new Set(), pending: null, bytes: Buffer.byteLength(key) + 128 };
      memoBytes += state.bytes; leases.set(key, state);
    }
    const write = async () => {
      const aliases = [...calls.keys()].filter(id => !state.aliases.has(id));
      const internal = [...calls].filter(([id, tool]) => id !== lease.scope?.callID && !state.receipts.has(id) && (classifySessionChangeTool(tool) !== 'read-only' || normalizeSessionChangeTool(tool) === 'task'));
      if (state.outer && !aliases.length && !internal.length) return false;
      const identity = { sessionID: lease.scope?.sessionID, messageID: lease.scope?.messageID };
      const receiptCount = internal.length + Number(!state.outer);
      emit({ ...identity, phase: 'cursor_receipts', state: 'started', calls: calls.size, receipts: receiptCount });
      const started = Date.now();
      try {
        if (aliases.length) {
          await runtime.aliasCalls({ directory: lease.directory, token: lease.token, calls: aliases });
          for (const id of aliases) remember(state, state.aliases, id);
        }
        if (!state.outer || internal.length) {
          if (typeof recordReceipts !== 'function' && typeof recordReceipt !== 'function') throw failure('change_receipt_owner_unavailable');
          const receipt = await runtime.executionReceipt({ directory: lease.directory, token: lease.token });
          const pending = [...(!state.outer ? [{ ...receipt, tool: 'cursor_sdk' }] : []),
            ...internal.filter(([callID]) => callID !== receipt.callID).map(([callID, tool]) => ({ ...receipt, callID, tool, files: [] }))];
          if (recordReceipts) {
            await recordReceipts(pending);
            state.outer = true;
            for (const [id] of internal) remember(state, state.receipts, id);
          } else {
            for (const input of pending) {
              await recordReceipt(input);
              if (input.tool === 'cursor_sdk' && input.callID === receipt.callID) state.outer = true;
              else remember(state, state.receipts, input.callID);
            }
          }
        }
        emit({ ...identity, phase: 'cursor_receipts', state: 'completed', elapsedMs: Date.now() - started,
          calls: calls.size, receipts: receiptCount });
        return true;
      } catch (cause) {
        emit({ ...identity, phase: 'cursor_receipts', state: 'failed', elapsedMs: Date.now() - started });
        throw cause;
      }
    };
    const work = (state.pending ?? Promise.resolve()).catch(() => {}).then(write);
    state.pending = work;
    void work.finally(() => {
      if (state.pending === work) state.pending = null;
      // Eviction only loses an optimization: durable receipt/alias owners still
      // verify replay. Never evict an in-flight lease.
      if (leases.size > MAX_SETTLED_LEASES || memoBytes > MAX_MEMO_BYTES) for (const [id, entry] of leases) {
        if (!entry.pending) { leases.delete(id); memoBytes -= entry.bytes; }
        if (leases.size <= MAX_SETTLED_LEASES && memoBytes <= MAX_MEMO_BYTES) break;
      }
    }).catch(() => {});
    return work;
  };
}
