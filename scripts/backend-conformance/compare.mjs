// The comparer of two recordings of one scenario (BH3; design file 31 §2.2,
// §7, §8.1; modelled on the ledger's dual-run comparer: exact comparison,
// identifiers paired by position, times by window). It judges nothing by
// itself: it names every difference, and every part it cannot compare in full
// (inconclusive, never counted as passed); the closure check
// turns that into outcomes.
//
// Two modes:
//   stability  a reference against a second reference on a fresh data root (R
//              against R'): both sides seen from inside (the tap) and from
//              outside (the client); every component, the edge's headers too.
//   candidate  the reference (its tap: what the group did) against a candidate
//              seen from outside (the client only): the group's exchange (status,
//              the group's own headers, body bytes), the request the candidate
//              was given against what the group received, and the effects.
//
// Every source of difference has a rule (RULES; design §7). There is no
// tolerance, no option to loosen and no mask: a value is either substituted
// exactly by a rule (and the substitution is itself checked), or compared as
// it is. This module imports only Node built-ins, so the comparer's own
// planted-fault test can run a copy of it alone.
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

/** Each rule of design §7, as the comparer applies it. A difference names the rule that found it. */
export const RULES = Object.freeze({
  supplied: 'S: a supplied value (a root: the data root, HOME; a listen or stub port) is replaced by the other arm\'s value of the same name, in each spelling (as given, canonical, the firmlink alias /var for /private/var, URL-encoded), only where it stands as a whole path (or a whole port after a colon); a value that merely contains a root as text, or a path outside every supplied root, is compared as it is',
  paired: 'P: an identifier at a place the group declares is paired with the value the other arm put at the same place (same JSON path), one to one; a conflict is a difference; a value only one side has is never paired; a pair seen only once is reported',
  temporary: 'T: a temporary file name the group declares (<file>.tmp-<pid>-<UUID v4>, the form of a per-save temporary file) is written, in each arm, as its file, {pid} when the number is the pid of one of that arm\'s processes (otherwise the number stays), and its random part\'s rank among that arm\'s own, in the order they first appear (steps in order: each step\'s answers, then its trees\' paths); wherever it stands (bodies, file bytes, paths); a name not of that form is compared as it is',
  'time-window': 'W: a time at a key the group declares, a file\'s mtime and the Date header must fall in the window the harness observed (the exchange\'s, or between two snapshots); times are compared as their window and rank (order and equality within one record); a time outside every window is compared as it is',
  etag: 'ETag is compared exactly (a contract: clients send it back); over a body holding a supplied value (its bytes differ by arm) it must be, on each side, Express\'s weak ETag of that side\'s own body, which the reference\'s value is checked to be (otherwise inconclusive)',
  inode: 'a file is compared as replaced or rewritten in place (descriptors the driver held across the exchange), with its type, mode, bytes and link target; inode numbers and timestamps are never compared as values',
  'last-writer': 'the step that last changed each path (a change of any fact, mtime and inode included) is compared',
  'listing-order': 'each directory\'s listing order is compared exactly (both arms read one file system in one run)',
  bytes: 'bodies and file bytes are compared exactly after the rules above (JSON key order, whitespace, number spelling, error text, duplicate keys, lone surrogates and large integers included)',
  'null-undefined-absent': 'in structured values null, undefined and an absent key are three different things; so are 3 and "3"',
  headers: 'headers by name (case-insensitive), each line\'s value exactly, list headers per element with the element\'s owner; the reference\'s group headers are those the group wrote; Content-Length must equal the body length; Date, Connection, Keep-Alive and Transfer-Encoding are the transport\'s (Date by window); any other header a candidate sends that the group did not set is a difference',
  'edge-files': 'files the reference\'s edge writes are left out of tree comparisons: the ones it rewrites at every start (marked edge in the snapshot) and the ones it writes once at the first start (checked unchanged in every later snapshot); a candidate that has one fails',
  concurrency: 'a concurrent step\'s result must equal one of the outcomes the reference gives when the same requests run one after another (every order): its members\' answers and the tree',
  stream: 'stream items are compared item by item, their count, and how the stream ended',
  effects: 'hub events, outbound calls and child processes are compared in order, field by field',
  request: 'the request a candidate was given must be the request the reference\'s group received (method, URL, headers, body bytes)',
  steps: 'both recordings must have the same steps, of the same kinds, with the same exchanges',
  'log-lines': 'I: server log lines are not compared (no consumer contract; design §2.2, Q4)',
});

/** Response headers that belong to the transport, not to a group (design §2.2 "Edge headers"). */
export const TRANSPORT_HEADERS = Object.freeze(new Set(['date', 'connection', 'keep-alive', 'transfer-encoding']));
/** Headers whose value is a list: compared per element, each with its owner. */
export const LIST_HEADERS = Object.freeze(new Set(['vary', 'cache-control', 'set-cookie']));
const HARNESS_REQUEST_HEADERS = new Set(['x-devryan-harness-envelope', 'x-devryan-harness-seq']);
const SHOW = 160;

// ------------------------------------------------------------------ small values
const b64 = (text) => (typeof text === 'string' ? Buffer.from(text, 'base64') : Buffer.alloc(0));
const shown = (value) => {
  if (value === undefined) return '(undefined)';
  if (Buffer.isBuffer(value)) return value.length > SHOW ? `${value.subarray(0, SHOW).toString('latin1')}… (${value.length} bytes)` : value.toString('latin1');
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text === undefined ? String(value) : text.length > SHOW ? `${text.slice(0, SHOW)}… (${text.length} characters)` : text;
};
/** A value with its type: absent, undefined, null, and each JSON type apart (3 is not "3"). */
export const tagOf = (holder, key) => {
  if (holder !== null && typeof holder === 'object' && !Object.hasOwn(holder, key)) return 'absent';
  const value = holder?.[key];
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
};

/**
 * The first difference between two structured values, or null: the path,
 * and each side as a tagged value. Keys are compared as sets, then in order;
 * null, undefined and absent are kept apart.
 */
export function deepDifference(a, b, where = '$') {
  const typeA = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
  const typeB = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
  if (typeA !== typeB) return { where, reference: `${typeA} ${shown(a)}`, candidate: `${typeB} ${shown(b)}` };
  if (typeA === 'array') {
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) { const found = deepDifference(a[index], b[index], `${where}[${index}]`); if (found) return found; }
    if (a.length !== b.length) return { where: `${where}.length`, reference: a.length, candidate: b.length };
    return null;
  }
  if (typeA === 'object') {
    if (Buffer.isBuffer(a) || Buffer.isBuffer(b)) return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0 ? null : { where, reference: shown(a), candidate: shown(b) };
    for (const key of Object.keys(a)) {
      if (!Object.hasOwn(b, key)) return { where: `${where}.${key}`, reference: `${tagOf(a, key)} ${shown(a[key])}`, candidate: 'absent' };
      const found = deepDifference(a[key], b[key], `${where}.${key}`);
      if (found) return found;
    }
    for (const key of Object.keys(b)) if (!Object.hasOwn(a, key)) return { where: `${where}.${key}`, reference: 'absent', candidate: `${tagOf(b, key)} ${shown(b[key])}` };
    if (!isDeepStrictEqual(Object.keys(a), Object.keys(b))) return { where: `${where}(key order)`, reference: Object.keys(a).join(','), candidate: Object.keys(b).join(',') };
    return null;
  }
  if (typeA === 'number' && Number.isNaN(a) && Number.isNaN(b)) return null;
  return Object.is(a, b) ? null : { where, reference: `${typeA} ${shown(a)}`, candidate: `${typeB} ${shown(b)}` };
}

// ------------------------------------------------------------------ rule S: supplied values
const NAME_CHAR = /[A-Za-z0-9._~%-]/;
const formsOf = (entry) => entry.forms ?? { given: entry.value };
/**
 * Rule S. `from` and `to` are the arm-value lists of two recordings
 * (`recording.values.arm`: `{ name, kind, value, forms }`). Returns `{ apply,
 * problems, pairs, used }`: `apply(buffer)` writes `from`'s supplied values in
 * `to`'s spelling, each only where it stands whole (see boundaries); `used`
 * counts substitutions per value name.
 */
export function createSubstitution(from = [], to = []) {
  const problems = [];
  const pairs = [];
  const byName = new Map(to.map((entry) => [entry.name, entry]));
  for (const entry of from) {
    const other = byName.get(entry.name);
    // A listen port per start: an arm that started more often (the reference's admissible serialisations) has
    // ports the other lacks; those are never written anywhere but the exchange's own Host (paired per exchange).
    if (!other && entry.kind === 'port') continue;
    if (!other) { problems.push(`supplied value ${entry.name} is in one arm only`); continue; }
    if (other.kind !== entry.kind) { problems.push(`supplied value ${entry.name} is a ${entry.kind} in one arm and a ${other.kind} in the other`); continue; }
    if (entry.kind === 'path') {
      const a = formsOf(entry);
      const b = formsOf(other);
      if (a.given === b.given || (a.canonical && a.canonical === b.canonical)) problems.push(`supplied value ${entry.name} is the same path in both arms (${a.given}): the arms share a root`);
      for (const form of ['given', 'canonical', 'alias']) {
        if (!a[form] || !b[form]) continue;
        pairs.push({ name: entry.name, kind: 'path', from: a[form], to: b[form] });
        pairs.push({ name: entry.name, kind: 'path', from: encodeURIComponent(a[form]), to: encodeURIComponent(b[form]) });
      }
    } else if (entry.kind === 'port') {
      if (entry.value === other.value) continue; // the same port: nothing to write
      pairs.push({ name: entry.name, kind: 'port', from: String(entry.value), to: String(other.value) });
    } else if (entry.value !== other.value) problems.push(`supplied value ${entry.name} differs between the arms`);
  }
  for (const entry of to) if (entry.kind !== 'port' && !from.some((item) => item.name === entry.name)) problems.push(`supplied value ${entry.name} is in one arm only`);
  // One spelling, one partner.
  const seen = new Map();
  const unique = [];
  for (const pair of pairs) {
    if (pair.from === pair.to) continue;
    if (seen.has(pair.from)) { if (seen.get(pair.from) !== pair.to) problems.push(`the spelling ${pair.from} would map to two values`); continue; }
    seen.set(pair.from, pair.to);
    unique.push({ ...pair, fromBytes: Buffer.from(pair.from, 'utf8').toString('latin1'), toBytes: Buffer.from(pair.to, 'utf8').toString('latin1') });
  }
  unique.sort((x, y) => y.fromBytes.length - x.fromBytes.length);
  const used = new Map();
  const whole = (pair, text, start, end) => {
    if (pair.kind === 'port') return text[start - 1] === ':' && !/[0-9]/.test(text[end] ?? '');
    const before = text[start - 1];
    const beforeOk = start === 0 || text.slice(Math.max(0, start - 7), start) === 'file://' || (before !== '/' && !NAME_CHAR.test(before) && text.slice(Math.max(0, start - 3), start).toUpperCase() !== '%2F');
    const after = text[end];
    const afterOk = end === text.length || after === '/' || text.slice(end, end + 3).toUpperCase() === '%2F' || !NAME_CHAR.test(after);
    return beforeOk && afterOk;
  };
  /** `buffer` with `from`'s supplied values in `to`'s spelling. */
  const apply = (buffer) => {
    if (!buffer?.length || unique.length === 0) return buffer;
    const text = buffer.toString('latin1');
    const hits = [];
    for (const pair of unique) {
      let at = text.indexOf(pair.fromBytes);
      while (at !== -1) {
        const end = at + pair.fromBytes.length;
        if (whole(pair, text, at, end) && !hits.some((hit) => at < hit.end && end > hit.start)) hits.push({ start: at, end, pair });
        at = text.indexOf(pair.fromBytes, at + 1);
      }
    }
    if (hits.length === 0) return buffer;
    hits.sort((x, y) => x.start - y.start);
    let out = '';
    let cursor = 0;
    for (const hit of hits) { out += text.slice(cursor, hit.start) + hit.pair.toBytes; cursor = hit.end; used.set(hit.pair.name, (used.get(hit.pair.name) ?? 0) + 1); }
    return Buffer.from(out + text.slice(cursor), 'latin1');
  };
  const applyText = (text) => (typeof text === 'string' ? apply(Buffer.from(text, 'utf8')).toString('utf8') : text);
  return { apply, applyText, problems, pairs: unique.map(({ name, kind, from: a, to: b }) => ({ name, kind, from: a, to: b })), used };
}

// ------------------------------------------------------------------ rule P: identifiers paired by position
/**
 * Rule P. `keys`: the object keys at which a group puts identifiers it chose
 * (declared by the group; none for magic-prompts). `align(a, b)` learns a pair
 * wherever both values hold a string at the same JSON path under such a key;
 * `apply(buffer)` writes the reference's identifiers as their partners, each
 * only as a whole token. A value mapped to two partners is a conflict.
 */
export function createPairing({ keys = [] } = {}) {
  const declared = new Set(keys);
  const forward = new Map();
  const backward = new Map();
  const conflicts = [];
  const uses = new Map();
  const learn = (a, b, where) => {
    if (forward.get(a) === b && backward.get(b) === a) return true;
    if (forward.has(a) || backward.has(b)) { conflicts.push({ where, reference: a, candidate: b, had: forward.get(a) ?? null, hadBack: backward.get(b) ?? null }); return false; }
    forward.set(a, b); backward.set(b, a);
    return true;
  };
  const align = (a, b, where = '$') => {
    if (declared.size === 0) return;
    if (Array.isArray(a) && Array.isArray(b)) { a.forEach((item, index) => { if (index < b.length) align(item, b[index], `${where}[${index}]`); }); return; }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      for (const key of Object.keys(a)) {
        if (!Object.hasOwn(b, key)) continue;
        if (declared.has(key) && typeof a[key] === 'string' && typeof b[key] === 'string') learn(a[key], b[key], `${where}.${key}`);
        else align(a[key], b[key], `${where}.${key}`);
      }
    }
  };
  const TOKEN_CHAR = /[A-Za-z0-9_-]/;
  const apply = (buffer) => {
    if (!buffer?.length || forward.size === 0) return buffer;
    let text = buffer.toString('latin1');
    for (const [a, b] of [...forward].sort(([x], [y]) => y.length - x.length)) {
      if (a === b) continue;
      const from = Buffer.from(a, 'utf8').toString('latin1');
      const to = Buffer.from(b, 'utf8').toString('latin1');
      let out = '';
      let cursor = 0;
      let at = text.indexOf(from);
      while (at !== -1) {
        const end = at + from.length;
        if (!TOKEN_CHAR.test(text[at - 1] ?? '') && !TOKEN_CHAR.test(text[end] ?? '')) { out += text.slice(cursor, at) + to; cursor = end; uses.set(a, (uses.get(a) ?? 0) + 1); }
        at = text.indexOf(from, at + 1);
      }
      text = out + text.slice(cursor);
    }
    return Buffer.from(text, 'latin1');
  };
  return { learn, align, apply, conflicts, pairs: () => [...forward], uses, get size() { return forward.size; } };
}

// ------------------------------------------------------------------ rule T: temporary names
const UUID_V4 = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const latin1Of = (base64) => (typeof base64 === 'string' ? Buffer.from(base64, 'base64').toString('latin1') : '');
/**
 * Rule T for one recording. `names`: the temporary names the group declares (`{ file }`: a save writes
 * `<file>.tmp-<pid>-<UUID v4>` and renames it over `<file>`). Each random part gets its rank in the order it
 * first appears in the recording (the start tree, then each step: its answers' bodies, then its trees' paths;
 * then the exit tree); `apply(buffer)` and `applyText(text)` write every such name as
 * `<file>.tmp-{pid}-{tmp <rank>}`, the pid kept as a number when it is no process of this recording's.
 */
export function createTemporaryNames({ names = [], recording = null } = {}) {
  const none = { apply: (buffer) => buffer, applyText: (text) => text, changes: () => false, size: 0 };
  if (!names.length) return none;
  const pids = new Set((recording?.processes ?? []).map((entry) => String(entry.pid)));
  const pattern = new RegExp(`(${names.map((entry) => escapeRegExp(entry.file)).join('|')})\\.tmp-([0-9]+)-(${UUID_V4})`, 'g');
  const ranks = new Map();
  const see = (text) => { if (!text) return; for (const match of text.matchAll(pattern)) if (!ranks.has(match[3])) ranks.set(match[3], ranks.size + 1); };
  const seeTree = (tree) => { for (const name of flatTree(tree).entries.keys()) see(name); };
  if (recording) {
    seeTree(recording.start);
    for (const step of recording.steps ?? []) {
      for (const record of step.exchanges ?? []) { see(latin1Of(record.response?.body)); see(latin1Of(record.tap?.response?.body)); }
      for (const [, tree] of momentsOf(step)) seeTree(tree);
    }
    seeTree(recording.exitTree);
  }
  const label = (text) => text.replace(pattern, (_whole, file, pid, random) => `${file}.tmp-${pids.has(pid) ? '{pid}' : pid}-{tmp ${ranks.get(random) ?? '?'}}`);
  const applyText = (text) => (typeof text === 'string' && text.length ? label(text) : text);
  const apply = (buffer) => {
    if (!buffer?.length) return buffer;
    const text = buffer.toString('latin1');
    const labelled = label(text);
    return labelled === text ? buffer : Buffer.from(labelled, 'latin1');
  };
  const changes = (buffer) => Boolean(buffer?.length) && label(buffer.toString('latin1')) !== buffer.toString('latin1');
  return { apply, applyText, changes, get size() { return ranks.size; } };
}

// ------------------------------------------------------------------ rule W: times by window
/** The windows of one recording: each exchange's [t0, t1], in order, named by step and member. */
export function windowsOf(recording) {
  const windows = [];
  for (const step of recording.steps ?? []) for (const [index, record] of (step.exchanges ?? []).entries()) {
    const response = record.response;
    if (response && Number.isFinite(response.t0) && Number.isFinite(response.t1)) windows.push({ label: `${step.id}${record.member ? `:${record.member}` : index ? `#${index}` : ''}`, start: response.t0, end: response.t1 });
  }
  return windows;
}
/**
 * Rule W for times written at the declared `keys` of a JSON text (bodies and
 * files): each `"key":<number>` becomes `<time <window> #rank of n>` where
 * the window is the exchange window the time falls in and the rank orders the
 * record's times of that window (equal times share a rank). A time outside
 * every window stays as it is. Returns the text and what it labelled.
 */
export function labelTimes(buffer, { keys = [], windows = [] } = {}) {
  if (!keys.length || !buffer?.length) return { buffer, labelled: [] };
  const text = buffer.toString('latin1');
  const found = [];
  for (const key of keys) {
    const quoted = JSON.stringify(key);
    let at = text.indexOf(`${quoted}:`);
    while (at !== -1) {
      const start = at + quoted.length + 1;
      const match = /^\s*(-?\d+(?:\.\d+)?)/.exec(text.slice(start, start + 40));
      if (match) found.push({ key, start: start + match[0].length - match[1].length, end: start + match[0].length, value: Number(match[1]) });
      at = text.indexOf(`${quoted}:`, at + 1);
    }
  }
  const windowOf = (value) => windows.find((window) => value >= window.start && value <= window.end) ?? null;
  const byWindow = new Map();
  for (const item of found) { const window = windowOf(item.value); if (!window) continue; item.window = window.label; (byWindow.get(window.label) ?? byWindow.set(window.label, new Set()).get(window.label)).add(item.value); }
  for (const item of found) if (item.window) { const ranked = [...byWindow.get(item.window)].sort((x, y) => x - y); item.label = `<time ${item.window} #${ranked.indexOf(item.value) + 1} of ${ranked.length}>`; }
  let out = '';
  let cursor = 0;
  for (const item of found.filter((entry) => entry.label).sort((x, y) => x.start - y.start)) { out += text.slice(cursor, item.start) + item.label; cursor = item.end; }
  return { buffer: Buffer.from(out + text.slice(cursor), 'latin1'), labelled: found };
}
/**
 * Rule W for the Date header: the second it names (`at`, whole seconds) had not ended `lagMs` before the
 * exchange's t0, and began by t1: `at + 1000 + lagMs > t0` and `at <= t1`. With no lag that is exactly "the
 * second of t0 or later". The lag is Node's own: Node writes the Date string it cached and clears the cache
 * on a timer due at the next second, which fires late when the loop is busy, so for that long into a second
 * the header still names the one before. It is measured on the run's reference (dateLagOf), never assumed,
 * and it reaches back one second at most (DATE_LAG_CAP_MS): a measured stall longer than that (a loop frozen
 * for a snapshot under heavy load) never lets a date two seconds old pass.
 */
export const DATE_LAG_CAP_MS = 999;
export function dateInWindow(value, { t0, t1 }, lagMs = 0) {
  const at = Date.parse(value);
  if (!Number.isFinite(at) || !Number.isFinite(t0) || !Number.isFinite(t1) || !(Number.isFinite(lagMs) && lagMs >= 0)) return false;
  return at + 1000 + Math.min(lagMs, DATE_LAG_CAP_MS) > t0 && at <= t1;
}
/**
 * How late a recording's Node host was to refresh its cached Date header, in ms: the driver's reading of
 * its tap (recording.dateLagMs: the most any head the tap saw written named a second already over, and the
 * most a timer aimed at a second boundary fired late on that host). 0 when nothing was measured (an arm
 * without a tap): such an arm's Date must name the second of t0 or later.
 */
export const dateLagOf = (recording) => (Number.isFinite(recording?.dateLagMs) && recording.dateLagMs > 0 ? recording.dateLagMs : 0);

// ------------------------------------------------------------------ the comparison context
function createContext({ reference, other, mode, declarations, dateLagMs }) {
  const scenario = reference.scenario;
  const out = { steps: new Map(), differences: [], inconclusive: [], notes: [] };
  const entryFor = (step) => {
    if (!out.steps.has(step)) out.steps.set(step, { differences: [], inconclusive: [], notes: [], edge: false });
    return out.steps.get(step);
  };
  const ctx = {
    scenario, mode, declarations, out, reference, other,
    substitution: null,
    local: null,
    pairing: createPairing({ keys: declarations.identifierKeys ?? [] }),
    // Rule T: each arm's temporary names, labelled by that arm's own processes and order.
    temporary: { reference: createTemporaryNames({ names: declarations.temporaryNames ?? [], recording: reference }), other: createTemporaryNames({ names: declarations.temporaryNames ?? [], recording: other }) },
    windows: { reference: windowsOf(reference), other: windowsOf(other) },
    // Each side's Date lag: a tapped reference its own measurement; a candidate (no tap) the lag measured on the run's reference.
    dateLag: { reference: dateLagOf(reference), other: mode === 'stability' ? dateLagOf(other) : (Number.isFinite(dateLagMs) ? dateLagMs : dateLagOf(reference)), candidate: Number.isFinite(dateLagMs) ? dateLagMs : dateLagOf(reference) },
    edgeFiles: new Set([...(declarations.edgeFiles ?? []), ...(reference.edgeFiles ?? [])]),
    startupFiles: new Set(declarations.startupFiles ?? []),
    step: '(recording)',
    differ(component, location, rule, referenceValue, candidateValue) {
      if (!Object.hasOwn(RULES, rule)) throw new Error(`compare: unknown rule ${rule}`);
      const difference = { scenario, step: ctx.step, component, location, rule, reference: shown(referenceValue), candidate: shown(candidateValue) };
      (ctx.step === '(recording)' ? out.differences : entryFor(ctx.step).differences).push(difference);
    },
    /** A part not compared in full; `check` names it for the row when it is more than "incomplete" (closure.mjs). */
    unsure(component, why, check = undefined) { const item = { scenario, step: ctx.step, component, why, ...(check ? { check } : {}) }; (ctx.step === '(recording)' ? out.inconclusive : entryFor(ctx.step).inconclusive).push(item); },
    note(text) { (ctx.step === '(recording)' ? out.notes : entryFor(ctx.step).notes).push(text); },
    entry: () => entryFor(ctx.step),
  };
  const global = createSubstitution(reference.values?.arm ?? [], other.values?.arm ?? []);
  // Rule S: the recording's supplied values, then (within one exchange) the listen port of that exchange.
  ctx.substitution = {
    problems: global.problems, used: global.used, pairs: global.pairs,
    apply: (buffer) => (ctx.local ? ctx.local.apply(global.apply(buffer)) : global.apply(buffer)),
    applyText: (text) => (ctx.local ? ctx.local.applyText(global.applyText(text)) : global.applyText(text)),
  };
  return ctx;
}
/** The listen port an exchange was sent to (its Host header), or null. */
const portOf = (record) => {
  const host = (record?.response?.request?.headers ?? []).find(([name]) => name.toLowerCase() === 'host')?.[1];
  const match = /:(\d+)$/.exec(host ?? '');
  return match ? Number(match[1]) : null;
};
/** Runs `action` with the exchange's own listen ports paired (rule S, per exchange). */
function withExchangePorts(ctx, a, b, action) {
  const left = portOf(a);
  const right = portOf(b);
  const before = ctx.local;
  ctx.local = left !== null && right !== null && left !== right ? createSubstitution([{ name: 'listen', kind: 'port', value: left }], [{ name: 'listen', kind: 'port', value: right }]) : null;
  try { return action(); } finally { ctx.local = before; }
}
/** The reference's bytes as the other arm must have written them: rule T on both, rule S, then rule P; then rule W on both. */
function rewrite(ctx, buffer, side) {
  if (!buffer) return buffer;
  let bytes = ctx.temporary[side === 'reference' ? 'reference' : 'other'].apply(buffer);
  bytes = side === 'reference' ? ctx.pairing.apply(ctx.substitution.apply(bytes)) : bytes;
  bytes = labelTimes(bytes, { keys: ctx.declarations.timeKeys ?? [], windows: ctx.windows[side] }).buffer;
  return bytes;
}
const parseJson = (buffer) => { try { return { ok: true, value: JSON.parse(buffer.toString('utf8')) }; } catch { return { ok: false }; } };
/** Bytes, exactly; a difference names the first differing offset and, when both parse as JSON, the first differing JSON path. */
function compareBytes(ctx, component, referenceBytes, otherBytes, rule = 'bytes') {
  const left = rewrite(ctx, referenceBytes ?? Buffer.alloc(0), 'reference');
  const right = rewrite(ctx, otherBytes ?? Buffer.alloc(0), 'other');
  if (Buffer.compare(left, right) === 0) return true;
  let offset = 0;
  while (offset < left.length && offset < right.length && left[offset] === right[offset]) offset += 1;
  const a = parseJson(left);
  const b = parseJson(right);
  const path = a.ok && b.ok ? deepDifference(a.value, b.value)?.where ?? '(same JSON value, other bytes)' : null;
  ctx.differ(component, `byte ${offset}${path ? `, JSON ${path}` : ''}`, rule, left.subarray(Math.max(0, offset - 20), offset + 60), right.subarray(Math.max(0, offset - 20), offset + 60));
  return false;
}
function compareValue(ctx, component, rule, referenceValue, otherValue) {
  const left = typeof referenceValue === 'string' ? ctx.substitution.applyText(referenceValue) : referenceValue;
  const found = deepDifference(left, otherValue);
  if (found) ctx.differ(component, found.where, rule, found.reference, found.candidate);
  return !found;
}
function learnPairs(ctx, referenceBytes, otherBytes) {
  if (!(ctx.declarations.identifierKeys ?? []).length || !referenceBytes || !otherBytes) return;
  const a = parseJson(ctx.substitution.apply(referenceBytes));
  const b = parseJson(otherBytes);
  if (a.ok && b.ok) ctx.pairing.align(a.value, b.value);
}

// ------------------------------------------------------------------ exchanges
/** The reference group's exchange from the tap: what the group wrote. */
export function groupView(record) {
  const tap = record?.tap;
  if (!tap || tap.kind !== 'group' || !tap.response) return null;
  const headers = new Map();
  for (const summary of tap.response.headers ?? []) {
    const key = summary.name.toLowerCase();
    if (LIST_HEADERS.has(key) && Array.isArray(summary.elements) && (summary.elements.length || summary.value !== null)) {
      const own = summary.elements.filter((element) => element.owner?.owner === 'group').map((element) => element.value);
      if (own.length) headers.set(key, { name: summary.name, list: true, values: own });
      continue;
    }
    // The group's own last write of the name (an edge that later changed or removed it does not change what the group wrote).
    if (summary.group && summary.group.value !== null && summary.group.value !== undefined) {
      const value = summary.group.value;
      headers.set(key, { name: summary.name, list: LIST_HEADERS.has(key), values: LIST_HEADERS.has(key) ? splitList(key, value) : (Array.isArray(value) ? value.map(String) : [String(value)]) });
    }
  }
  return { status: tap.response.status, headers, body: b64(tap.response.body), effects: effectsOf(tap) };
}
const splitList = (key, value) => (key === 'set-cookie' ? (Array.isArray(value) ? value : [value]).map(String) : (Array.isArray(value) ? value.join(',') : String(value)).split(',').map((part) => part.trim()).filter(Boolean));
/** An exchange as the client saw it: status, headers by name (transport apart), body bytes. */
export function clientView(record) {
  const response = record?.response;
  if (!response) return null;
  const headers = new Map();
  const transport = new Map();
  for (const [name, value] of response.headers ?? []) {
    const key = name.toLowerCase();
    const into = TRANSPORT_HEADERS.has(key) ? transport : headers;
    if (!into.has(key)) into.set(key, { name, list: LIST_HEADERS.has(key), values: [] });
    const slot = into.get(key);
    slot.values.push(...(slot.list ? splitList(key, value) : [value]));
  }
  return { status: response.status, headers, transport, body: b64(response.body), complete: response.complete, error: response.error, t0: response.t0, t1: response.t1, effects: record.effects ?? null };
}
const effectsOf = (tap) => {
  const effects = tap.effects ?? [];
  return { events: effects.filter((effect) => effect.kind === 'hub'), outbound: effects.filter((effect) => effect.kind === 'fetch' || effect.kind === 'http-request'), children: effects.filter((effect) => effect.kind === 'child') };
};

/** Content-Length (when given) equals the body's length. */
function contentLengthCheck(ctx, side, headers, body) {
  const line = headers.get('content-length');
  if (!line) return;
  if (line.values.length !== 1 || Number(line.values[0]) !== body.length) ctx.differ('headers.content-length', `${side}: the body has ${body.length} bytes`, 'headers', side === 'reference' ? line.values.join(',') : body.length, side === 'reference' ? body.length : line.values.join(','));
}
/** Whether a body's bytes differ by arm by rule: it holds a supplied value (rule S), or a temporary name on either side (rule T). */
const bodyVaries = (ctx, referenceBody, otherBody) => Buffer.compare(ctx.substitution.apply(referenceBody), referenceBody) !== 0
  || ctx.temporary.reference.changes(referenceBody) || ctx.temporary.other.changes(otherBody);
/** Express's default weak ETag of a body (the etag package: the length in hex, then 27 characters of the SHA-1 in base64). */
export const weakEtagOf = (body) => `W/"${body.length.toString(16)}-${crypto.createHash('sha1').update(body).digest('base64').slice(0, 27)}"`;
/** Header sets by name: the reference's (group or whole) against the other's; `bodies` are each side's own body bytes. */
function compareHeaderSets(ctx, referenceHeaders, otherHeaders, { substitutedBody, bodies = null }) {
  for (const key of new Set([...referenceHeaders.keys(), ...otherHeaders.keys()])) {
    const left = referenceHeaders.get(key);
    const right = otherHeaders.get(key);
    const component = `headers.${key}`;
    if (!right) { ctx.differ(component, 'missing', 'headers', left.values.join(', '), 'absent'); continue; }
    if (!left) { ctx.differ(component, ctx.mode === 'candidate' ? 'extra: the reference\'s group did not set it' : 'extra', 'headers', 'absent', right.values.join(', ')); continue; }
    // Content-Length: present on both sides, each equal to its own body's length (contentLengthCheck); its
    // value then follows from the body, which is compared by itself (a supplied value may change its length).
    if (key === 'content-length') continue;
    if (key === 'etag') {
      if (substitutedBody) {
        // The bytes differ by arm, so the values do: each must be the same function of its own body, and the reference's must be the known one.
        const [ownLeft, ownRight] = bodies ?? [];
        const isWeakOf = (values, own) => Buffer.isBuffer(own) && values.length === 1 && values[0] === weakEtagOf(own);
        if (!isWeakOf(left.values, ownLeft)) { if (!isDeepStrictEqual(left.values, right.values)) ctx.unsure(component, 'the ETag is computed over a body that holds a supplied value (its bytes differ by arm), and the reference\'s is not Express\'s weak ETag of its own body, so it cannot be compared'); continue; }
        if (!isWeakOf(right.values, ownRight)) ctx.differ(component, 'not the weak ETag of its own body (the body holds a supplied value)', 'etag', `${left.values.join(', ')} (the weak ETag of the reference's body)`, right.values.join(', '));
        continue;
      }
      if (!isDeepStrictEqual(left.values, right.values)) ctx.differ(component, 'value', 'etag', left.values.join(', '), right.values.join(', '));
      continue;
    }
    const values = left.values.map((value) => ctx.substitution.applyText(value));
    if (values.length !== right.values.length) { ctx.differ(component, left.list ? 'elements' : 'lines', 'headers', left.values.join(' | '), right.values.join(' | ')); continue; }
    values.forEach((value, index) => { if (value !== right.values[index]) ctx.differ(component, left.list ? `element ${index}` : `line ${index}`, 'headers', left.values[index], right.values[index]); });
  }
}
/** The transport's headers of a client view: Date by window, the rest framing (not compared). */
function transportChecks(ctx, side, view) {
  const date = view.transport?.get('date');
  if (date) for (const value of date.values) if (!dateInWindow(value, view, ctx.dateLag[side] ?? 0)) ctx.differ('headers.date', `${side}: outside its exchange's window`, 'time-window', side === 'reference' ? value : `${view.t0}..${view.t1}`, side === 'reference' ? `${view.t0}..${view.t1}` : value);
}

/** The body bytes the driver wrote on the wire after a request's head. */
const sentBody = (request) => { const bytes = b64(request?.bytes); const split = bytes.indexOf('\r\n\r\n'); return split >= 0 ? bytes.subarray(split + 4) : Buffer.alloc(0); };
/**
 * The group answered before the request body ended and nothing had read it (no parser of the edge, nothing
 * consumed it before entry): the group cannot depend on bytes it never read, and the bytes sent are known.
 */
const bodyUnread = (tap) => tap?.request?.bodyComplete === false && !tap.aborted && Boolean(tap.response) && tap.entry?.bodyParsedByEdge === false && tap.entry?.bodyConsumedBeforeEntry === false;
/** The tap's seen bytes against what the driver sent on that arm: a prefix (or all of it when the tap saw the body end), or why not. */
function seenAsPrefix(tap, sent) {
  const seen = b64(tap?.request?.body);
  if (seen.length > sent.length || Buffer.compare(seen, sent.subarray(0, seen.length)) !== 0) return `the tap saw ${seen.length} bytes that are not a prefix of the ${sent.length} bytes the driver sent`;
  if (tap?.request?.bodyComplete !== false && seen.length !== sent.length) return `the tap saw the body end after ${seen.length} of the ${sent.length} bytes the driver sent`;
  return null;
}

/**
 * The message body of chunked bytes as Node's parser hands it on (chunk sizes and extensions and the trailer
 * dropped), or null when the framing is not complete chunked coding.
 */
export function dechunk(bytes) {
  const pieces = [];
  let at = 0;
  for (;;) {
    const line = bytes.indexOf('\r\n', at);
    if (line < 0) return null;
    const size = /^([0-9a-fA-F]+)(?:;.*)?$/s.exec(bytes.subarray(at, line).toString('latin1'));
    if (!size) return null;
    const length = Number.parseInt(size[1], 16);
    at = line + 2;
    if (length === 0) return Buffer.concat(pieces);
    if (at + length + 2 > bytes.length || bytes[at + length] !== 0x0d || bytes[at + length + 1] !== 0x0a) return null;
    pieces.push(bytes.subarray(at, at + length));
    at += length + 2;
  }
}

/** The request the candidate was given against the one the reference's group received (rule request). */
function compareRequest(ctx, referenceRecord, otherRecord, referenceStep) {
  const tap = referenceRecord.tap;
  const sent = otherRecord.response?.request;
  if (!sent) { ctx.unsure('request', 'the candidate\'s request was not recorded'); return; }
  const bytes = b64(sent.bytes);
  const split = bytes.indexOf('\r\n\r\n');
  const framed = split >= 0 ? bytes.subarray(split + 4) : Buffer.alloc(0);
  // A chunked request is compared by its message body: the tap sees what Node's parser hands on, not the framing.
  const chunked = (sent.headers ?? []).some(([name, value]) => name.toLowerCase() === 'transfer-encoding' && /\bchunked\b/i.test(value));
  const body = chunked ? dechunk(framed) : framed;
  if (body === null) { ctx.unsure('request.body', 'the candidate\'s chunked request body is not complete chunked coding'); return; }
  if (tap.entry?.method !== sent.method) ctx.differ('request.method', 'method', 'request', tap.entry?.method, sent.method);
  if (ctx.substitution.applyText(tap.entry?.url ?? '') !== sent.target) ctx.differ('request.url', 'the URL the group saw', 'request', tap.entry?.url, sent.target);
  const theirs = (sent.headers ?? []).filter(([name]) => !HARNESS_REQUEST_HEADERS.has(name.toLowerCase())).map(([name, value]) => [name.toLowerCase(), value]);
  const raw = tap.entry?.rawHeaders ?? [];
  const ours = [];
  for (let index = 0; index + 1 < raw.length; index += 2) ours.push([raw[index].toLowerCase(), ctx.substitution.applyText(raw[index + 1])]);
  const found = deepDifference(ours, theirs);
  if (found) ctx.differ('request.headers', found.where, 'request', found.reference, found.candidate);
  if (tap.request?.bodyComplete === false) {
    // The group answered before the body ended. Judged deterministically when nothing read the body (S5 of the
    // BH3/BH4 review): the tap's seen bytes must be a prefix of the bytes the driver sent the reference, and
    // the candidate must be given exactly those bytes; how many the tap saw by then is timing, never compared.
    if (!bodyUnread(tap)) { ctx.unsure('request.body', 'the reference\'s tap saw an incomplete request body that something may have read'); return; }
    const referenceSent = sentBody(referenceRecord.response?.request);
    const notPrefix = seenAsPrefix(tap, referenceSent);
    if (notPrefix) { ctx.unsure('request.body', `the reference: ${notPrefix}`); return; }
    if (Buffer.compare(ctx.substitution.apply(referenceSent), body) !== 0) ctx.differ('request.body', 'the bytes sent (the reference\'s group answered before reading them)', 'request', referenceSent, body);
    else ctx.note(`request body: the reference's group answered before reading it (the tap saw ${b64(tap.request?.body).length} of ${referenceSent.length} bytes${referenceStep?.requestBodyUnread ? '' : ''}, a prefix of what was sent); the candidate was given exactly the sent bytes`);
    return;
  }
  const groupBody = b64(tap.request?.body);
  if (Buffer.compare(ctx.substitution.apply(groupBody), body) !== 0) ctx.differ('request.body', 'bytes', 'request', groupBody, body);
}

/** An outbound call's target as host:port/path (the tap's fetch URL or http.request fields, a stub's record). */
const targetOf = (effect) => {
  if (effect.target) return effect.target;
  if (effect.url) { try { const url = new URL(effect.url); return `${url.hostname}:${url.port}${url.pathname}${url.search}`; } catch { return effect.url; } }
  return `${effect.host}:${effect.port}${effect.path}`;
};
const bodyBytes = (body) => (Array.isArray(body) ? Buffer.concat(body.map((chunk) => b64(chunk))) : typeof body === 'string' ? b64(body) : Buffer.alloc(0)).toString('base64');
const baseName = (file) => String(file ?? '').split('/').pop();
/** A child's arguments without its own name (Node's spawn options carry argv[0], a shim's "$@" does not). */
const argsOf = (effect) => { const args = effect.args ?? []; return args.length && baseName(args[0]) === baseName(effect.file) && effect.argvHasName !== false ? args.slice(1) : args; };
/**
 * What an observation from outside can see of an effect (the candidate's PATH shim, its stubs, the
 * process-group look; `seenBy` on the candidate's effect): a child's program name and arguments, an
 * outbound call's method, host:port/path and body bytes. Headers, the environment and stdin are not seen
 * there; when the reference's effect has them they are said to be not compared (inconclusive).
 */
function outsideView(kind, effect) {
  if (kind === 'children') return { name: baseName(effect.file), args: argsOf(effect) };
  return { method: effect.method, target: targetOf(effect), body: bodyBytes(effect.body) };
}

/**
 * Effects in order (rule effects). In candidate mode the candidate's side is `null` when its arm was not run
 * under observation: that is never "no effects" (inconclusive, `candidate-effects-unobserved`). A kind the
 * observing arm does not report (`null`, such as hub events, which a candidate publishes only through the
 * protocol's /events, not read) is inconclusive when the reference made one or the group can cause one.
 */
function compareEffects(ctx, referenceEffects, otherEffects) {
  if (ctx.mode === 'candidate' && (otherEffects === null || otherEffects === undefined)) {
    ctx.unsure('effects', 'the candidate arm was not run under observation (no PATH shim, no stubs, no process-group look): its effects are unknown, never taken as none', 'candidate-effects-unobserved');
  }
  for (const kind of ['events', 'outbound', 'children']) {
    const left = referenceEffects?.[kind] ?? [];
    const canCause = (ctx.declarations.effects ?? []).includes(kind);
    const right = otherEffects?.[kind];
    if (right === undefined || right === null) {
      if (left.length) ctx.unsure(kind, `the reference made ${left.length} ${kind}; the ${ctx.mode === 'candidate' ? 'candidate' : 'other'} arm's ${kind} are not observed`);
      else if (canCause) ctx.unsure(kind, `the group can cause ${kind} and the other arm's are not observed`);
      if (left.length && !canCause) ctx.differ(kind, 'the group is declared unable to cause them', 'effects', left.length, 'declared none');
      continue;
    }
    if (left.length !== right.length) ctx.differ(`${kind}(count)`, 'count', 'effects', left.length, right.length);
    const view = (effect) => (kind === 'events' ? { channel: effect.channel, payload: effect.payload }
      : kind === 'outbound' ? { method: effect.method, url: effect.url ?? `${effect.host}:${effect.port}${effect.path}`, headers: effect.headers, body: effect.body }
        : { file: effect.file, args: effect.args, cwd: effect.cwd, env: effect.env ?? effect.environment ?? null, stdin: effect.stdin ?? null });
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      const outside = Boolean(right[index].seenBy) && kind !== 'events';
      const a = JSON.parse(ctx.substitution.applyText(JSON.stringify(outside ? outsideView(kind, left[index]) : view(left[index]))));
      const found = deepDifference(a, outside ? outsideView(kind, right[index]) : view(right[index]));
      if (found) ctx.differ(`${kind}[${index}]`, found.where, 'effects', found.reference, found.candidate);
      if (outside && ((kind === 'outbound' && left[index].headers?.length) || (kind === 'children' && (left[index].cwd || (left[index].env && Object.keys(left[index].env).length) || left[index].stdin?.length)))) ctx.unsure(`${kind}[${index}]`, `seen by the candidate's ${right[index].seenBy}, which does not see ${kind === 'outbound' ? 'request headers' : 'the working directory, the environment or stdin'}; the reference's are not compared`);
    }
  }
}

/** One group exchange (candidate mode): the reference's group view against the candidate's client view. */
function compareGroupExchange(ctx, referenceRecord, otherRecord, referenceStep) {
  const left = groupView(referenceRecord);
  const right = clientView(otherRecord);
  if (!left) { ctx.unsure('exchange', 'the reference\'s tap has no group record of this exchange'); return; }
  if (!right || right.status === null) { ctx.differ('status', 'no answer', 'bytes', left.status, right?.error ?? 'no response'); return; }
  compareRequest(ctx, referenceRecord, otherRecord, referenceStep);
  if (left.status !== right.status) ctx.differ('status', 'status', 'bytes', left.status, right.status);
  if (!right.complete) ctx.differ('body', 'the candidate\'s response was not complete', 'bytes', 'complete', right.error ?? 'incomplete');
  learnPairs(ctx, left.body, right.body);
  const substitutedBody = bodyVaries(ctx, left.body, right.body);
  compareHeaderSets(ctx, left.headers, right.headers, { substitutedBody, bodies: [left.body, right.body] });
  if (referenceRecord.tap?.entry?.method === 'HEAD') {
    // A HEAD answer has no body: its Content-Length is the GET body's length, compared as a value (both must have it).
    const [x, y] = [left.headers.get('content-length')?.values ?? null, right.headers.get('content-length')?.values ?? null];
    if (x && y && !isDeepStrictEqual(x, y)) ctx.differ('headers.content-length', 'HEAD: the value', 'headers', x.join(','), y.join(','));
  } else {
    contentLengthCheck(ctx, 'reference', left.headers, left.body);
    contentLengthCheck(ctx, 'candidate', right.headers, right.body);
  }
  transportChecks(ctx, 'candidate', right);
  // Date is the transport's, but its presence is a rule: the reference's wire has one exactly when the candidate's must.
  const wire = clientView(referenceRecord);
  if (wire && wire.transport.has('date') !== right.transport.has('date')) ctx.differ('headers.date', 'presence', 'headers', wire.transport.has('date') ? 'present' : 'absent', right.transport.has('date') ? 'present' : 'absent');
  compareBytes(ctx, 'body', left.body, right.body);
  compareEffects(ctx, left.effects, right.effects);
}

/** One exchange of two references (stability mode): outside and inside views, every component. */
function compareReferenceExchange(ctx, a, b) {
  const left = clientView(a);
  const right = clientView(b);
  if (!left || !right) { if (!left !== !right) ctx.differ('exchange', 'one side has no response', 'steps', left ? 'a response' : 'none', right ? 'a response' : 'none'); return; }
  if (left.status !== right.status) ctx.differ('status', 'client status', 'bytes', left.status, right.status);
  if (Boolean(left.complete) !== Boolean(right.complete)) ctx.differ('response(complete)', 'complete', 'bytes', left.complete, right.complete);
  if (Boolean(left.error) !== Boolean(right.error)) ctx.differ('response(error)', 'error', 'bytes', left.error, right.error);
  transportChecks(ctx, 'reference', left);
  transportChecks(ctx, 'other', right);
  learnPairs(ctx, left.body, right.body);
  const substitutedBody = bodyVaries(ctx, left.body, right.body);
  const wireHeaders = (view) => new Map([...view.headers, ...[...view.transport].filter(([key]) => key !== 'date')]);
  compareHeaderSets(ctx, wireHeaders(left), wireHeaders(right), { substitutedBody, bodies: [left.body, right.body] });
  if (left.transport.has('date') !== right.transport.has('date')) ctx.differ('headers.date', 'presence', 'headers', left.transport.has('date'), right.transport.has('date'));
  compareBytes(ctx, 'body', left.body, right.body);
  // Inside: the tap's records.
  const tapA = a.tap;
  const tapB = b.tap;
  if (!tapA !== !tapB) { ctx.differ('tap', 'record', 'steps', tapA ? 'recorded' : 'none', tapB ? 'recorded' : 'none'); return; }
  if (!tapA) return;
  if (tapA.kind !== tapB.kind) { ctx.differ('tap.kind', 'who answered', 'steps', tapA.kind, tapB.kind); return; }
  if (tapA.kind === 'group') {
    const groupA = groupView(a);
    const groupB = groupView(b);
    if (groupA.status !== groupB.status) ctx.differ('status', 'group status', 'bytes', groupA.status, groupB.status);
    compareHeaderSets(ctx, groupA.headers, groupB.headers, { substitutedBody, bodies: [groupA.body, groupB.body] });
    compareBytes(ctx, 'body', groupA.body, groupB.body);
    compareEffects(ctx, groupA.effects, groupB.effects);
    // Every header of the final head with its owner (and each element's owner), Date apart.
    // Over a body holding a supplied value, an ETag that is the weak ETag of its own body is that (rule etag), whatever its bytes.
    const ownEtag = (name, value, body) => (substitutedBody && name.toLowerCase() === 'etag' && value === weakEtagOf(body) ? '<the weak ETag of its own body>' : value);
    const owners = (tap, body) => (tap.response.headers ?? []).filter((summary) => summary.name.toLowerCase() !== 'date').map((summary) => ({ name: summary.name.toLowerCase(), value: ownEtag(summary.name, summary.value, body), owner: summary.owner, group: summary.group ? { ...summary.group, value: ownEtag(summary.name, summary.group.value, body) } : summary.group, elements: summary.elements ?? null }));
    compareValue(ctx, 'headers(owners)', 'headers', JSON.parse(ctx.substitution.applyText(JSON.stringify(owners(tapA, groupA.body).filter((item) => item.name !== 'content-length')))), JSON.parse(JSON.stringify(owners(tapB, groupB.body).filter((item) => item.name !== 'content-length'))));
    const entry = (tap) => ({ method: tap.entry?.method, url: tap.entry?.url, originalUrl: tap.entry?.originalUrl, principal: tap.entry?.principal, context: tap.entry?.context, registration: { kind: tap.entry?.registration?.kind, method: tap.entry?.registration?.method, path: tap.entry?.registration?.path }, edgeHeaders: tap.entry?.edgeHeaders, statusAtEntry: tap.entry?.statusAtEntry });
    compareValue(ctx, 'entry', 'request', JSON.parse(ctx.substitution.applyText(JSON.stringify(entry(tapA)))), JSON.parse(JSON.stringify(entry(tapB))));
    compareReferenceBodies(ctx, a, b);
  } else {
    compareValue(ctx, 'answeredBy', 'steps', tapA.answeredBy, tapB.answeredBy);
  }
}

/**
 * The request bodies two references' groups received (stability mode). When either group answered before its
 * body ended, how many bytes its tap saw is timing: each tap's seen bytes must then be a prefix of what the
 * driver sent that arm (an unread body only), and the bytes sent are compared instead (rule S applies).
 */
function compareReferenceBodies(ctx, a, b) {
  const tapA = a.tap;
  const tapB = b.tap;
  if (tapA.request?.bodyComplete !== false && tapB.request?.bodyComplete !== false) { compareBytes(ctx, 'request.body', b64(tapA.request?.body), b64(tapB.request?.body), 'request'); return; }
  for (const [side, tap, record] of [['reference', tapA, a], ['other', tapB, b]]) {
    if (tap.request?.bodyComplete === false && !bodyUnread(tap)) { ctx.unsure('request.body', `the ${side} arm's tap saw an incomplete request body that something may have read`); return; }
    const notPrefix = seenAsPrefix(tap, sentBody(record.response?.request));
    if (notPrefix) { ctx.unsure('request.body', `the ${side} arm: ${notPrefix}`); return; }
  }
  compareBytes(ctx, 'request.body', sentBody(a.response?.request), sentBody(b.response?.request), 'request');
}

// ------------------------------------------------------------------ trees
/** Entries of a snapshot by root-prefixed path ('' data root, 'home:' HOME), the order lists alike; `name` rewrites each path and listed name (rule T). */
function flatTree(tree, name = (text) => text) {
  const entries = new Map();
  const order = new Map();
  if (!tree) return { entries, order };
  for (const entry of tree.entries ?? []) entries.set(name(entry.path), entry);
  for (const [dir, names] of Object.entries(tree.order ?? {})) order.set(name(dir), names.map(name));
  for (const [root, part] of Object.entries(tree.roots ?? {})) {
    for (const entry of part.entries ?? []) entries.set(name(`${root}:${entry.path}`), { ...entry, path: `${root}:${entry.path}` });
    for (const [dir, names] of Object.entries(part.order ?? {})) order.set(name(`${root}:${dir}`), names.map(name));
  }
  return { entries, order };
}
const isEdgePath = (ctx, entryPath, entry) => entry?.edge === true || ctx.edgeFiles.has(entryPath) || ctx.startupFiles.has(entryPath);
/** One snapshot against the other (rule inode for types and bytes, listing order, edge files). */
function compareTrees(ctx, moment, referenceTree, otherTree) {
  if (!referenceTree || !otherTree) {
    if (!referenceTree !== !otherTree) ctx.differ(`tree(${moment})`, 'snapshot', 'steps', referenceTree ? 'taken' : 'none', otherTree ? 'taken' : 'none');
    return;
  }
  if (referenceTree.stable === false || otherTree.stable === false) { ctx.unsure(`tree(${moment})`, 'a snapshot is not stable (two walks disagreed)'); return; }
  // Each tracked root's own permission bits (the root is not an entry of its walk).
  for (const [prefix, a, b] of [['', referenceTree.rootMode, otherTree.rootMode], ...Object.keys({ ...(referenceTree.roots ?? {}), ...(otherTree.roots ?? {}) }).map((name) => [`${name}:`, referenceTree.roots?.[name]?.rootMode, otherTree.roots?.[name]?.rootMode])]) {
    if (a === undefined && b === undefined) continue;
    if (a !== b) ctx.differ(`tree.${prefix}(root).mode`, moment, 'inode', a === undefined ? 'not recorded' : a.toString(8), b === undefined ? 'not recorded' : b.toString(8));
  }
  const left = flatTree(referenceTree, ctx.temporary.reference.applyText);
  const right = flatTree(otherTree, ctx.temporary.other.applyText);
  for (const pathName of new Set([...left.entries.keys(), ...right.entries.keys()])) {
    const a = left.entries.get(pathName);
    const b = right.entries.get(pathName);
    const component = `tree.${pathName}`;
    if (a && isEdgePath(ctx, pathName, a)) {
      // The reference's edge files: never the group's. In stability mode both references have them.
      if (ctx.mode === 'candidate' && b) ctx.differ(component, `${moment}: a file only the reference's edge writes`, 'edge-files', 'the edge\'s', `${b.type} written by the candidate`);
      continue;
    }
    if (!a && b && isEdgePath(ctx, pathName, b)) { if (ctx.mode === 'candidate') ctx.differ(component, `${moment}: a file only the reference's edge writes`, 'edge-files', 'absent', `${b.type} written by the candidate`); continue; }
    if (!a) { ctx.differ(component, `${moment}: extra`, 'inode', 'absent', `${b.type}${b.size !== null ? ` of ${b.size} bytes` : ''}`); continue; }
    if (!b) { ctx.differ(component, `${moment}: missing`, 'inode', `${a.type}${a.size !== null ? ` of ${a.size} bytes` : ''}`, 'absent'); continue; }
    if (a.type !== b.type) { ctx.differ(`${component}.type`, moment, 'inode', a.type, b.type); continue; }
    if (a.mode !== b.mode) ctx.differ(`${component}.mode`, moment, 'inode', a.mode.toString(8), b.mode.toString(8));
    if (a.type === 'symlink' && ctx.substitution.applyText(a.target) !== b.target) ctx.differ(`${component}.link`, moment, 'inode', a.target, b.target);
    if (a.type === 'file' && (a.unreadable || b.unreadable)) {
      // A file whose mode forbids reading it (walkTree): its bytes are nobody's to compare; type, mode, size and last writer are.
      if (a.unreadable !== b.unreadable) ctx.differ(`${component}.bytes`, `${moment}: readable on one arm only`, 'inode', a.unreadable ? 'unreadable' : 'readable', b.unreadable ? 'unreadable' : 'readable');
      else if (a.size !== b.size) ctx.differ(`${component}.size`, `${moment}: unreadable on both arms`, 'inode', a.size, b.size);
      else ctx.note(`${component}: unreadable on both arms (mode ${a.mode.toString(8)}): its bytes are not compared`);
      continue;
    }
    if (a.type === 'file') {
      const bytesA = ctx.reference.blobs?.[a.sha256];
      const bytesB = ctx.other.blobs?.[b.sha256];
      if (bytesA === undefined || bytesB === undefined) {
        if (a.sha256 !== b.sha256 || a.size !== b.size) ctx.unsure(`${component}.bytes`, `${moment}: the bytes of a file over the snapshot's byte limit were not kept, and the digests differ`);
        else ctx.unsure(`${component}.bytes`, `${moment}: the bytes were not kept (over the limit); equal digests cannot show that no supplied value is in them`);
        continue;
      }
      learnPairs(ctx, b64(bytesA), b64(bytesB));
      compareBytes(ctx, `${component}.bytes`, b64(bytesA), b64(bytesB));
    }
  }
  for (const dir of new Set([...left.order.keys(), ...right.order.keys()])) {
    const keep = (names, tree) => (names ?? []).filter((name) => { const full = dir === '.' ? name : dir.endsWith(':.') ? `${dir.slice(0, -1)}${name}` : `${dir}/${name}`; return !isEdgePath(ctx, full, tree.entries.get(full)); });
    const a = keep(left.order.get(dir), left);
    const b = keep(right.order.get(dir), right);
    if (!isDeepStrictEqual(a, b) && a.length === b.length && new Set(a).size === new Set([...a, ...b]).size) ctx.differ(`tree.${dir}(listing order)`, moment, 'listing-order', a.join(','), b.join(','));
  }
}

/** The moments of one step at which a snapshot was taken, in order: [moment, tree]. */
function momentsOf(step) {
  const out = [];
  const add = (moment, tree) => { if (tree) out.push([moment, tree]); };
  if (step.kind === 'exchange') for (const [index, record] of (step.exchanges ?? []).entries()) { const tag = index ? `#${index}` : ''; add(`S1${tag}`, record.s1); add(`S2${tag}`, record.s2); }
  else if (step.kind === 'concurrent') { add('S1', step.s1); add('S2', step.s2); add('restored', step.restored); }
  else if (step.kind === 'staged') { add('S1', step.s1); add('S2', step.s2); }
  else if (step.kind === 'kill-after') { add('S1', step.exchanges?.[0]?.s1); add('started', step.afterRestart); }
  else add(step.kind === 'restart' ? 'started' : 'tree', step.tree);
  add('late', step.lateTree);
  add('died', step.afterDeath);
  return out;
}
/** Every snapshot of a recording in order, for the last-writer and mtime rules. */
function timelineOf(recording) {
  const timeline = [];
  if (recording.start) timeline.push({ step: '(start)', moment: 'start', tree: recording.start });
  for (const step of recording.steps ?? []) for (const [moment, tree] of momentsOf(step)) timeline.push({ step: step.id, moment, tree });
  if (recording.exitTree) timeline.push({ step: '(exit)', moment: 'exit', tree: recording.exitTree });
  return timeline;
}
const factKey = (entry) => (entry ? JSON.stringify([entry.type, entry.mode, entry.size, entry.sha256 ?? null, entry.target ?? null, entry.ino, entry.mtimeMs]) : 'absent');
/**
 * Rules last-writer and W (mtime) for one recording: for each step, the
 * paths whose facts (bytes, mode, inode, mtime: anything) changed during it,
 * and an mtime outside the span between the two snapshots it changed
 * between. The harness's own restore (admissible sets) is a new baseline,
 * not a write (it makes new inodes and keeps mtimes).
 */
export function writersOf(recording, isEdge = () => false) {
  const timeline = timelineOf(recording);
  // The file system stamps mtimes from its own clock, which may lag Date.now() (Linux: the coarse clock, one
  // tick): the lower bound is widened by the lag the driver measured once per run (recording.mtimeGranularityMs).
  const granularity = Number.isFinite(recording.mtimeGranularityMs) && recording.mtimeGranularityMs > 0 ? recording.mtimeGranularityMs : 0;
  const touched = new Map();
  const mtimeProblems = [];
  const startupChanged = [];
  for (let index = 1; index < timeline.length; index += 1) {
    const previous = flatTree(timeline[index - 1].tree).entries;
    const current = flatTree(timeline[index].tree).entries;
    const { step, moment, tree } = timeline[index];
    // The harness's own restore after the admissible serialisations (new inodes, kept mtimes): a new baseline, not a write.
    if (moment === 'restored') continue;
    for (const name of new Set([...previous.keys(), ...current.keys()])) {
      if (factKey(previous.get(name)) === factKey(current.get(name))) continue;
      if (isEdge(name, current.get(name) ?? previous.get(name), 'startup')) { if (step !== '(start)') startupChanged.push({ step, moment, path: name }); continue; }
      if (isEdge(name, current.get(name) ?? previous.get(name), 'any')) continue;
      if (!touched.has(step)) touched.set(step, new Set());
      touched.get(step).add(name);
      const entry = current.get(name);
      const span = { start: timeline[index - 1].tree.takenAt?.end, end: tree.takenAt?.start };
      if (entry && entry.type === 'file' && Number.isFinite(span.start) && Number.isFinite(span.end) && !(entry.mtimeMs >= span.start - granularity && entry.mtimeMs <= span.end + 1)) {
        mtimeProblems.push({ step, moment, path: name, mtimeMs: entry.mtimeMs, span });
      }
    }
  }
  return { touched, mtimeProblems, startupChanged };
}

// ------------------------------------------------------------------ steps
const recordsByKey = (step) => new Map((step.exchanges ?? []).map((record, index) => [record.member ?? `#${index}`, record]));
function compareExchanges(ctx, referenceStep, otherStep) {
  const left = recordsByKey(referenceStep);
  const right = recordsByKey(otherStep);
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(key);
    const b = right.get(key);
    if (!a || !b) { ctx.differ(`exchange ${key}`, 'presence', 'steps', a ? 'made' : 'none', b ? 'made' : 'none'); continue; }
    if (a.notSent !== undefined) {
      ctx.unsure(`exchange ${key}`, `the reference did not make this exchange: ${a.notSent}`);
      continue;
    }
    if (a.point && !a.response?.complete) {
      // A kill before the answer: neither arm may have answered; what the kill left is in the trees.
      if (b.response?.complete) ctx.differ(`exchange ${key}`, 'killed before its answer', 'steps', 'no complete answer', `status ${b.response.status}`);
      if (a.exit?.signal !== b.exit?.signal) ctx.differ('kill(exit)', 'signal', 'steps', a.exit?.signal, b.exit?.signal);
      continue;
    }
    withExchangePorts(ctx, a, b, () => compareOneExchange(ctx, referenceStep, key, a, b));
  }
}
function compareOneExchange(ctx, referenceStep, key, a, b) {
  {
    if (ctx.mode === 'candidate') {
      // An exchange the edge, or what the server composes after the group (the tail), answers: never the group's.
      if (a.tap?.kind === 'edge' || a.tap?.kind === 'tail') {
        Object.assign(ctx.entry(), { edge: true, answeredBy: a.tap.kind });
        if (b.notSent === undefined) ctx.differ(`exchange ${key}`, 'an edge exchange was sent to the candidate', 'steps', 'not sent (the edge answers it)', 'sent');
        return;
      }
      if (b.notSent !== undefined) { ctx.unsure(`exchange ${key}`, `the candidate was not given this exchange: ${b.notSent}`); return; }
      compareGroupExchange(ctx, a, b, referenceStep);
    } else {
      if (b.notSent !== undefined) { ctx.differ(`exchange ${key}`, 'presence', 'steps', 'made', `not sent: ${b.notSent}`); return; }
      if (a.tap?.kind === 'edge' || a.tap?.kind === 'tail') Object.assign(ctx.entry(), { edge: true, answeredBy: a.tap.kind });
      compareReferenceExchange(ctx, a, b);
    }
    // Rule inode: which files the exchange replaced (a new inode at the path) and which it removed.
    const strip = (keys) => (keys ?? []).map((item) => item.replace(/^0:/, '').replace(/^1:/, 'home:')).filter((name) => !isEdgePath(ctx, name, null));
    for (const field of ['replaced', 'removed']) {
      const x = strip(a[field]).sort();
      const y = strip(b[field]).sort();
      for (const name of new Set([...x, ...y])) if (x.includes(name) !== y.includes(name)) ctx.differ(`tree.${name}.${field === 'replaced' ? 'replaced' : 'removed'}`, `exchange ${key}`, 'inode', x.includes(name) ? field : `rewritten in place or kept`, y.includes(name) ? field : 'rewritten in place or kept');
    }
    if (a.point || b.point) {
      // A kill-after exchange: how the arm died.
      if (a.exit?.signal !== b.exit?.signal) ctx.differ('kill(exit)', 'signal', 'steps', a.exit?.signal, b.exit?.signal);
    }
  }
}

/** §5.6: the other arm's concurrent result is one of the reference's serialisations. */
function compareConcurrent(ctx, referenceStep, otherStep) {
  const serials = referenceStep.admissible;
  if (!Array.isArray(serials) || serials.length === 0) { ctx.unsure('concurrency', 'the reference recorded no admissible serialisations for this step'); return; }
  const tried = [];
  for (const serial of serials) {
    if (!serial.tree) { tried.push({ order: serial.order, first: 'the serialisation has no final tree' }); continue; }
    // Each serialisation is compared with a scratch context: its differences decide admissibility, never the row by themselves.
    const scratch = createContext({ reference: ctx.reference, other: ctx.other, mode: ctx.mode, declarations: ctx.declarations, dateLagMs: ctx.dateLag.candidate });
    scratch.step = ctx.step;
    scratch.pairing = ctx.pairing;
    compareExchanges(scratch, { ...serial, kind: 'concurrent', exchanges: serial.exchanges.map((record) => ({ ...record, replaced: undefined, removed: undefined })) }, { ...otherStep, exchanges: otherStep.exchanges.map((record) => ({ ...record, replaced: undefined, removed: undefined })) });
    compareTrees(scratch, 'S2', serial.tree, otherStep.s2);
    const found = scratch.out.steps.get(ctx.step) ?? { differences: [], inconclusive: [] };
    if (found.differences.length === 0 && found.inconclusive.length === 0) { ctx.note(`the concurrent result equals the serialisation ${serial.order.join(' then ')}`); return; }
    tried.push({ order: serial.order, first: found.differences[0] ?? found.inconclusive[0] });
  }
  ctx.differ('concurrency(not admissible)', `none of the ${serials.length} serialisations`, 'concurrency', tried.map((item) => `${item.order.join(',')}`).join(' | '), tried.map((item) => `${item.order.join(',')}: ${typeof item.first === 'string' ? item.first : `${item.first.component} ${item.first.location ?? item.first.why}`}`).join(' | '));
}

function compareStreams(ctx, referenceStep, otherStep) {
  for (const field of ['items', 'itemsToEnd', 'trailing']) {
    const a = referenceStep[field];
    const b = otherStep[field];
    if (a === undefined && b === undefined) continue;
    const left = (a ?? []).map((item) => ctx.substitution.applyText(item));
    const right = b ?? [];
    if (left.length !== right.length) ctx.differ('stream(count)', field, 'stream', left.length, right.length);
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) if (left[index] !== right[index]) ctx.differ(`stream[${index}]`, field, 'stream', left[index], right[index]);
  }
  if ((referenceStep.partial ?? '') !== (otherStep.partial ?? '')) ctx.differ('stream(end)', 'bytes after the last item', 'stream', referenceStep.partial ?? '', otherStep.partial ?? '');
  if (Boolean(referenceStep.endedBeforeClose) !== Boolean(otherStep.endedBeforeClose)) ctx.differ('stream(end)', 'ended before the client closed it', 'stream', Boolean(referenceStep.endedBeforeClose), Boolean(otherStep.endedBeforeClose));
  if (referenceStep.kind === 'stream-open') {
    const a = referenceStep.exchanges?.[0]?.head;
    const b = otherStep.exchanges?.[0]?.head;
    if (a?.status !== b?.status) ctx.differ('stream.status', 'head', 'stream', a?.status, b?.status);
  }
}

function compareStep(ctx, referenceStep, otherStep) {
  ctx.step = referenceStep.id;
  ctx.entry();
  if (referenceStep.kind !== otherStep.kind) { ctx.differ('step', 'kind', 'steps', referenceStep.kind, otherStep.kind); return; }
  if (referenceStep.kind === 'concurrent') {
    if ((referenceStep.exchanges ?? []).some((record) => record.notSent !== undefined)) { ctx.unsure('concurrency', 'a member was not sent to the reference'); return; }
    if ((otherStep.exchanges ?? []).some((record) => record.notSent !== undefined)) { ctx.unsure('concurrency', 'a member was not sent to the other arm'); return; }
    compareConcurrent(ctx, referenceStep, otherStep);
    // Rule inode for the step as a whole (the reference's own concurrent run): exact whenever replacing does not depend on the order.
    for (const field of ['replaced', 'removed']) {
      const strip = (keys) => (keys ?? []).map((item) => item.replace(/^0:/, '').replace(/^1:/, 'home:')).filter((name) => !isEdgePath(ctx, name, null)).sort();
      const x = strip(referenceStep[field]);
      const y = strip(otherStep[field]);
      for (const name of new Set([...x, ...y])) if (x.includes(name) !== y.includes(name)) ctx.differ(`tree.${name}.${field}`, 'the concurrent step', 'inode', x.includes(name) ? field : 'rewritten in place or kept', y.includes(name) ? field : 'rewritten in place or kept');
    }
  } else {
    compareExchanges(ctx, referenceStep, otherStep);
    if (referenceStep.kind === 'staged') {
      // Rule inode for the step as a whole (its members' writes are not told apart from outside).
      for (const field of ['replaced', 'removed']) {
        const strip = (keys) => (keys ?? []).map((item) => item.replace(/^0:/, '').replace(/^1:/, 'home:')).filter((name) => !isEdgePath(ctx, name, null)).sort();
        const x = strip(referenceStep[field]);
        const y = strip(otherStep[field]);
        for (const name of new Set([...x, ...y])) if (x.includes(name) !== y.includes(name)) ctx.differ(`tree.${name}.${field}`, 'the staged step', 'inode', x.includes(name) ? field : 'rewritten in place or kept', y.includes(name) ? field : 'rewritten in place or kept');
      }
    }
    const left = new Map(momentsOf(referenceStep));
    const right = new Map(momentsOf(otherStep));
    // A step the candidate was not given has no snapshots on its side: nothing of it to compare.
    const unsent = (step) => (step.exchanges ?? []).length > 0 && step.exchanges.every((record) => record.notSent !== undefined);
    if (!unsent(referenceStep) && !unsent(otherStep)) for (const moment of new Set([...left.keys(), ...right.keys()])) compareTrees(ctx, moment, left.get(moment) ?? null, right.get(moment) ?? null);
  }
  if (referenceStep.kind.startsWith('stream-')) compareStreams(ctx, referenceStep, otherStep);
}

/**
 * Compares `other` against `reference`, two recordings of one scenario.
 * `mode`: 'stability' (other is a second reference) or 'candidate'.
 * `declarations`: what the group declares (all optional): `identifierKeys`
 * (rule P), `temporaryNames` (rule T), `timeKeys` (rule W), `effects` (the effect kinds it can cause),
 * `edgeFiles` and `startupFiles` (rule edge-files). Returns `{ steps: Map(step
 * id -> { differences, inconclusive, notes, edge }), differences,
 * inconclusive, notes }` (recording-level entries apart).
 */
export function compareRecordings({ reference, other, mode, declarations = {}, dateLagMs = undefined }) {
  if (!['stability', 'candidate'].includes(mode)) throw new TypeError(`compare: unknown mode ${mode}`);
  const ctx = createContext({ reference, other, mode, declarations, dateLagMs });
  if (reference.scenario !== other.scenario) ctx.differ('scenario', 'id', 'steps', reference.scenario, other.scenario);
  for (const text of ctx.substitution.problems) ctx.unsure('values', text);
  const scenarioValues = (recording) => (recording.values?.scenario ?? []).map(({ name, kind, value }) => ({ name, kind, value }));
  const valuesDiffer = deepDifference(scenarioValues(reference), scenarioValues(other));
  if (valuesDiffer) ctx.differ('values', valuesDiffer.where, 'supplied', valuesDiffer.reference, valuesDiffer.candidate);
  compareTrees(ctx, 'start', reference.start ?? null, other.start ?? null);
  const otherSteps = new Map((other.steps ?? []).map((step) => [step.id, step]));
  const referenceIds = (reference.steps ?? []).map((step) => step.id);
  if (!isDeepStrictEqual(referenceIds, (other.steps ?? []).map((step) => step.id))) ctx.differ('steps', 'ids', 'steps', referenceIds.join(','), (other.steps ?? []).map((step) => step.id).join(','));
  for (const step of reference.steps ?? []) {
    const partner = otherSteps.get(step.id);
    if (!partner) { ctx.step = step.id; ctx.differ('step', 'presence', 'steps', 'recorded', 'absent'); continue; }
    compareStep(ctx, step, partner);
  }
  ctx.step = '(recording)';
  compareTrees(ctx, 'exit', reference.exitTree ?? null, other.exitTree ?? null);
  // Rules last-writer and W (mtime), per step, on both recordings.
  const edge = (name, entry, which) => (which === 'startup' ? ctx.startupFiles.has(name) : entry?.edge === true || ctx.edgeFiles.has(name));
  const writers = { reference: writersOf(reference, edge), other: writersOf(other, edge) };
  for (const [side, found] of Object.entries(writers)) {
    for (const item of found.mtimeProblems) { ctx.step = item.step === '(exit)' || item.step === '(start)' ? '(recording)' : item.step; ctx.differ(`tree.${item.path}.mtimeWindow`, `${side} ${item.moment}`, 'time-window', side === 'reference' ? item.mtimeMs : `${item.span.start}..${item.span.end}`, side === 'reference' ? `${item.span.start}..${item.span.end}` : item.mtimeMs); }
    for (const item of found.startupChanged) { ctx.step = item.step === '(exit)' ? '(recording)' : item.step; ctx.differ(`tree.${item.path}`, `${side}: an edge file written at the first start changed at ${item.moment}`, 'edge-files', 'unchanged after the first start', 'changed'); }
  }
  for (const step of reference.steps ?? []) {
    const partner = otherSteps.get(step.id);
    if (!partner) continue;
    const unsent = (item) => (item.exchanges ?? []).length > 0 && item.exchanges.every((record) => record.notSent !== undefined);
    if (unsent(step) || unsent(partner)) continue;
    ctx.step = step.id;
    const a = new Set([...(writers.reference.touched.get(step.id) ?? [])].map(ctx.temporary.reference.applyText));
    const b = new Set([...(writers.other.touched.get(step.id) ?? [])].map(ctx.temporary.other.applyText));
    for (const name of new Set([...a, ...b])) if (a.has(name) !== b.has(name)) ctx.differ(`tree.${name}.lastWriter`, 'changed by this step', 'last-writer', a.has(name) ? 'changed' : 'not changed', b.has(name) ? 'changed' : 'not changed');
  }
  ctx.step = '(recording)';
  // Rule P: conflicts are differences; a pair used only once is reported.
  for (const conflict of ctx.pairing.conflicts) ctx.differ('identifier', conflict.where, 'paired', `${conflict.reference} (paired with ${conflict.had ?? conflict.hadBack})`, conflict.candidate);
  for (const [a] of ctx.pairing.pairs()) if ((ctx.pairing.uses.get(a) ?? 0) <= 1) ctx.note(`the identifier ${a} was seen once and never again`);
  return ctx.out;
}

/** Every difference and inconclusive part of a comparison, flat (for tests and reports). */
export const allOf = (result, field) => [...result[field], ...[...result.steps.values()].flatMap((entry) => entry[field])];
/** A difference as one line. */
export const differenceLine = (difference) => `${difference.step} ${difference.component} [${difference.rule}] ${difference.location}: reference ${difference.reference}, candidate ${difference.candidate}`;
