// Per ported family, a generator of one call: `{ entry, args }` (client-generators.mjs).
import { PROFILE, id, list, maybe, numericString, pickish, randomNumber, randomString, sid, statusWord, timeVal, wild } from './client-generators.mjs';

const o = (r, members, pOmit = 0.15) => { const out = {}; for (const [k, v] of members) maybe(r, out, k, typeof v === 'function' ? v() : v, pOmit); return out; };
const shuffle = (r, a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i -= 1) { const j = r.int(i + 1); [b[i], b[j]] = [b[j], b[i]]; } return b; };

// ---------------------------------------------------------------- shapes
const toolState = (r) => o(r, [['status', () => (r.chance(0.8) ? statusWord(r) : wild(r, 0))], ['time', () => (r.chance(0.85) ? o(r, [['start', () => timeVal(r)], ['end', () => timeVal(r)]], 0.3) : wild(r, 1))], ['output', () => pickish(r, ['', 'out', 'longer output', 'o'])], ['metadata', () => pickish(r, [{}, { a: 1 }, { b: [1, 2] }, undefined])], ['title', () => pickish(r, ['t', 'T'])]], 0.3);

const part = (r, ids = null) => {
  const type = pickish(r, ['text', 'reasoning', 'tool', 'tool', 'step-start', 'file', 'patch'], 0.08);
  const p = o(r, [['id', () => (ids ? r.pick(ids) : id(r))], ['type', type], ['messageID', () => id(r)]], 0.05);
  if (type === 'tool' || r.chance(0.1)) maybe(r, p, 'state', r.chance(0.85) ? toolState(r) : wild(r, 1), 0.08);
  if (type === 'text' || type === 'reasoning' || r.chance(0.1)) maybe(r, p, 'text', pickish(r, ['', ' ', 'h', 'he', 'hel', 'hello', 'hello world', 'Hello', '　', '﻿', 'x\u0085', 'ab😀', 'ab\ud83d'], 0.1), 0.2);
  if (r.chance(0.15)) maybe(r, p, 'output', pickish(r, ['', 'o', 'out', 'output!']));
  if (r.chance(0.2)) maybe(r, p, 'time', o(r, [['start', () => timeVal(r)], ['end', () => timeVal(r)]], 0.4));
  if (r.chance(0.2)) maybe(r, p, 'metadata', cursorMeta(r, p.type, p.id));
  return p;
};

const cursorMeta = (r, type, partID) => {
  const cursor = o(r, [['partID', () => (r.chance(0.7) ? partID : id(r))]], 0.1);
  const devryan = r.chance(0.85) ? o(r, [[r.chance(0.9) ? 'cursor' : 'native', r.chance(0.85) ? cursor : wild(r, 0)]], 0.05) : wild(r, 0);
  const state = r.chance(0.85) ? o(r, [['devryan', devryan]], 0.05) : wild(r, 0);
  if (r.chance(0.1)) return [state];
  return (type === 'text') !== r.chance(0.15) ? o(r, [['providerState', state]], 0.05) : state;
};

const message = (r, ids) => {
  const m = o(r, [['id', () => (ids ? r.pick(ids) : id(r))], ['role', () => pickish(r, ['user', 'assistant', 'assistant', 'system', 'Assistant'], 0.05)], ['sessionID', () => sid(r)], ['time', () => (r.chance(0.9) ? o(r, [['created', () => timeVal(r)], ['completed', () => timeVal(r)]], 0.3) : wild(r, 0))]], 0.05);
  if (r.chance(0.5)) maybe(r, m, 'finish', r.chance(0.8) ? r.pick(['stop', 'tool-calls', ' Tool-Calls ', 'tool_calls', 'toolcalls', '', ' ', 'length', 'TOOL-CALLS　', 'unknown', 'İ']) : wild(r, 0));
  if (r.chance(0.3)) maybe(r, m, 'status', r.chance(0.8) ? statusWord(r) : wild(r, 0));
  if (r.chance(0.2)) maybe(r, m, 'streaming', pickish(r, [true, false, 'true', 1]));
  if (r.chance(0.2)) maybe(r, m, 'summary', summary(r));
  return m;
};

const diffEntry = (r, pool) => {
  const e = o(r, [['file', () => pickish(r, ['a.ts', 'b/c.ts', './x', '.\\y'])], ['status', () => pickish(r, ['added', 'modified'])], ['additions', () => count(r)], ['deletions', () => count(r)]], 0.25);
  for (const f of ['patch', 'before', 'after', 'from', 'to']) if (r.chance(0.3)) maybe(r, e, f, pickish(r, ['', 'diff --git', 'x'.repeat(5), 'long'], 0.25), 0);
  if (r.chance(0.2)) pool.push(e);
  return e;
};
const count = (r) => (PROFILE.typed ? r.pick([0, 1, 2, 3, 5, 10, 120, undefined, '3', '0']) : r.chance(0.6) ? r.pick([0, -0, 1, 2, 3, 5, 10, 0.5, -1, -2.5, NaN, Infinity, -Infinity, 1e308, Number.MAX_VALUE, null, undefined]) : r.chance(0.6) ? numericString(r) : wild(r, 0));

const summary = (r, pool = []) => {
  if (r.chance(0.1)) return wild(r, 1, pool);
  const s = {};
  if (r.chance(0.4)) maybe(r, s, 'additions', count(r), 0);
  if (r.chance(0.4)) maybe(r, s, 'deletions', count(r), 0);
  if (r.chance(0.3)) maybe(r, s, 'files', count(r), 0);
  if (r.chance(0.8)) maybe(r, s, 'diffs', r.chance(0.9) ? list(r, () => (r.chance(0.08) ? r.pick([0, '', false, null, 'str', 5]) : r.chance(0.15) && pool.length ? r.pick(pool) : diffEntry(r, pool)), 4) : wild(r, 1), 0);
  if (r.chance(0.3)) maybe(r, s, r.pick(['title', 'x', '0', 'z']), wild(r, 0), 0);
  return s;
};

const session = (r, sids = null) => {
  const s = o(r, [['id', () => (sids ? r.pick(sids) : sid(r))], ['title', () => pickish(r, ['t', 'T', '', null, 'a|b', 1, 'x'])], ['time', () => (r.chance(0.92) ? o(r, [['created', () => timeVal(r)], ['updated', () => timeVal(r)], ['archived', () => timeVal(r)]], 0.35) : wild(r, 0))], ['directory', () => pickish(r, ['/a', '/b', null, ''])], ['parentID', () => pickish(r, ['s1', null, undefined, ''])], ['share', () => pickish(r, [{ url: 'u' }, { url: 1e21 }, {}, null, undefined])], ['summary', () => (r.chance(0.5) ? summary(r) : undefined)]], 0.25);
  if (r.chance(0.2)) maybe(r, s, 'revert', r.chance(0.85) ? o(r, [['messageID', () => id(r)]], 0.1) : wild(r, 0));
  return s;
};

const sessionStatus = (r) => (r.chance(0.08) ? wild(r, 1) : o(r, [['type', () => pickish(r, ['idle', 'busy', 'retry', 'other'])], ['message', () => pickish(r, ['m', 'n', 1])], ['attempt', () => pickish(r, [1, 2, NaN, '1'])], ['next', () => pickish(r, [5, 6, -0, 0])]], 0.4));

// A copy of `value` with one primitive leaf changed or kept (for equivalence checks).
const perturb = (r, value, depth = 0) => {
  if (value === null || typeof value !== 'object') {
    if (r.chance(0.08)) return wild(r, 0);
    if (typeof value === 'number' && r.chance(0.3)) return String(value);
    return value;
  }
  if (value instanceof Set || value instanceof Map || value instanceof Date || value instanceof Error) return value;
  if (Array.isArray(value)) return value.map((item) => perturb(r, item, depth + 1));
  const out = Object.getPrototypeOf(value) === null ? Object.create(null) : {};
  for (const key of r.chance(0.05) ? shuffle(r, Object.keys(value)) : Object.keys(value)) Object.defineProperty(out, key, { value: perturb(r, value[key], depth + 1), enumerable: true, writable: true, configurable: true });
  return out;
};

const revertState = (r) => {
  const ids = ['m1', 'm2', 'm3', 'm4'];
  const state = {};
  if (r.chance(0.85)) maybe(r, state, 'session', r.chance(0.92) ? list(r, () => session(r, ['s1', 's2', 's3']), 3) : wild(r, 1), 0);
  if (r.chance(0.85)) maybe(r, state, 'message', r.chance(0.92) ? o(r, [['s1', () => list(r, () => message(r, ids), 5, { holes: 0.03, nulls: 0.02 })], ['s2', () => list(r, () => message(r, ids), 3)]], 0.3) : wild(r, 1), 0);
  if (r.chance(0.8)) maybe(r, state, 'revert_transaction', r.chance(0.92) ? o(r, [['s1', () => transaction(r, ids)], ['s2', () => transaction(r, ids)], ['0', () => transaction(r, ids)]], 0.4) : wild(r, 1), 0);
  return state;
};
const transaction = (r, ids) => (r.chance(0.1) ? wild(r, 0) : o(r, [['messageID', () => pickish(r, ids, 0.1)], ['hiddenMessageIDs', () => (r.chance(0.85) ? new Set(list(r, () => pickish(r, ids, 0.05), 3, { holes: 0, nulls: 0 })) : wild(r, 0))], ['version', 1], ['status', () => pickish(r, ['pending', 'confirmed', 'failed', 'Failed'])], ['startedAt', 1]], 0.25));

// ---------------------------------------------------------------- families
export const FAMILY_GENERATORS = {
  'native-cursor-text': (r) => ({ entry: 'hasNativeCursorTextProvenance', args: [r.chance(0.05) ? wild(r, 1) : part(r)] }),

  'tool-status': (r) => {
    const entry = r.pick(['normalizeToolStatus', 'isFinalToolStatus', 'getToolLifecycleState']);
    if (entry === 'getToolLifecycleState') return { entry, args: r.chance(0.05) ? [] : [r.chance(0.1) ? wild(r, 1) : toolState(r)] };
    return { entry, args: [r.chance(0.85) ? statusWord(r) : r.chance(0.5) ? randomString(r, 12) : wild(r, 0)] };
  },

  sanitize: (r) => {
    const pool = [];
    const target = o(r, [['id', () => sid(r)], ['summary', () => summary(r, pool)], ['title', 't']], 0.1);
    if (r.chance(0.05)) return { entry: r.pick(['stripSessionDiffSnapshots', 'stripMessageDiffSnapshots']), args: [wild(r, 2)] };
    return { entry: r.pick(['stripSessionDiffSnapshots', 'stripMessageDiffSnapshots']), args: [target] };
  },

  'tool-output': (r) => {
    const entry = r.pick(['isToolOutputOmitted', 'getOmittedToolOutputBytes', 'keepFullToolOutput', 'keepFullToolOutput', 'mergeLoadedToolOutput', 'mergeLoadedToolOutput']);
    const toolPart = (pid) => {
      const p = o(r, [['id', pid], ['type', () => pickish(r, ['tool', 'tool', 'text'])], ['callID', 'c'], ['state', () => o(r, [['status', () => pickish(r, ['completed', 'completed', 'running', 'Completed'])], ['input', () => pickish(r, [{}, { a: 1 }])], ['output', () => pickish(r, ['', 'full', 'out'])], ['metadata', () => pickish(r, [{}, { m: 1 }, { m: -0 }, { m: 0 }, { m: NaN }, { m: null }, undefined])], ['title', () => pickish(r, ['t', 'u'])], ['outputOmitted', () => pickish(r, [true, true, false, 1, 'true', undefined])], ['outputBytes', () => (r.chance(0.7) ? randomNumber(r) : wild(r, 0))], ['time', () => o(r, [['start', 1], ['end', 2]])]], 0.3)]], 0.05);
      return p;
    };
    const pids = ['p1', 'p2', 'p3'];
    if (entry === 'isToolOutputOmitted') return { entry, args: [r.chance(0.08) ? wild(r, 1) : toolPart(r.pick(pids))] };
    if (entry === 'getOmittedToolOutputBytes') return { entry, args: [r.chance(0.08) ? wild(r, 1) : { state: { outputBytes: r.chance(0.8) ? randomNumber(r) : wild(r, 0) } }] };
    if (entry === 'keepFullToolOutput') {
      const existing = r.chance(0.1) ? r.pick([undefined, null]) : toolPart(r.pick(pids));
      let next = toolPart(r.pick(pids));
      if (existing && r.chance(0.3)) { next = perturb(r, existing); next.state = { ...(next.state ?? {}), outputOmitted: true }; delete next.state.output; if (r.chance(0.5)) next.state.outputBytes = 5; }
      if (existing && r.chance(0.1)) next = existing;
      return { entry, args: [existing, next] };
    }
    const current = list(r, () => toolPart(r.pick(pids)), 4, { holes: 0.05, nulls: 0.02 });
    const full = list(r, () => toolPart(r.pick(pids)), 4, { holes: 0.02, nulls: 0.02 });
    return { entry, args: [current, full] };
  },

  'message-order': (r) => {
    const entry = r.pick(['compareMessagesChronologically', 'sortMessagesChronologically', 'sortMessagesChronologically', 'insertMessageChronologically', 'findMessageIndex', 'messagesBefore', 'messagesFrom']);
    const ids = r.chance(0.7) ? ['m1', 'm2', 'm3', 'm10', 'M1', 'a'] : null;
    const msg = () => (r.chance(0.04) ? wild(r, 1) : o(r, [['id', () => (ids ? r.pick(ids) : id(r, 0.3))], ['time', () => (r.chance(0.9) ? o(r, [['created', () => (r.chance(0.6) ? r.pick([1, 2, 3, 1, 2, 0, -0, NaN, Infinity, '1']) : timeVal(r))]], 0.1) : wild(r, 0))], ['n', () => r.int(100)]], 0.05));
    const msgs = () => list(r, msg, 8, { holes: 0.03, nulls: 0.02, repeat: 0.1 });
    if (entry === 'compareMessagesChronologically') return { entry, args: [msg(), msg()] };
    if (entry === 'sortMessagesChronologically') return { entry, args: [msgs()] };
    if (entry === 'insertMessageChronologically') { const m = msgs(); const sorted = r.chance(0.6) ? m.filter((x) => x && x.time && x.time !== null).sort((a, b) => { const ca = typeof a.time?.created === 'number' && Number.isFinite(a.time.created) ? a.time.created : 0; const cb = typeof b.time?.created === 'number' && Number.isFinite(b.time.created) ? b.time.created : 0; return ca - cb; }) : m; return { entry, args: [sorted, msg()] }; }
    return { entry, args: [msgs(), r.chance(0.9) ? r.pick(['m1', 'm2', 'm3', 'zz', '', 'M1']) : id(r, 1)] };
  },

  'session-diff-stats': (r) => {
    const entry = r.pick(['parseSessionDiffCount', 'parseSessionDiffCount', 'parseSessionDiffCount', 'getSessionSummaryDiffTotals', 'resolveSessionDiffStats', 'getScopedMessageDiffTotals', 'resolveTouchedFileWorkingTreeDiffStats', 'stripUntrustedSessionDiffSummary', 'normalizeChatOwnedDiffSummary']);
    if (entry === 'parseSessionDiffCount') return { entry, args: [r.chance(0.65) ? numericString(r) : count(r)] };
    if (entry === 'resolveTouchedFileWorkingTreeDiffStats') {
      const files = list(r, () => pickish(r, ['a.ts', './a.ts', '.\\a.ts', 'b\\c.ts', 'b/c.ts', '././a.ts', './/a.ts', 'constructor', '__proto__', 'toString', '', 'x'], 0.04), 4, { holes: 0.02, nulls: 0.01 });
      const stats = r.chance(0.9) ? o(r, [['a.ts', () => o(r, [['insertions', () => count(r)], ['deletions', () => count(r)]])], ['b/c.ts', () => o(r, [['insertions', () => count(r)], ['deletions', () => count(r)]])], ['./a.ts', () => ({ insertions: 7 })], ['', () => ({ deletions: 1 })]], 0.4) : wild(r, 1);
      return { entry, args: [r.chance(0.95) ? files : wild(r, 1), r.chance(0.1) ? undefined : stats] };
    }
    const s = summary(r);
    if (entry === 'stripUntrustedSessionDiffSummary' || entry === 'normalizeChatOwnedDiffSummary') {
      const target = r.chance(0.06) ? wild(r, 2) : o(r, [['id', 's1'], ['summary', s], ['z', 1]], 0.15);
      return { entry, args: entry === 'normalizeChatOwnedDiffSummary' ? [target, list(r, () => message(r), 2)] : [target] };
    }
    return { entry, args: r.chance(0.05) ? [] : [s] };
  },

  'session-working': (r) => {
    const entry = r.pick(['hasTerminalAssistantFinish', 'hasToolCallAssistantFinish', 'isTerminalAssistantMessage', 'isAssistantTurnComplete', 'isIncompleteAssistantMessage', 'hasInFlightToolParts', 'hasVisibleAssistantSummary', 'isFinalAssistantSummaryMessage', 'isLiveAssistantMessage', 'isSessionWorkingFromState', 'isSessionWorkingFromState']);
    const ids = ['m1', 'm2', 'm3'];
    const parts = () => (r.chance(0.1) ? r.pick([undefined, null, wild(r, 1)]) : list(r, () => part(r), 4, { holes: 0.02, nulls: 0.02 }));
    const msg = () => (r.chance(0.06) ? wild(r, 1) : message(r, ids));
    if (['hasInFlightToolParts', 'hasVisibleAssistantSummary'].includes(entry)) return { entry, args: [parts()] };
    if (['isFinalAssistantSummaryMessage', 'isLiveAssistantMessage'].includes(entry)) return { entry, args: [msg(), parts()] };
    if (entry === 'isSessionWorkingFromState') {
      const input = o(r, [['status', () => pickish(r, [undefined, { type: 'idle' }, { type: 'busy' }, { type: 'retry' }, null, {}], 0.05)], ['permissions', () => pickish(r, [[], [], [], [{}], { length: 1 }, { length: '1' }, 'x'], 0.03)], ['messages', () => (r.chance(0.95) ? list(r, msg, 5, { holes: 0.02, nulls: 0.02 }) : wild(r, 1))], ['liveStreamingMessageId', () => pickish(r, [undefined, null, '', 'm1', 'm2', 'm3', 'zz'])], ['liveParts', () => parts()]], 0.12);
      return { entry, args: [r.chance(0.03) ? wild(r, 0) : input] };
    }
    return { entry, args: [msg()] };
  },

  'live-aggregate': (r) => {
    const entry = r.pick(['aggregateLiveSessionStatuses', 'aggregateLiveSessions', 'areSessionListsEquivalent', 'areSessionListsEquivalent', 'areStatusMapsEquivalent', 'areStatusMapsEquivalent', 'findLiveSession', 'findLiveSessionStatus']);
    const sids = ['s1', 's2', 's3', 's4'];
    const statusMap = () => (r.chance(0.05) ? wild(r, 1) : o(r, [['s1', () => sessionStatus(r)], ['s2', () => sessionStatus(r)], ['s3', () => sessionStatus(r)], ['10', () => sessionStatus(r)], ['2', () => sessionStatus(r)]], 0.5));
    const state = () => (r.chance(0.04) ? wild(r, 1) : o(r, [['session', () => (r.chance(0.95) ? list(r, () => session(r, sids), 4, { holes: 0.02, nulls: 0.03 }) : wild(r, 1))], ['session_status', () => (r.chance(0.9) ? statusMap() : r.pick([undefined, null]))]], 0.05));
    const states = () => { const s = list(r, state, 3, { holes: 0.01, nulls: 0.01 }); return r.chance(0.1) ? new Set(s) : s; };
    if (entry === 'areSessionListsEquivalent') { const left = list(r, () => session(r, sids), 3, { holes: 0.01, nulls: 0.02 }); const right = r.chance(0.1) ? left : r.chance(0.7) ? perturb(r, left) : list(r, () => session(r, sids), 3); return { entry, args: [left, right] }; }
    if (entry === 'areStatusMapsEquivalent') {
      const left = statusMap();
      const right = r.chance(0.1) ? left : r.chance(0.7) ? perturb(r, left) : statusMap();
      if (r.chance(0.15) && left && typeof left === 'object') { const proto = r.pick(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']); Object.defineProperty(left, proto, { value: r.chance(0.5) ? undefined : sessionStatus(r), enumerable: true, writable: true, configurable: true }); }
      return { entry, args: [left, right] };
    }
    if (entry === 'findLiveSession' || entry === 'findLiveSessionStatus') return { entry, args: [states(), pickish(r, [...sids, '', null, undefined, 'zz'], 0.05)] };
    return { entry, args: [states()] };
  },

  optimistic: (r) => {
    const entry = r.pick(['mergeOptimisticPage', 'applyOptimisticAdd', 'applyOptimisticRemove']);
    const ids = ['m1', 'm2', 'm3', 'm4'];
    const pids = ['p1', 'p2', 'p3', ''];
    const msg = () => (r.chance(0.03) ? wild(r, 0) : o(r, [['id', () => pickish(r, ids, 0.05)], ['sessionID', 's1'], ['role', 'user'], ['time', () => o(r, [['created', () => pickish(r, [1, 2, 3, 2, 0, NaN])]], 0.1)]], 0.05));
    const parts = () => (r.chance(0.04) ? wild(r, 1) : list(r, () => (r.chance(0.08) ? r.pick([null, undefined, {}, { id: 0 }, { id: '' }]) : { id: pickish(r, pids, 0.05), type: 'text', text: 't' }), 3, { holes: 0.03, nulls: 0 }));
    if (entry === 'mergeOptimisticPage') {
      const page = o(r, [['session', () => list(r, msg, 4, { holes: 0.02, nulls: 0.01 })], ['part', () => list(r, () => o(r, [['id', () => pickish(r, ids, 0.05)], ['part', parts]], 0.03), 4, { holes: 0.01, nulls: 0.01 })], ['cursor', () => pickish(r, ['c', undefined, null])], ['complete', () => pickish(r, [true, false])], ['extra', 1]], 0.08);
      const items = r.chance(0.97) ? list(r, () => o(r, [['message', msg], ['parts', parts]], 0.04), 3, { holes: 0.01, nulls: 0.01 }) : wild(r, 1);
      return { entry, args: [r.chance(0.97) ? page : wild(r, 1), items] };
    }
    const draft = r.chance(0.96) ? o(r, [['message', () => (r.chance(0.93) ? o(r, [['s1', () => list(r, msg, 4, { holes: 0.02, nulls: 0.01 })], ['s2', () => list(r, msg, 2)], ['10', () => list(r, msg, 1)]], 0.4) : wild(r, 1))], ['part', () => (r.chance(0.93) ? o(r, [['m1', parts], ['m2', parts]], 0.5) : wild(r, 1))]], 0.03) : wild(r, 1);
    if (entry === 'applyOptimisticAdd') return { entry, args: [draft, r.chance(0.97) ? o(r, [['sessionID', () => pickish(r, ['s1', 's2', 's3', '10'], 0.05)], ['message', msg], ['parts', parts]], 0.04) : wild(r, 1)] };
    return { entry, args: [draft, r.chance(0.97) ? o(r, [['sessionID', () => pickish(r, ['s1', 's2', 's3', '10'], 0.05)], ['messageID', () => pickish(r, ids, 0.05)]], 0.05) : wild(r, 1)] };
  },

  'revert-transactions': (r) => {
    const entry = r.pick(['getSessionRevertMessageID', 'getEffectiveSessionRevertMessageID', 'isMessageHiddenByRevert', 'isMessageHiddenByRevert', 'isMessageHiddenByAnyActiveRevert', 'isMessageHiddenByAnyActiveRevert', 'filterMessagesForRevert']);
    const ids = ['m1', 'm2', 'm3', 'm4'];
    if (entry === 'getSessionRevertMessageID') return { entry, args: [r.chance(0.1) ? wild(r, 1) : session(r)] };
    if (entry === 'filterMessagesForRevert') return { entry, args: [list(r, () => message(r, ids), 5, { holes: 0.03, nulls: 0.02 }), pickish(r, [...ids, '', undefined, null, 'zz'], 0.05)] };
    const state = r.chance(0.97) ? revertState(r) : wild(r, 1);
    const s = pickish(r, ['s1', 's2', 's3', '', '0'], 0.05);
    if (entry === 'getEffectiveSessionRevertMessageID') return { entry, args: r.chance(0.4) ? [state, s, r.chance(0.8) ? session(r, ['s1', 's2']) : wild(r, 0)] : [state, s] };
    if (entry === 'isMessageHiddenByRevert') return { entry, args: [state, s, pickish(r, ids, 0.05)] };
    return { entry, args: [state, pickish(r, ids, 0.05)] };
  },

  materialization: (r) => {
    const entry = r.chance(0.8) ? 'materializeSessionSnapshots' : 'getSessionMaterializationStatus';
    const ids = ['m1', 'm2', 'm3', 'm4'];
    const pids = ['p1', 'p2', 'p3'];
    const shared = [];
    const p = () => { if (shared.length && r.chance(0.2)) return r.pick(shared); const x = part(r, pids); if (r.chance(0.3)) shared.push(x); return x; };
    const parts = () => list(r, p, 4, { holes: 0.02, nulls: 0.02 });
    const msgs = () => list(r, () => message(r, ids), 4, { holes: 0.01, nulls: 0.01 });
    const state = r.chance(0.97) ? (() => {
      const st = revertState(r);
      if (r.chance(0.9)) maybe(r, st, 'message', o(r, [['s1', msgs], ['s2', msgs]], 0.3), 0);
      if (r.chance(0.95)) maybe(r, st, 'part', o(r, [['m1', parts], ['m2', parts], ['m3', parts], ['m4', () => pickish(r, [[], undefined, null])]], 0.3), 0);
      return st;
    })() : wild(r, 1);
    const s = pickish(r, ['s1', 's2', 's3'], 0.04);
    if (entry === 'getSessionMaterializationStatus') return { entry, args: [state, s] };
    const known = state && typeof state === 'object' && state.message && typeof state.message === 'object' ? Object.values(state.message).flat().filter((m) => m && typeof m === 'object') : [];
    const record = () => {
      const info = known.length && r.chance(0.4) ? (r.chance(0.5) ? r.pick(known) : perturb(r, r.pick(known))) : message(r, ids);
      return o(r, [['info', info], ['parts', () => (r.chance(0.85) ? list(r, () => (r.chance(0.3) && state?.part?.m1?.length ? perturb(r, r.pick(state.part.m1.filter(Boolean)) ?? part(r, pids)) : p()), 4, { holes: 0.02, nulls: 0.03 }) : r.pick([undefined, null, wild(r, 0)]))]], 0.05);
    };
    const records = list(r, record, 4, { holes: 0.02, nulls: 0.03 });
    const options = r.chance(0.3) ? undefined : o(r, [['skipPartTypes', () => (r.chance(0.85) ? new Set(list(r, () => r.pick(['tool', 'text', 'reasoning', 'step-start']), 2, { holes: 0, nulls: 0 })) : wild(r, 0))], ['mode', () => pickish(r, ['merge', 'prepend', 'Prepend'])], ['revertMessageID', () => pickish(r, [...ids, '', undefined, null])]], 0.4);
    return { entry, args: options === undefined && r.chance(0.5) ? [state, s, records] : [state, s, records, options] };
  },
};
