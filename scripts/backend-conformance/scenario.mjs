// The scenario format (BH2; design file 31 §4.2, §5, §6): fixtures in code,
// an ordered list of steps, the principals a scenario uses, and the registry
// of the values the harness supplies.
//
// A scenario is a plain object made by defineScenario():
//   { id, group, description,
//     principals: { <name>: PRINCIPALS entry },  the principal envelopes it uses
//     fixture(root, values),                      builds the starting data root (no files from git)
//     steps(values) -> [step, ...],               the ordered steps; every value an arm will echo
//                                                 or store comes from `values` (the registry)
//     waivers: { <step id>: { outcome, reason, checks } } rows the scenario knows cannot be recorded on an
//                                                 arm; `checks` names the problems the waiver covers, and a
//                                                 row with any other problem is not waived }
// Step kinds (each has a plain id unique in the scenario):
//   exchange      one request: method, target, headers, body, principal; `edge: true` when the edge
//                 answers it (recorded on the reference, never sent to a candidate); `tail: true` when
//                 what the server composes after the group answers it (the group host's tail stand-in:
//                 a method no route of the group registers), which is an edge exchange too
//   concurrent    2 or 3 exchanges sent at once (the reference also runs every order, §5.6)
//   external      the harness changes the data root between exchanges (write, delete, rename, mkdir, symlink, chmod)
//   restart       the arm stops and starts again on the tree it left
//   kill-after    one exchange, the arm SIGKILLed after a named point, then started again
//   stream-open, stream-barrier <n items>, stream-close (by the client or the server's end)
//   quiesce       waits until everything every exchange so far started has finished
//   snapshot      a snapshot of the data root, the arm frozen
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SERVER_ROOT } from './edge.mjs';

export const STEP_KINDS = Object.freeze(['exchange', 'concurrent', 'external', 'restart', 'kill-after', 'stream-open', 'stream-barrier', 'stream-close', 'quiesce', 'snapshot']);
/** Where a kill-after step kills: after the request is written, when the response head arrives, or once the response was read to its end. */
export const KILL_POINTS = Object.freeze(['request-sent', 'response-head', 'response-end']);
export const EXTERNAL_OPS = Object.freeze(['write', 'delete', 'rename', 'mkdir', 'symlink', 'chmod']);
const PLAIN_ID = /^[a-z0-9][a-z0-9._-]*$/;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const ENVELOPE_HEADER = 'X-DevRyan-Harness-Envelope';
const SEQ_HEADER = 'X-DevRyan-Harness-Seq';
export const HARNESS_HEADERS = Object.freeze({ envelope: ENVELOPE_HEADER, seq: SEQ_HEADER });

/** A malformed scenario: a harness defect, listed in full. */
export class ScenarioError extends Error {
  constructor(id, problems) { super(`scenario ${id}: ${problems.join('; ')}`); this.name = 'ScenarioError'; this.problems = problems; }
}

// ------------------------------------------------------------------ bodies
/** A JSON body: the bytes are JSON.stringify(value), exactly. */
export const jsonBody = (value) => Object.freeze({ kind: 'json', bytes: Buffer.from(JSON.stringify(value), 'utf8') });
/** A body given as bytes (or text in an encoding): malformed JSON, duplicate keys, non-UTF-8 bytes. */
export const rawBody = (bytes, encoding = 'utf8') => Object.freeze({ kind: 'raw', bytes: Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(String(bytes), encoding) });

// ------------------------------------------------------------------ steps
const request = ({ method, target, headers = [], body = null, principal, edge = false, tail = false }) => ({ method, target, headers: headers.map(([name, value]) => [name, value]), body, principal, edge: edge || tail, tail });
export const step = Object.freeze({
  exchange: (id, spec) => ({ kind: 'exchange', id, request: request(spec) }),
  concurrent: (id, members) => ({ kind: 'concurrent', id, members: members.map(([member, spec]) => ({ member, request: request(spec) })) }),
  external: (id, change) => ({ kind: 'external', id, change: { ...change } }),
  restart: (id) => ({ kind: 'restart', id }),
  killAfter: (id, point, spec) => ({ kind: 'kill-after', id, point, request: request(spec) }),
  streamOpen: (id, stream, spec) => ({ kind: 'stream-open', id, stream, request: request(spec) }),
  streamBarrier: (id, stream, items) => ({ kind: 'stream-barrier', id, stream, items }),
  streamClose: (id, stream, by = 'client') => ({ kind: 'stream-close', id, stream, by }),
  quiesce: (id) => ({ kind: 'quiesce', id }),
  snapshot: (id) => ({ kind: 'snapshot', id }),
});

// ------------------------------------------------------------------ supplied values
/**
 * The spelling of canonical path `canonical` without the `/private` prefix,
 * when its top directory is one the system links there (macOS's `/var`,
 * `/tmp`, `/etc`: `realpath('/var')` is `/private/var`); otherwise null.
 * Read from the file system, never assumed.
 */
export function firmlinkAlias(canonical) {
  const match = /^\/private(\/[^/]+)(?:\/|$)/.exec(canonical ?? '');
  if (!match) return null;
  try { return fs.realpathSync(match[1]) === `/private${match[1]}` ? canonical.slice('/private'.length) : null; } catch { return null; }
}
export const VALUE_KINDS = Object.freeze(['id', 'text', 'time', 'token', 'path', 'port']);
/**
 * The supplied-value registry (design §7, rule S; BH3 pairs by name). Every
 * value the harness supplies and an arm may echo or store is registered under
 * a name: the same name in two arms is the same value (scenario values) or
 * the arm's own (paths, ports). A name given twice must name the same value;
 * two names with the same value of a kind are refused, because a comparer
 * could not tell which one an arm echoed. A path is registered with its
 * spellings (as given, canonical, URL-encoded).
 */
export function createSuppliedValues(scope) {
  const entries = new Map();
  let frozen = false;
  const supply = (name, kind, value) => {
    if (frozen) throw new Error(`${scope}: value ${name} supplied after the registry was closed`);
    if (typeof name !== 'string' || !PLAIN_ID.test(name)) throw new Error(`${scope}: value name ${JSON.stringify(name)} is not a plain identifier`);
    if (!VALUE_KINDS.includes(kind)) throw new Error(`${scope}: value ${name} has unknown kind ${kind}`);
    if (kind === 'port' ? !Number.isInteger(value) : typeof value !== 'string') throw new Error(`${scope}: value ${name} (${kind}) has the wrong type`);
    const known = entries.get(name);
    if (known) {
      if (known.kind !== kind || known.value !== value) throw new Error(`${scope}: value ${name} supplied twice with different values`);
      return value;
    }
    for (const entry of entries.values()) if (entry.kind === kind && entry.value === value) throw new Error(`${scope}: values ${entry.name} and ${name} are the same ${kind}; a comparer could not pair them`);
    const entry = { name, kind, value };
    if (kind === 'path') {
      let canonical = value;
      try { canonical = fs.realpathSync(value); } catch { /* a path that does not exist yet is its own spelling */ }
      // The other spelling of a path under a firmlinked top directory (macOS: /var is /private/var), when the system says so.
      const alias = firmlinkAlias(canonical);
      // `forms` keeps each spelling at a fixed name, so a comparer maps one arm's spelling to the other's.
      entry.forms = { given: value, canonical, ...(alias ? { alias } : {}) };
      entry.spellings = [...new Set([value, canonical, ...(alias ? [alias] : []), encodeURIComponent(value), encodeURIComponent(canonical), ...(alias ? [encodeURIComponent(alias)] : [])])];
    }
    entries.set(name, entry);
    return value;
  };
  return {
    scope,
    supply,
    id: (name, value) => supply(name, 'id', value),
    text: (name, value) => supply(name, 'text', value),
    time: (name, value) => supply(name, 'time', value),
    token: (name, value) => supply(name, 'token', value),
    path: (name, value) => supply(name, 'path', value),
    port: (name, value) => supply(name, 'port', value),
    has: (name) => entries.has(name),
    get: (name) => { if (!entries.has(name)) throw new Error(`${scope}: no supplied value ${name}`); return entries.get(name).value; },
    close() { frozen = true; },
    /** Every entry, for the recording (long texts as length and digest-free prefix, the value kept). */
    list: () => [...entries.values()].map((entry) => ({ ...entry })),
    /** The names of the supplied values (four characters or more) that `bytes` contains. */
    usedIn(bytes) {
      const text = Buffer.isBuffer(bytes) ? bytes.toString('latin1') : String(bytes);
      return [...entries.values()].filter((entry) => typeof entry.value === 'string' && entry.value.length >= 4 && text.includes(entry.value)).map((entry) => entry.name);
    },
  };
}

// ------------------------------------------------------------------ principals (design §6)
const { ROLE_POLICY_DEFAULTS } = await import(pathToFileURL(path.join(SERVER_ROOT, 'lib/multi-user/policy.js')).href);
const plain = (value) => JSON.parse(JSON.stringify(value));
/**
 * The principal classes the managed policy distinguishes for a route group.
 * `envelope` is what a candidate is given (harness input, envelope version
 * 1); `reference` says how the reference arm produces it: `edge` (the edge
 * makes it from the request itself; the tap's record of the principal the
 * group saw must equal the envelope's), or null (the reference cannot
 * produce it: managed principals need the Supabase-backed runtime). A class
 * with `edgeAnswered` is answered by the edge for every group route: its
 * exchanges are edge exchanges, never sent to a candidate. `confirmedBy`
 * says which arm checks every field of the envelope against what its group
 * saw (the driver's `envelope` check on the reference), or null: the managed
 * envelopes are harness input no arm has confirmed yet.
 */
export const PRINCIPALS = Object.freeze({
  'local-admin': Object.freeze({
    class: 'local-admin', reference: 'edge', confirmedBy: 'reference', edgeAnswered: false, headers: [],
    envelope: Object.freeze({
      principal: plain({ id: 'local-admin', email: null, displayName: 'Local Administrator', role: 'admin', scope: 'local-admin', policy: ROLE_POLICY_DEFAULTS.admin, assignments: [] }),
      assignment: null, peer: { directLocal: true, tunnel: false }, authorizationActive: true,
    }),
  }),
  'managed-admin': Object.freeze({
    class: 'managed-admin', reference: null, confirmedBy: null, edgeAnswered: false, headers: [],
    envelope: Object.freeze({
      principal: plain({ id: 'harness-managed-admin', email: 'admin@harness.invalid', displayName: 'Harness Admin', role: 'admin', scope: 'managed', status: 'active', policy: ROLE_POLICY_DEFAULTS.admin, assignments: [] }),
      assignment: null, peer: { directLocal: false, tunnel: false }, authorizationActive: true,
    }),
  }),
  'managed-developer': Object.freeze({
    class: 'managed-developer', reference: null, confirmedBy: null, edgeAnswered: false, headers: [],
    envelope: Object.freeze({
      principal: plain({ id: 'harness-managed-developer', email: 'developer@harness.invalid', displayName: 'Harness Developer', role: 'developer', scope: 'managed', status: 'active', policy: ROLE_POLICY_DEFAULTS.developer, assignments: [] }),
      assignment: null, peer: { directLocal: false, tunnel: false }, authorizationActive: true,
    }),
  }),
  // A request forwarded from outside loopback with no credentials: the tunnel boundary refuses it.
  'remote-unauthenticated': Object.freeze({ class: 'unauthenticated', reference: 'edge', confirmedBy: null, edgeAnswered: true, headers: [['X-Forwarded-For', '203.0.113.9']], envelope: null }),
});

/** The envelope a candidate gets for one request (design §6, version 1). */
export function envelopeFor(principal, { originalUrl, seq }) {
  if (!principal.envelope) return null;
  return { v: 1, ...plain(principal.envelope), originalUrl, seq };
}
export const encodeEnvelope = (envelope) => Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');

// ------------------------------------------------------------------ definition and checks
/** Freezes nothing the driver mutates; checks the scenario's own shape. */
export function defineScenario(scenario) {
  const problems = [];
  if (typeof scenario?.id !== 'string' || !PLAIN_ID.test(scenario.id)) problems.push('id must be a plain identifier');
  if (typeof scenario?.group !== 'string' || !scenario.id?.startsWith(`${scenario.group}.`)) problems.push('id must start with the group name and a dot');
  if (typeof scenario?.fixture !== 'function') problems.push('fixture must be a function of the data root');
  if (typeof scenario?.steps !== 'function') problems.push('steps must be a function of the supplied values');
  if (!scenario?.principals || typeof scenario.principals !== 'object') problems.push('principals must name the envelopes the scenario uses');
  else for (const [name, principal] of Object.entries(scenario.principals)) if (PRINCIPALS[name] !== principal) problems.push(`principal ${name} is not a PRINCIPALS entry`);
  for (const [id, waiver] of Object.entries(scenario?.waivers ?? {})) {
    if (!waiver || typeof waiver.reason !== 'string' || waiver.reason.trim().length < 8) problems.push(`waiver ${id} has no reason`);
    else if (!Array.isArray(waiver.checks) || waiver.checks.length === 0) problems.push(`waiver ${id} names no checks (a scenario's waiver covers only the problems it names)`);
  }
  if (problems.length) throw new ScenarioError(scenario?.id ?? '(unnamed)', problems);
  return Object.freeze({ waivers: {}, description: '', ...scenario });
}

const requestProblems = (where, spec, scenario) => {
  const problems = [];
  if (!TOKEN.test(spec.method ?? '')) problems.push(`${where}: method ${JSON.stringify(spec.method)} is not a token`);
  if (typeof spec.target !== 'string' || !spec.target.startsWith('/') || /[\s]/.test(spec.target)) problems.push(`${where}: target must start with / and hold no whitespace`);
  if (!Array.isArray(spec.headers) || spec.headers.some((pair) => !Array.isArray(pair) || pair.length !== 2 || !TOKEN.test(pair[0]) || typeof pair[1] !== 'string' || /[\r\n]/.test(pair[1]))) problems.push(`${where}: headers must be [name, value] pairs without line breaks`);
  else if (spec.headers.some(([name]) => [ENVELOPE_HEADER, SEQ_HEADER].some((reserved) => reserved.toLowerCase() === name.toLowerCase()))) problems.push(`${where}: the harness headers are the driver's`);
  if (spec.body !== null && !(spec.body && ['json', 'raw'].includes(spec.body.kind) && Buffer.isBuffer(spec.body.bytes))) problems.push(`${where}: body must be jsonBody(), rawBody() or null`);
  if (!Object.hasOwn(scenario.principals, spec.principal)) problems.push(`${where}: principal ${JSON.stringify(spec.principal)} is not one of the scenario's`);
  else if (scenario.principals[spec.principal].edgeAnswered && !spec.edge) problems.push(`${where}: principal ${spec.principal} is answered by the edge, so the exchange must be marked edge`);
  return problems;
};

/** Checks a scenario's steps; throws ScenarioError listing every problem. */
export function validateSteps(scenario, steps) {
  const problems = [];
  if (!Array.isArray(steps) || steps.length === 0) throw new ScenarioError(scenario.id, ['steps() must return a non-empty list']);
  const ids = new Set();
  const streams = new Map(); // stream -> 'open' | 'closed'
  steps.forEach((entry, index) => {
    const where = `step ${index + 1} (${entry?.id})`;
    if (!entry || !STEP_KINDS.includes(entry.kind)) { problems.push(`${where}: unknown kind ${entry?.kind}`); return; }
    if (typeof entry.id !== 'string' || !PLAIN_ID.test(entry.id)) problems.push(`${where}: id must be a plain identifier`);
    else if (ids.has(entry.id)) problems.push(`${where}: id appears twice`);
    ids.add(entry.id);
    if (['exchange', 'kill-after', 'stream-open'].includes(entry.kind)) problems.push(...requestProblems(where, entry.request, scenario));
    if (entry.kind === 'kill-after') {
      if (!KILL_POINTS.includes(entry.point)) problems.push(`${where}: kill point must be one of ${KILL_POINTS.join(', ')}`);
      if (entry.request.edge) problems.push(`${where}: an edge exchange is never killed after (the group does not see it)`);
    }
    if (entry.kind === 'concurrent') {
      if (!Array.isArray(entry.members) || entry.members.length < 2 || entry.members.length > 3) problems.push(`${where}: 2 or 3 members`);
      const names = new Set();
      for (const member of entry.members ?? []) {
        if (!PLAIN_ID.test(member.member ?? '') || names.has(member.member)) problems.push(`${where}: member names must be plain and distinct`);
        names.add(member.member);
        problems.push(...requestProblems(`${where} member ${member.member}`, member.request, scenario));
        if (member.request.edge) problems.push(`${where}: an edge exchange cannot be a concurrent member`);
      }
    }
    if (entry.kind === 'external') {
      const change = entry.change ?? {};
      if (!EXTERNAL_OPS.includes(change.op)) problems.push(`${where}: op must be one of ${EXTERNAL_OPS.join(', ')}`);
      for (const key of ['path', ...(change.op === 'rename' ? ['to'] : [])]) {
        const value = change[key];
        if (typeof value !== 'string' || value === '' || path.isAbsolute(value) || value.split('/').some((part) => part === '' || part === '.' || part === '..')) problems.push(`${where}: ${key} must be a plain relative path`);
      }
      if (change.op === 'write' && !Buffer.isBuffer(change.data)) problems.push(`${where}: a write needs data bytes`);
      if (change.op === 'symlink' && typeof change.target !== 'string') problems.push(`${where}: a symlink needs a target`);
      if (['chmod', 'write', 'mkdir'].includes(change.op) && change.mode !== undefined && !(Number.isInteger(change.mode) && change.mode >= 0 && change.mode <= 0o7777)) problems.push(`${where}: mode must be permission bits`);
    }
    if (entry.kind === 'stream-open') {
      if (!PLAIN_ID.test(entry.stream ?? '')) problems.push(`${where}: stream name must be plain`);
      else if (streams.has(entry.stream)) problems.push(`${where}: stream ${entry.stream} is opened twice`);
      else streams.set(entry.stream, 'open');
      if (entry.request.edge) problems.push(`${where}: a stream is the group's`);
    }
    if (entry.kind === 'stream-barrier') {
      if (streams.get(entry.stream) !== 'open') problems.push(`${where}: stream ${entry.stream} is not open here`);
      if (!Number.isInteger(entry.items) || entry.items < 1) problems.push(`${where}: a barrier counts one item or more`);
    }
    if (entry.kind === 'stream-close') {
      if (streams.get(entry.stream) !== 'open') problems.push(`${where}: stream ${entry.stream} is not open here`);
      else streams.set(entry.stream, 'closed');
      if (!['client', 'server'].includes(entry.by)) problems.push(`${where}: a stream is closed by the client or ends by the server`);
    }
    // While a stream is open, the arm is never stopped, killed or frozen for a walk that the stream's work could change.
    if (['restart', 'kill-after'].includes(entry.kind) && [...streams.values()].includes('open')) problems.push(`${where}: a ${entry.kind} while a stream is open`);
  });
  for (const [stream, state] of streams) if (state === 'open') problems.push(`stream ${stream} is never closed (a stream is read to its end or closed after a barrier)`);
  for (const id of Object.keys(scenario.waivers ?? {})) if (!ids.has(id)) problems.push(`waiver ${id} names no step`);
  if (problems.length) throw new ScenarioError(scenario.id, problems);
  return steps;
}
