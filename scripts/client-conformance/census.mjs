// Census and recording checks of the client engine conformance harness
// (design file 29 §4.4, package C0c). A library: the product recording command and the
// self-test call it.
//
// - checkChangeSets: every step of a draft-mutating entry carries its
//   arguments, the arguments after the call and a change set, and the change
//   set equals the one recomputed from the two recorded drafts (identity is
//   in the codec's id numbers, which one case line shares across slots), so a
//   recording that dropped, invented or truncated part of a draft, or a wrong
//   change set, is a named failure.
// - census: every export of every family module (read from the module when the
//   recorder loaded it, never from a tracked list), every event type a
//   configured entry switches on (read from the module's source) and every
//   port the map lists is exercised in at least one recorded case, or waived
//   with a reason in the census file. A waiver of something that is in fact
//   exercised, or of something that no longer exists, is a failure too.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readContainer } from './container.mjs';
import { entryOf, isTestPath } from './port-map.mjs';

const TAG = '$dr';
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const tagOf = (node) => (isObject(node) && typeof node[TAG] === 'string' ? node[TAG] : null);

// ------------------------------------------------------------ change sets

// Trees whose objects the recorder's identity walk (identityPaths) treats as
// leaves: it records their path and does not descend.
const LEAF_CONTAINERS = new Set(['set', 'date', 'regexp', 'arraybuffer', 'dataview', 'url', 'searchparams', 'headers', 'response', 'request', 'abortsignal', 'function', 'promise', 'weak']);
// Trees the walk would descend into through a Proxy or platform object the codec does not show: not verifiable.
const UNVERIFIABLE = new Set(['port', 'opaque', 'accessor', 'unencodable', 'bytes', 'typed']);

/**
 * The container paths of one slot tree with their identity, in the order the
 * recorder's identity walk visits them (own enumerable data members in the
 * engine's order, array indices, Map entries by key), as `[path, identity]`:
 * identity is `n<k>` for an object the scope numbers, else a fresh token.
 * `unverifiable` collects what the tree cannot show.
 */
function identityWalk(root, { fresh, keyOf, unverifiable }) {
  const out = [];
  const walk = (node, where) => {
    if (node === null || typeof node !== 'object') return;
    let tag = tagOf(node);
    let identity;
    let content = node;
    if (tag === 'ref') { out.push([where, `n${node.n}`]); return; }
    if (tag === 'id') { identity = `n${node.n}`; content = node.value; tag = tagOf(content); }
    if (tag === 'undefined' || tag === 'number' || tag === 'bigint' || tag === 'hole' || tag === 'symbol') return;
    if (content === null || typeof content !== 'object') return;
    out.push([where, identity ?? fresh()]);
    if (tag === null) {
      if (Array.isArray(content)) {
        let index = 0;
        for (const item of content) {
          if (tagOf(item) === 'hole') { index += item.n; continue; }
          walk(item, [...where, index]);
          index += 1;
        }
        return;
      }
      for (const key of Object.keys(content)) walk(content[key], [...where, key]);
      return;
    }
    if (tag === 'escape' || tag === 'nullproto' || tag === 'class' || tag === 'symkeys') {
      const value = tag === 'symkeys' ? content.value : content.value;
      if (tag === 'symkeys') { walkInner(value, where); return; }
      if (isObject(value)) for (const key of Object.keys(value)) walk(value[key], [...where, key]);
      return;
    }
    if (tag === 'array') {
      let index = 0;
      for (const item of content.items) {
        if (tagOf(item) === 'hole') { index += item.n; continue; }
        walk(item, [...where, index]);
        index += 1;
      }
      if (isObject(content.props)) for (const key of Object.keys(content.props)) walk(content.props[key], [...where, key]);
      return;
    }
    if (tag === 'map') {
      for (const [key, value] of content.entries) {
        const name = keyOf(key);
        if (name === null) { unverifiable.push(`a Map key at ${JSON.stringify(where)} has no identity the tree can show`); continue; }
        walk(value, [...where, { map: name }]);
      }
      return;
    }
    if (LEAF_CONTAINERS.has(tag)) {
      if (isObject(content.props) && Object.keys(content.props).length) unverifiable.push(`${tag} with own members at ${JSON.stringify(where)}`);
      return;
    }
    if (UNVERIFIABLE.has(tag)) { unverifiable.push(`${tag} at ${JSON.stringify(where)}`); return; }
    unverifiable.push(`unknown tag ${tag} at ${JSON.stringify(where)}`);
  };
  // A symkeys wrapper's value is the object itself (its string members), not a child.
  const walkInner = (value, where) => {
    const inner = tagOf(value) === null && isObject(value) ? value : tagOf(value) === 'escape' || tagOf(value) === 'nullproto' || tagOf(value) === 'class' ? value.value : null;
    if (isObject(inner)) for (const key of Object.keys(inner)) walk(inner[key], [...where, key]);
  };
  walk(root, []);
  return out;
}

/** A Map key as a path member: a primitive by its tree, an object by its scope number, else null. */
const mapKeyName = (key) => {
  if (key === null || typeof key !== 'object') return `v${JSON.stringify(key)}`;
  const tag = tagOf(key);
  if (tag === 'id' || tag === 'ref') return `n${key.n}`;
  if (tag === 'undefined' || tag === 'number' || tag === 'bigint') return `v${JSON.stringify(key)}`;
  return null;
};

/** A recorded change set (a slot tree: a list of paths) as comparable path strings; ids and refs inside it are resolved. */
function recordedPaths(tree) {
  const byId = new Map();
  const resolve = (node) => {
    const tag = tagOf(node);
    if (tag === 'id') { byId.set(node.n, node.value); return resolve(node.value); }
    if (tag === 'ref') return { ref: node.n };
    return node;
  };
  const list = resolve(tree);
  if (!Array.isArray(list)) return null;
  return list.map((item) => {
    const parts = resolve(item);
    if (!Array.isArray(parts)) return null;
    return JSON.stringify(parts.map((part) => {
      const value = resolve(part);
      if (isObject(value) && value.ref !== undefined) {
        const target = byId.get(value.ref);
        return isObject(target) && 'map' in target ? { map: mapKeyName(target.map) } : { unresolved: value.ref };
      }
      if (isObject(value) && 'map' in value && tagOf(value) === null) return { map: mapKeyName(value.map) };
      return value;
    }));
  });
}

/**
 * Checks every draft step of every recorded case in `containers` (`{ name,
 * text }`), for the families of `portMap` with a draft entry. Returns
 * `{ failures, checked, unverifiable }`; a failure is `{ check, container,
 * case, step, detail }` with check `draft-recorded` (arguments, after or the
 * change set missing) or `change-set` (the recorded change set is not the one
 * the two drafts show).
 */
export function checkChangeSets(containers, portMap) {
  const failures = [];
  const unverifiable = [];
  let checked = 0;
  const drafts = new Map(); // family -> Map(export -> draft index)
  for (const [, target] of portMap.modules) {
    for (const [name, entry] of target.entries) {
      if (entry.spec.draft === undefined) continue;
      if (!drafts.has(entry.family)) drafts.set(entry.family, new Map());
      drafts.get(entry.family).set(name, entry.spec.draft);
    }
  }
  for (const container of containers) {
    const read = readContainer(container.text);
    const byExport = drafts.get(read.header.family);
    if (!byExport) continue;
    for (const kase of read.cases) {
      if (kase.outcome !== 'recorded') continue;
      for (const step of kase.steps) {
        const input = step.input;
        if (input.kind !== 'call' || typeof input.entry !== 'string' || !byExport.has(input.entry)) continue;
        const where = { container: container.name, case: kase.id, step: step.n };
        const index = byExport.get(input.entry);
        if (step.after === undefined || step.changes === undefined || input.args === undefined) {
          failures.push({ check: 'draft-recorded', ...where, detail: `${input.entry} mutates argument ${index}, but the step lacks ${['args', 'after', 'changes'].filter((key) => (key === 'args' ? input.args : step[key]) === undefined).join(', ')}` });
          continue;
        }
        const before = read.resolve(input.args);
        const after = read.resolve(step.after);
        const listItem = (tree) => (Array.isArray(tree) ? tree : tagOf(tree) === 'id' && Array.isArray(tree.value) ? tree.value : null);
        const beforeList = listItem(before);
        const afterList = listItem(after);
        if (!beforeList || !afterList || beforeList.length <= index || afterList.length <= index) {
          failures.push({ check: 'draft-recorded', ...where, detail: `${input.entry}: argument ${index} is missing from the recorded arguments` });
          continue;
        }
        let counter = 0;
        const fresh = () => `f${(counter += 1)}`;
        const found = [];
        const known = new Map();
        for (const [at, identity] of identityWalk(beforeList[index], { fresh, keyOf: mapKeyName, unverifiable: found })) known.set(JSON.stringify(at), identity);
        const expected = identityWalk(afterList[index], { fresh, keyOf: mapKeyName, unverifiable: found })
          .filter(([at, identity]) => known.get(JSON.stringify(at)) !== identity)
          .map(([at]) => JSON.stringify(at));
        if (found.length) { unverifiable.push({ ...where, detail: found.slice(0, 3).join('; ') }); continue; }
        const actual = recordedPaths(read.resolve(step.changes));
        checked += 1;
        if (!actual || actual.some((item) => item === null)) { failures.push({ check: 'change-set', ...where, detail: 'the change set is not a list of paths' }); continue; }
        if (actual.length !== expected.length || actual.some((item, at) => item !== expected[at])) {
          const missing = expected.filter((item) => !actual.includes(item));
          const extra = actual.filter((item) => !expected.includes(item));
          failures.push({ check: 'change-set', ...where, detail: `${input.entry}: the recorded change set differs from the drafts' identities (${missing.length} missing, first ${missing[0] ?? '-'}; ${extra.length} extra, first ${extra[0] ?? '-'}${!missing.length && !extra.length ? '; order differs' : ''})` });
        }
      }
    }
  }
  return { failures, checked, unverifiable };
}

// ----------------------------------------------------------------- census

const CENSUS_KEYS = new Set(['version', 'note', 'events', 'families', 'exports', 'eventTypes', 'ports', 'unrecordable', 'excludedFiles', 'unstable', 'noFrame']);
const EVENT_SOURCE_KEYS = new Set(['family', 'entry', 'arg', 'note']);
const WAIVER_KEYS = {
  families: ['family', 'reason'], unstable: ['file', 'family', 'reason'], exports: ['family', 'export', 'reason'], eventTypes: ['family', 'type', 'reason'], ports: ['family', 'port', 'reason'],
  unrecordable: ['file', 'test', 'tests', 'flag', 'family', 'reason'], excludedFiles: ['file', 'reason'], noFrame: ['family', 'export', 'reason'],
};

/**
 * Reads and validates a census file: event sources and the waiver lists, each
 * waiver with a reason. An `unrecordable` waiver names its test file, the
 * test (`test`, or `tests`: a list of names), the exact flag and optionally a
 * family; a `noFrame` entry names a family's export that engine code calls
 * with no frame, its reason naming that engine site. Throws on anything else.
 */
export function loadCensus(file) {
  const fail = (message) => { throw new Error(`client-conformance census ${path.basename(file)}: ${message}`); };
  let census;
  try { census = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { fail(`cannot be read: ${error.message}`); }
  if (!isObject(census) || census.version !== 1) fail('version must be 1');
  for (const key of Object.keys(census)) if (!CENSUS_KEYS.has(key)) fail(`unknown member ${key}`);
  for (const [index, source] of (census.events ?? []).entries()) {
    if (!isObject(source)) fail(`event source ${index} must be an object`);
    for (const key of Object.keys(source)) if (!EVENT_SOURCE_KEYS.has(key)) fail(`event source ${index} has unknown member ${key}`);
    if (typeof source.family !== 'string' || typeof source.entry !== 'string' || !Number.isInteger(source.arg) || source.arg < 0) fail(`event source ${index}: family, entry and arg are required`);
  }
  for (const [list, keys] of Object.entries(WAIVER_KEYS)) {
    if (census[list] !== undefined && !Array.isArray(census[list])) fail(`${list} must be a list`);
    for (const [index, waiver] of (census[list] ?? []).entries()) {
      if (!isObject(waiver)) fail(`${list} ${index} must be an object`);
      for (const key of Object.keys(waiver)) if (!keys.includes(key)) fail(`${list} ${index} has unknown member ${key}`);
      if (typeof waiver.reason !== 'string' || !waiver.reason.trim()) fail(`${list} ${index}: every waiver needs a reason`);
      const required = list === 'unrecordable' ? ['file', 'flag'] : list === 'excludedFiles' ? ['file'] : list === 'unstable' ? ['file'] : keys.filter((key) => key !== 'reason');
      for (const key of required) if (typeof waiver[key] !== 'string' || !waiver[key]) fail(`${list} ${index}: ${key} is required`);
      for (const key of ['family', 'test']) if (waiver[key] !== undefined && (typeof waiver[key] !== 'string' || !waiver[key])) fail(`${list} ${index}: ${key} must be a name`);
      if (list === 'unrecordable') {
        const named = waiver.test !== undefined ? [waiver.test] : waiver.tests;
        if (!Array.isArray(named) || named.length === 0 || named.some((name) => typeof name !== 'string' || !name) || (waiver.test !== undefined && waiver.tests !== undefined)) fail(`${list} ${index}: name the test (test) or the tests (tests), one of them`);
      }
    }
  }
  return {
    file, events: census.events ?? [], exports: census.exports ?? [], eventTypes: census.eventTypes ?? [], ports: census.ports ?? [], unrecordable: census.unrecordable ?? [],
    excludedFiles: census.excludedFiles ?? [], families: census.families ?? [], unstable: census.unstable ?? [], noFrame: census.noFrame ?? [],
  };
}

/**
 * The body of `export function <name>(` (or `export const <name> =`) in a
 * module's source, by brace matching outside strings and comments; null when
 * it is not found.
 */
export function functionBody(source, name) {
  const start = new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\s*[<(]|export\\s+const\\s+${name}\\s*=`).exec(source);
  if (!start) return null;
  const index = source.indexOf('{', source.indexOf(')', start.index));
  if (index < 0) return null;
  let depth = 0;
  for (let at = index; at < source.length; at += 1) {
    const char = source[at];
    if (char === '"' || char === "'" || char === '`') {
      for (at += 1; at < source.length && source[at] !== char; at += 1) if (source[at] === '\\') at += 1;
      continue;
    }
    if (char === '/' && source[at + 1] === '/') { at = source.indexOf('\n', at); if (at < 0) break; continue; }
    if (char === '/' && source[at + 1] === '*') { at = source.indexOf('*/', at + 2) + 1; if (at <= 0) break; continue; }
    if (char === '{') depth += 1;
    if (char === '}') { depth -= 1; if (depth === 0) return source.slice(index, at + 1); }
  }
  return null;
}

/** `text` with its comments blanked (their length kept); strings are left as they are. */
function withoutComments(text) {
  let out = '';
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (char === '"' || char === "'" || char === '`') {
      const begin = at;
      for (at += 1; at < text.length && text[at] !== char; at += 1) if (text[at] === '\\') at += 1;
      out += text.slice(begin, at + 1);
      continue;
    }
    if (char === '/' && (text[at + 1] === '/' || text[at + 1] === '*')) {
      const end = text[at + 1] === '/' ? text.indexOf('\n', at) : text.indexOf('*/', at + 2) + 2;
      const stop = end <= 1 || end < 0 ? text.length : end;
      out += ' '.repeat(stop - at);
      at = stop - 1;
      continue;
    }
    out += char;
  }
  return out;
}
/** The index just past the bracket that closes the one at `open` (strings skipped), or -1. */
function closing(text, open) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const stack = [];
  for (let at = open; at < text.length; at += 1) {
    const char = text[at];
    if (char === '"' || char === "'" || char === '`') { for (at += 1; at < text.length && text[at] !== char; at += 1) if (text[at] === '\\') at += 1; continue; }
    if (pairs[char]) stack.push(pairs[char]);
    else if (char === ')' || char === ']' || char === '}') { if (stack.pop() !== char) return -1; if (stack.length === 0) return at + 1; }
  }
  return -1;
}
/** The name of parameter `arg` of `export function <name>(`, or null (not found, or destructured). */
function parameterName(source, name, arg) {
  const start = new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\s*(?:<[^(]*)?\\(`).exec(source);
  if (!start) return null;
  const open = start.index + start[0].length - 1;
  const end = closing(withoutComments(source), open);
  if (end < 0) return null;
  const list = withoutComments(source.slice(open + 1, end - 1));
  const parts = [];
  let depth = 0;
  let begin = 0;
  for (let at = 0; at < list.length; at += 1) {
    const char = list[at];
    if (char === '(' || char === '[' || char === '{' || (char === '<')) depth += 1;
    else if (char === ')' || char === ']' || char === '}' || (char === '>' && list[at - 1] !== '=')) depth -= 1;
    else if (char === ',' && depth === 0) { parts.push(list.slice(begin, at)); begin = at + 1; }
  }
  parts.push(list.slice(begin));
  const match = /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)\s*[?:=,]?/.exec(parts[arg] ?? '');
  return match ? match[1] : null;
}

/**
 * The event types an entry handles, read from its source (a heuristic, stated
 * in docs/TESTING.md): the event is its parameter `arg`; a type is a `case
 * "<type>":` label of a `switch (<event>.type)` (not of a switch nested in
 * it), or a literal `<event>.type` is compared with (`===`, `!==`, `==`, `!=`,
 * either side), wherever it stands in the body. What the source does not show
 * this way is returned in `unseen`, never dropped: `<event>.type` read in any
 * other way, the event used whole (handed to a helper, destructured), a
 * destructured parameter. Returns `{ types, unseen }`, or null when the
 * function is not found.
 */
export function eventTypesOf(source, name, arg = 0) {
  const raw = functionBody(source, name);
  if (raw === null) return null;
  const body = withoutComments(raw);
  const event = parameterName(source, name, arg);
  if (event === null) return { types: [], unseen: [`parameter ${arg} of ${name} is not a plain name: the census cannot follow it`] };
  const types = new Set();
  const unseen = [];
  const member = `\\b${event}\\s*\\??\\.\\s*type\\b`;
  let accounted = 0;
  for (const found of body.matchAll(new RegExp(`\\bswitch\\s*\\(\\s*${member}\\s*\\)\\s*\\{`, 'g'))) {
    accounted += 1;
    const open = found.index + found[0].length - 1;
    const end = closing(body, open);
    if (end < 0) { unseen.push(`a switch on ${event}.type whose block does not close`); continue; }
    let block = body.slice(open + 1, end - 1);
    // A switch nested in a case is about something else: its labels are not event types.
    for (let inner = /\bswitch\s*\(/.exec(block); inner; inner = /\bswitch\s*\(/.exec(block)) {
      const head = closing(block, inner.index + inner[0].length - 1);
      const brace = head < 0 ? -1 : block.indexOf('{', head);
      const stop = brace < 0 ? -1 : closing(block, brace);
      if (stop < 0) { unseen.push('a nested switch whose block does not close'); break; }
      block = `${block.slice(0, inner.index)}${' '.repeat(stop - inner.index)}${block.slice(stop)}`;
    }
    for (const label of block.matchAll(/\bcase\s+(["'])([^"'\\]+)\1\s*:/g)) types.add(label[2]);
  }
  for (const pattern of [new RegExp(`${member}\\s*[!=]==?\\s*(["'])([^"'\\\\]+)\\1`, 'g'), new RegExp(`(["'])([^"'\\\\]+)\\1\\s*[!=]==?\\s*${member}`, 'g')]) {
    for (const found of body.matchAll(pattern)) { accounted += 1; types.add(found[2]); }
  }
  const reads = [...body.matchAll(new RegExp(member, 'g'))].length;
  if (reads > accounted) unseen.push(`${event}.type is read ${reads - accounted} times other than in a switch or a comparison with a literal`);
  const whole = [...body.matchAll(new RegExp(`\\b${event}\\b(?!\\s*\\??\\.)`, 'g'))].length;
  if (whole > 0) unseen.push(`${event} is used whole ${whole} times (handed on, destructured or indexed): a type read there is not seen`);
  return { types: [...types].sort(), unseen };
}

/** The base export a step input names: `x` for `x`, `x#2`, `x#2.next`. */
const baseExport = (label) => String(label).split('#')[0].split('.')[0];

/** A plain view of a slot tree, enough to read an event's `type`. */
const plainOf = (node) => {
  const tag = tagOf(node);
  if (tag === 'id') return plainOf(node.value);
  if (tag === 'escape' || tag === 'nullproto' || tag === 'class') return node.value;
  return node;
};

/**
 * The census of one recording. `containers` are `{ name, text }`;
 * `moduleExports` is `{ <repository-relative module>: { name: kind } }`, as the
 * recorder reports it (union over the files that loaded the module);
 * `readSource(module)` gives a module's source text. Returns `{ failures,
 * problems, families }`: a failure (`census-export`, `census-event`,
 * `census-port`, `waiver-exercised`, `waiver-stale`) fails the run; a problem
 * (a family module no file loaded, an event entry not found or not fully
 * seen) makes it inconclusive; `families` holds the counts per family.
 * `families` (names) scopes the census to those families: the others, and
 * the waivers that name them, are not judged. `complete: false` (a run of
 * chosen test files) judges only what the recorded cases show: a waiver that
 * is exercised still fails, but nothing fails for being unexercised, no
 * waiver is stale, and a family no file loaded is no problem.
 */
export function runCensus({ portMap, census, containers, moduleExports, readSource, families: scope = null, complete = true }) {
  const failures = [];
  const problems = [];
  const families = {};
  const byFamily = new Map(portMap.families.map((family) => [family.name, family]));
  const inScope = (name) => scope === null || scope.includes(name);
  const usage = new Map(); // family -> { exports: Map(name -> {called, recorded, returned}), events: Map, ports: Map, cases, steps, outcomes }
  const usageOf = (family) => {
    if (!usage.has(family)) usage.set(family, { exports: new Map(), events: new Map(), ports: new Map(), cases: 0, steps: 0, outcomes: { recorded: 0, unrecordable: 0, inconclusive: 0 } });
    return usage.get(family);
  };
  const bump = (map, key, grade) => {
    if (!map.has(key)) map.set(key, { called: 0, recorded: 0, returned: 0 });
    map.get(key)[grade] += 1;
  };
  const eventSources = new Map(); // `${family}:${entry}` -> source
  for (const source of census.events) eventSources.set(`${source.family}:${source.entry}`, source);
  for (const container of containers) {
    const read = readContainer(container.text);
    const family = read.header.family;
    const record = usageOf(family);
    for (const kase of read.cases) {
      record.cases += 1;
      record.outcomes[kase.outcome] = (record.outcomes[kase.outcome] ?? 0) + 1;
      record.steps += kase.steps.length;
      const recorded = kase.outcome === 'recorded';
      for (const step of kase.steps) {
        const input = step.input;
        if ((input.kind === 'call' || input.kind === 'new' || input.kind === 'get') && typeof input.entry === 'string') {
          const name = baseExport(input.entry);
          bump(record.exports, name, 'called');
          if (recorded) bump(record.exports, name, 'recorded');
          if (recorded && step.returns !== undefined) bump(record.exports, name, 'returned');
          const source = eventSources.get(`${family}:${input.entry}`);
          if (source && input.args !== undefined) {
            const args = plainOf(read.resolve(input.args));
            const event = Array.isArray(args) ? plainOf(args[source.arg]) : null;
            const type = isObject(event) && typeof event.type === 'string' ? event.type : null;
            if (type !== null) {
              bump(record.events, type, 'called');
              if (recorded) bump(record.events, type, 'recorded');
            }
          }
        }
        for (const effect of step.effects ?? []) {
          if (effect.kind !== 'port' && effect.kind !== 'new') continue;
          bump(record.ports, effect.port, 'called');
          if (recorded) bump(record.ports, effect.port, 'recorded');
        }
      }
    }
  }
  const waived = (list, family, key, value) => census[list].filter((waiver) => waiver.family === family && waiver[key] === value);
  const usedWaivers = new Set();
  for (const family of portMap.families.filter((item) => inScope(item.name))) {
    const record = usageOf(family.name);
    const relModule = family.relModule;
    const kinds = moduleExports[relModule];
    const summary = { module: relModule, cases: record.cases, steps: record.steps, outcomes: record.outcomes, exports: { total: 0, exercised: 0, waived: 0, inlined: 0, state: 0, failed: 0 }, events: null, ports: { total: 0, exercised: 0, waived: 0, failed: 0 }, grades: {} };
    families[family.name] = summary;
    const familyWaiver = census.families.find((item) => item.family === family.name);
    if (familyWaiver && record.outcomes.recorded > 0) failures.push({ check: 'waiver-exercised', family: family.name, name: '(family)', detail: `family ${family.name} is waived ("${familyWaiver.reason}") but records ${record.outcomes.recorded} cases: remove the waiver` });
    if (!kinds) { if (complete) problems.push({ check: 'census-no-exports', family: family.name, detail: `no recorded file loaded ${relModule}: its exports are unknown` }); continue; }
    const target = portMap.modules.get(family.module);
    const inline = target?.all?.inline ?? new Set();
    for (const [name, kind] of Object.entries(kinds)) {
      summary.exports.total += 1;
      const use = record.exports.get(name);
      summary.grades[name] = use ? { ...use } : { called: 0, recorded: 0, returned: 0 };
      const waivers = [...waived('exports', family.name, 'export', name), ...census.families.filter((item) => item.family === family.name)];
      for (const waiver of waivers) usedWaivers.add(waiver);
      if (name === family.state) { summary.exports.state += 1; continue; }
      if (inline.has(name)) {
        summary.exports.inlined += 1;
        if (waivers.length) failures.push({ check: 'waiver-stale', family: family.name, name, detail: `${family.name}#${name} is inlined by the port map, which gives its reason; the census waiver is redundant` });
        continue;
      }
      const exercised = (use?.recorded ?? 0) > 0;
      const entry = kind === 'function' || kind === 'class' ? entryOf(target, name) : null;
      if (exercised && waivers.length) { failures.push({ check: 'waiver-exercised', family: family.name, name, detail: `${family.name}#${name} is waived ("${waivers[0].reason}") but recorded cases exercise it ${use.recorded} times: remove the waiver` }); continue; }
      if (exercised) { summary.exports.exercised += 1; continue; }
      if (waivers.length) { summary.exports.waived += 1; continue; }
      if (!complete) { summary.exports.unjudged = (summary.exports.unjudged ?? 0) + 1; continue; }
      summary.exports.failed += 1;
      const why = kind === 'data' ? 'a data export (no entry can exercise it)' : !entry ? 'not an entry of the port map (inlined without a reason)' : use ? `called ${use.called} times, never in a recorded case` : 'never called by a test';
      failures.push({ check: 'census-export', family: family.name, name, detail: `${family.name}#${name} (${kind}) is not exercised and not waived: ${why}` });
    }
    for (const waiver of census.exports.filter((item) => complete && item.family === family.name)) {
      if (!Object.hasOwn(kinds, waiver.export)) failures.push({ check: 'waiver-stale', family: family.name, name: waiver.export, detail: `${family.name}#${waiver.export} is waived but is no export of ${relModule}: remove the waiver` });
    }
    // Ports the map lists for this family.
    const portNames = [];
    for (const [, portTarget] of portMap.modules) for (const [, port] of portTarget.ports) if (port.families.includes(family.name)) portNames.push(port.name);
    for (const name of portNames.sort()) {
      summary.ports.total += 1;
      const use = record.ports.get(name);
      const waivers = waived('ports', family.name, 'port', name);
      for (const waiver of waivers) usedWaivers.add(waiver);
      if ((use?.recorded ?? 0) > 0) {
        if (waivers.length) failures.push({ check: 'waiver-exercised', family: family.name, name, detail: `port ${name} is waived but recorded cases call it` });
        else summary.ports.exercised += 1;
        continue;
      }
      if (waivers.length) { summary.ports.waived += 1; continue; }
      if (!complete) continue;
      summary.ports.failed += 1;
      failures.push({ check: 'census-port', family: family.name, name, detail: `port ${name} of ${family.name} is never called in a recorded case and not waived` });
    }
    for (const waiver of census.ports.filter((item) => complete && item.family === family.name)) {
      if (!portNames.includes(waiver.port)) failures.push({ check: 'waiver-stale', family: family.name, name: waiver.port, detail: `port ${waiver.port} is waived but the map lists no such port of ${family.name}` });
    }
  }
  // Event types.
  for (const source of census.events.filter((item) => inScope(item.family))) {
    const family = byFamily.get(source.family);
    if (!family) { problems.push({ check: 'census-events', family: source.family, detail: `event source names no family ${source.family}` }); continue; }
    const read = eventTypesOf(readSource(family.module), source.entry, source.arg);
    if (read === null || read.types.length === 0) { problems.push({ check: 'census-events', family: source.family, detail: `no event types found in ${source.entry} of ${family.relModule}` }); continue; }
    for (const detail of read.unseen) problems.push({ check: 'census-events-unseen', family: source.family, detail: `${source.entry} of ${family.relModule}: ${detail}` });
    const types = read.types;
    const record = usageOf(source.family);
    const summary = families[source.family];
    summary.events ??= { total: 0, exercised: 0, waived: 0, failed: 0, types: {} };
    for (const type of types) {
      summary.events.total += 1;
      const seen = record.events.get(type);
      summary.events.types[type] = seen ? { ...seen } : { called: 0, recorded: 0 };
      const waivers = waived('eventTypes', source.family, 'type', type);
      for (const waiver of waivers) usedWaivers.add(waiver);
      if ((seen?.recorded ?? 0) > 0) {
        if (waivers.length) failures.push({ check: 'waiver-exercised', family: source.family, name: type, detail: `event ${type} is waived but recorded cases deliver it ${seen.recorded} times` });
        else summary.events.exercised += 1;
        continue;
      }
      if (waivers.length) { summary.events.waived += 1; continue; }
      if (!complete) continue;
      summary.events.failed += 1;
      failures.push({ check: 'census-event', family: source.family, name: type, detail: `event ${type}, which ${source.entry} handles, reaches it in no recorded case and is not waived` });
    }
  }
  for (const waiver of census.eventTypes.filter((item) => complete && inScope(item.family))) {
    const summary = families[waiver.family];
    if (!summary?.events || !Object.hasOwn(summary.events.types, waiver.type)) failures.push({ check: 'waiver-stale', family: waiver.family, name: waiver.type, detail: `event ${waiver.type} is waived but no configured entry of ${waiver.family} handles it` });
  }
  for (const waiver of census.families) if (complete && !byFamily.has(waiver.family)) failures.push({ check: 'waiver-stale', family: waiver.family, name: '(family)', detail: `waiver names no family ${waiver.family} of the port map` });
  for (const list of ['exports', 'ports']) {
    for (const waiver of census[list]) if (complete && !byFamily.has(waiver.family)) failures.push({ check: 'waiver-stale', family: waiver.family, name: waiver.export ?? waiver.port, detail: `waiver names no family ${waiver.family} of the port map` });
  }
  return { failures, problems, families };
}

/**
 * Splits a recording's unrecordable problems by the census file's
 * `unrecordable` waivers: a case is waived when every one of its flags is
 * covered by a waiver that names its test file, its test (by name), that
 * exact flag and, when the waiver names one, its family. Returns `{
 * remaining, waived, stale }`: a waiver (or a test a waiver names) that
 * matched no case is stale (a failure: the reason it gives no longer holds).
 * `complete: false` (chosen test files) reports nothing stale.
 */
export function judgeUnrecordable(incomplete, census, { complete = true } = {}) {
  const remaining = [];
  const waived = [];
  const matched = new Set(); // `${waiver index} ${test name}`
  const testsOf = (waiver) => (waiver.test !== undefined ? [waiver.test] : waiver.tests ?? []);
  for (const entry of incomplete) {
    if (entry.check !== 'unrecordable') { remaining.push(entry); continue; }
    const family = String(entry.case).slice(String(entry.case).lastIndexOf('/') + 1);
    const covering = entry.flags.map((flag) => census.unrecordable.findIndex((waiver) => waiver.file === entry.file && waiver.flag === flag && testsOf(waiver).includes(entry.name) && (!waiver.family || waiver.family === family)));
    if (covering.every((index) => index >= 0)) {
      for (const index of covering) matched.add(`${index} ${entry.name}`);
      waived.push({ ...entry, family, reasons: covering.map((index) => census.unrecordable[index].reason) });
    } else remaining.push(entry);
  }
  const stale = [];
  if (complete) {
    census.unrecordable.forEach((waiver, index) => {
      for (const name of testsOf(waiver)) {
        if (!matched.has(`${index} ${name}`)) stale.push({ check: 'waiver-stale', name: `${waiver.file} ${name} ${waiver.flag}`, detail: `the unrecordable waiver for ${waiver.file}, test "${name}" (${waiver.flag}${waiver.family ? `, ${waiver.family}` : ''}) matched no case: remove it` });
      }
    });
  }
  return { remaining, waived, stale };
}

/**
 * Splits unstable differences by the census file's `unstable` waivers (a test
 * file, and a family when given): returns `{ remaining, waived, stale }`. A
 * waived unstable case is still no reference: it is reported, never counted
 * as a pass.
 */
export function judgeUnstable(unstable, census, { complete = true } = {}) {
  const remaining = [];
  const waived = [];
  const matched = new Set();
  for (const entry of unstable) {
    const id = String(entry.case ?? '');
    const file = id.slice(0, id.search(/[: ]/) < 0 ? id.length : id.search(/[: ]/));
    const family = id.slice(id.lastIndexOf('/') + 1);
    const waiver = census.unstable.find((item) => item.file === file && (!item.family || item.family === family));
    if (waiver && entry.case) { matched.add(waiver); waived.push({ ...entry, reason: waiver.reason }); } else remaining.push(entry);
  }
  const stale = census.unstable.filter((waiver) => complete && !matched.has(waiver)).map((waiver) => ({ check: 'waiver-stale', name: waiver.file, detail: `the unstable waiver for ${waiver.file}${waiver.family ? ` (${waiver.family})` : ''} matched no unstable case: remove it` }));
  return { remaining, waived, stale };
}

/**
 * The default targets without the census file's excluded files: returns `{
 * files, stale }`; an exclusion no default target reaches is stale (a failure).
 */
export function applyExclusions(all, census) {
  const excluded = new Set(census.excludedFiles.map((item) => item.file));
  const stale = census.excludedFiles.filter((item) => !all.includes(item.file)).map((item) => ({ check: 'waiver-stale', name: item.file, detail: `${item.file} is excluded ("${item.reason}") but no default target reaches it: remove the exclusion` }));
  return { files: all.filter((file) => !excluded.has(file)), stale };
}

/** The union of the module exports the raws of a recording report. A module two files report differently is a problem. */
export function mergeExports(raws) {
  const out = {};
  const problems = [];
  for (const raw of raws) {
    for (const [module, kinds] of Object.entries(raw.exports ?? {})) {
      // The namespace's names must be those the source declares (the facade's own scan): a census that lost one would pass it.
      const scanned = raw.scanned?.[module];
      const names = Object.keys(kinds).sort();
      if (!Array.isArray(scanned) || scanned.length !== names.length || [...scanned].sort().some((name, index) => name !== names[index])) {
        problems.push({ check: 'census-exports-scanned', detail: `${module}: the exports the namespace shows (${names.join(', ')}) are not those its source declares (${(scanned ?? []).join(', ')})` });
      }
      if (!out[module]) { out[module] = kinds; continue; }
      if (JSON.stringify(out[module]) !== JSON.stringify(kinds)) problems.push({ check: 'census-exports-differ', detail: `${module}: two test files saw different exports` });
    }
  }
  return { exports: out, problems };
}

// ------------------------------------------------------- passed-through calls

/**
 * What a recording passed through (the recorder's caller rule), summed over
 * its raws: `unmapped` (family -> export -> calls), `callers` (caller file ->
 * `family#export` -> calls), `portCallers` (caller file -> port -> uses),
 * `noFrame` (`family#export` -> calls with no frame) and `totals` (`calls`,
 * `nested`, `noFrame`, `ports`, `portsNested`).
 */
export function passedThrough(raws) {
  const out = { unmapped: {}, callers: {}, portCallers: {}, noFrame: {}, totals: { calls: 0, nested: 0, noFrame: 0, ports: 0, portsNested: 0 } };
  const add = (table, key, inner, count) => { const row = (table[key] ??= {}); row[inner] = (row[inner] ?? 0) + count; };
  for (const raw of raws) {
    for (const [family, byExport] of Object.entries(raw.unmapped ?? {})) for (const [name, count] of Object.entries(byExport)) add(out.unmapped, family, name, count);
    for (const [file, byKey] of Object.entries(raw.callers ?? {})) for (const [key, count] of Object.entries(byKey)) add(out.callers, file, key, count);
    for (const [file, byPort] of Object.entries(raw.portCallers ?? {})) for (const [port, count] of Object.entries(byPort)) add(out.portCallers, file, port, count);
    for (const [key, count] of Object.entries(raw.noFrame ?? {})) out.noFrame[key] = (out.noFrame[key] ?? 0) + count;
    for (const key of Object.keys(out.totals)) out.totals[key] += raw.passed?.[key] ?? 0;
  }
  return out;
}

/**
 * Callers of passed-through calls that are test support code under another
 * name: a caller file under `scope` (a repository-relative prefix) that is not
 * test code by the naming rule (port-map.mjs isTestPath) and that `reachable`
 * (the files the product's own entry points reach) does not hold. Each is a
 * problem (`caller-unclassified`): until it is renamed by the rule, or
 * reached by the product, its calls might be the test's.
 */
export function unclassifiedCallers(passed, { scope, reachable }) {
  const problems = [];
  const files = new Map();
  for (const [table, unit] of [[passed.callers, 'calls'], [passed.portCallers, 'port uses']]) {
    for (const [file, row] of Object.entries(table)) {
      if (!file.startsWith(scope) || isTestPath(file) || reachable.has(file)) continue;
      const entry = files.get(file) ?? { file, parts: [] };
      entry.parts.push(`${Object.values(row).reduce((sum, count) => sum + count, 0)} ${unit} of ${Object.keys(row).sort().join(', ')}`);
      files.set(file, entry);
    }
  }
  for (const { file, parts } of [...files.values()].sort((a, b) => (a.file < b.file ? -1 : 1))) {
    problems.push({ check: 'caller-unclassified', file, detail: `${file} made ${parts.join('; ')} that were passed through, but it is no test code by the naming rule and no product entry point reaches it: it is test support code under another name; rename it by the rule (docs/TESTING.md) or reach it from the product` });
  }
  return problems;
}

/** The census's `noFrame` entries that no call matched: stale (a failure), on a complete run only. */
export function staleNoFrame(passed, census, { complete = true } = {}) {
  if (!complete) return [];
  return census.noFrame.filter((item) => !(passed.noFrame[`${item.family}#${item.export}`] > 0)).map((item) => ({ check: 'waiver-stale', name: `${item.family}#${item.export}`, detail: `${item.family}#${item.export} is named as called by engine code with no frame ("${item.reason}") but no such call was seen: remove it` }));
}
