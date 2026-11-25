// The replayer's judgement of one case (package C0d; design file 29 §4.2,
// §4.3): which recorded cases it can replay yet, what a step's engine needs
// from the recording (the answers of its effects, and where an object the
// engine makes is named again later), and the exact comparison of a replayed
// case with the recorded one. Pure functions over resolved codec trees: no
// engine, no file, no clock.
//
// Comparison rules (§4.2, and no others): codec trees compared exactly (key
// order, undefined against null, -0, NaN, Set and Map order, holes), aliasing
// structure included; effects as an ordered list per step (no port map waives
// an order today; a waived port is matched by name in any order, never
// dropped); thrown values by class, name, message and own data (the codec
// never writes a stack); the change set exactly. Nothing is masked but the two
// things a recording holds that are not behaviour: the test-originated context
// (never replayed, never compared) and a draw's source line (`site`, a
// diagnostic). Identity numbers are compared as structure, never as numbers:
// the recording's numbers and the engine's are paired position by position
// across the compared slots (createIdentityJudge), so "the same object at
// these two positions" is what is compared, and an identity difference is
// reported where the pairing first breaks.

/**
 * What a replay does not compare, each with why. Every other part of a
 * recorded case is compared exactly. The self-test pins this list and shows
 * the codec limits below are real (replay-mutants.mjs compareChecks), and the
 * product full test shows no mapped family module uses what the codec does not
 * carry, so the list stays true or a test fails.
 */
export const NOT_COMPARED = Object.freeze([
  { what: 'the test-originated context of a case', why: 'what the test did around the engine (its own calls, effects and late inputs); it is never replayed, so there is nothing to compare it with' },
  { what: 'the source line of a draw (`site`)', why: 'a diagnostic of where JavaScript drew, not behaviour; a Rust engine has no such line' },
  { what: 'non-enumerable own properties', why: 'the codec writes enumerable own properties only (a codec limit); no module a mapped family reaches in packages/ui (or in shared-runtime) defines a property or reads one\'s enumerability, and orchestration-runtime, reached only for a predicate, freezes only its own constants (`replay-product.full.test.mjs` checks the sources); a Rust value has no such attribute' },
  { what: 'whether an object is frozen, sealed or extensible, and whether a property is writable', why: 'the codec does not write it (a codec limit); the modules a mapped family reaches in packages/ui only freeze, and only those `replay-product.full.test.mjs` lists with their reasons (constants, and session-creation\'s captured attempt snapshot): a write to a frozen value throws in module code, so no recorded case makes one, and their content is compared; that test checks no other reached module seals, freezes or defines properties, and a Rust value has no such state' },
  { what: 'case-level `flags` and `status`, `entry.now` and `end.now`, and the engine\'s codec `flags`', why: 'flags and status are the recorder\'s and the engine\'s diagnostics; the nominal times are inputs the replayer hands on (each step\'s `now` is compared as the engine echoes it, and stored times by the time oracle). A stateful family\'s `entry.state` and `end.state` are compared (`entry-state`, `end-state`); a stateless family\'s are null on both sides' },
  { what: 'what a unit noted while its module loaded', why: 'no case was open (a module-level clock read, say): it is reported as a note, never charged to a case; what is noted between two cases is charged to the case before (`outside`)' },
  { what: 'bindings the engine could not make', why: 'no difference by itself: a later input that names the object then holds another one and differs by identity; reported as a note' },
  { what: 'the step\'s `now` as a value of its own', why: 'the replayer sends it; it is compared only as what the engine says it was given (an echo), and stored times are judged by the time oracle' },
  { what: 'what a timer still pending when its test ended does when it fires', why: 'whether it fires before the recording is written is decided by real time, so its firing is no step (C0e fix round, an owner decision); which timers are pending at the end, with the delay each was set with and the step that set it, is compared (`pending-timers`), and what such a timer changes is in the next case\'s entry state (seeded in file order when it differs)' },
]);

// --------------------------------------------------------------- what can be replayed yet

/** The later package that replays a feature this replayer does not. */
export const LATER = Object.freeze({ state: 'a port-map change: the family names its store or module bindings (C0e\'s `store`, `moduleState`)', transport: 'C0f (transport ports)' });

const tagOf = (node) => (node !== null && typeof node === 'object' && !Array.isArray(node) ? node.$dr : undefined);
function holdsTag(tree, tags) {
  let found = null;
  const walk = (node) => {
    if (found || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (tags.includes(node.$dr)) { found = node.$dr; return; }
    for (const key of Object.keys(node)) walk(node[key]);
  };
  walk(tree);
  return found;
}

/**
 * Why a recorded case cannot be replayed by this replayer yet, as
 * `{ feature, later }`, or null when it can: every step a call of an entry the
 * test made, every effect a synchronous port call answered by a value or a
 * throw, a clock read or a draw. `family` is the port map's family.
 */
export function notReplayable(kase, family, { resolve = null } = {}) {
  // A case read from a container holds value slots (`=<hash>`): what a slot holds is looked at resolved.
  const valueOf = (node) => (resolve && typeof node === 'string' && /^=[0-9a-f]{16}$/.test(node) ? resolve(node) : node);
  // A state read through an export of the family (the toys' `state`) cannot be seeded: package C0e reads and seeds
  // a store and module bindings (`store`, `moduleState`), which such a family does not name yet.
  if (family.state) return { feature: `the family snapshots module state through an export (${family.state}) instead of naming its store or bindings`, later: LATER.state };
  const promises = new Set(); // port calls of the case answered by a promise (a `settle` input names one)
  const portObjects = new Set(); // port objects the case's port calls answered (their reads are answered from the recording)
  for (const step of kase.steps ?? []) {
    const { input } = step;
    if (input.kind === 'settle' && !promises.has(`${input.port}#${input.call}`)) return { feature: 'a port answer settled that was no promise the engine got (an object\'s promise member, a derived answer)', later: LATER.transport };
    if (!['call', 'new', 'get', 'timer', 'settle', 'callback'].includes(input.kind)) return { feature: `an input of kind ${input.kind}`, later: LATER.transport };
    if (input.during !== undefined && input.duringCall === undefined) return { feature: 'an input delivered inside a port call of an earlier step that the recording does not name', later: LATER.transport };
    const held = holdsTag(valueOf(input.args), ['promise', 'port', 'response', 'request', 'opaque', 'unencodable', 'weak']);
    if (held) return { feature: `an argument holding a ${held}`, later: LATER.transport };
    for (const item of step.effects) {
      if (['clock', 'draw', 'timer.set', 'timer.clear', 'notify', 'settled'].includes(item.kind)) continue;
      // A read of a port object a port answered is answered from the recording; a global's (navigator, document) is a transport's.
      if (item.kind === 'read') { if (portObjects.has(item.port)) continue; return { feature: `a read of the global port object ${item.port}`, later: LATER.transport }; }
      if (item.kind !== 'port') return { feature: `a ${item.kind} effect`, later: LATER.transport };
      if (!item.port.startsWith('module:') && !(family.injectedNames ?? []).some((name) => item.port === name || (name.endsWith('@') && item.port.startsWith(name)))) return { feature: `a call of port ${item.port}`, later: LATER.transport };
      // A module port the map does not list is a module the test mocked (mock.module): its exports answer from the test's factory.
      if (item.port.startsWith('module:') && family.ports) {
        const at = item.port.indexOf('#');
        const base = at < 0 ? item.port : `${item.port.slice(0, at)}#${item.port.slice(at + 1).split('.')[0].split('#')[0]}`;
        if (!family.ports.some((port) => port.name === base)) return { feature: `a call of a module the test mocked (${base})`, later: LATER.transport };
      }
      const given = valueOf(Object.prototype.hasOwnProperty.call(item, 'answer') ? item.answer : item.throws);
      const answer = tagOf(given) === 'id' ? given.value : given;
      // A promise as the whole answer is settled by an input of its own; one inside an answer is a transport's.
      if (tagOf(answer) === 'promise' && Object.keys(answer).length === 1) { promises.add(`${item.port}#${item.call}`); continue; }
      // A port object as the whole answer (a storage) is read and called through the port (package C0e).
      if (tagOf(answer) === 'port') { portObjects.add(answer.name); continue; }
      // A function inside an answer is the engine's own (a store's action in an updater's next state): it is bound where
      // the engine made it, and one it never made is a stub that halts the case when called, never a silent pass.
      const answered = holdsTag(answer, ['promise', 'port', 'response', 'request', 'opaque', 'unencodable', 'weak']);
      if (answered) return { feature: `a port answer holding a ${answered}`, later: LATER.transport };
    }
  }
  return null;
}

// --------------------------------------------------------------- the step's inputs

/** What the engine may know of a step's effects: their answers, in recorded order. */
export function envOf(step) {
  const env = [];
  for (const item of step.effects) {
    // `call` is the recording's own name for the call (a later `settle` input names it), never an output to echo.
    if (item.kind === 'port') env.push(Object.prototype.hasOwnProperty.call(item, 'throws') ? { kind: 'port', port: item.port, call: item.call, throws: item.throws } : { kind: 'port', port: item.port, call: item.call, answer: item.answer });
    else if (item.kind === 'clock' || item.kind === 'draw') env.push({ kind: item.kind, source: item.source, value: item.value });
    // A port object's data member the engine read (its methods are port calls): what the read answered.
    else if (item.kind === 'read') env.push({ kind: 'read', port: item.port, key: item.key, value: item.value });
  }
  return env;
}

// The slots of a recorded step in written order, each `[key, tree, output]`: output slots are what the engine makes.
function stepSlots(step) {
  const slots = [['input.args', step.input.args, false]];
  if (Object.prototype.hasOwnProperty.call(step.input, 'value')) slots.push(['input.value', step.input.value, false]);
  if (Object.prototype.hasOwnProperty.call(step.input, 'target')) slots.push(['input.target', step.input.target, false]);
  step.effects.forEach((item, index) => {
    if (item.args !== undefined) slots.push([`effects.${index}.args`, item.args, true]);
    for (const key of ['answer', 'throws', 'value']) if (Object.prototype.hasOwnProperty.call(item, key)) slots.push([`effects.${index}.${key}`, item[key], item.kind === 'settled']);
    // What a store notified its listeners with is the engine's own state.
    for (const key of ['state', 'previous']) if (item.kind === 'notify' && Object.prototype.hasOwnProperty.call(item, key)) slots.push([`effects.${index}.${key}`, item[key], true]);
    if (item.kind === 'timer.clear' && Object.prototype.hasOwnProperty.call(item, 'handle')) slots.push([`effects.${index}.handle`, item.handle, false]);
  });
  for (const key of ['returns', 'throws', 'after', 'changes', 'state', 'stateChanges']) if (Object.prototype.hasOwnProperty.call(step, key)) slots.push([key, step[key], true]);
  return slots;
}

/**
 * Visits every `id` node of a tree with the path a live value is walked by
 * to reach that object (engine-ts.mjs atPath): own member names, array
 * indices counted over holes, `{map: i, part: 0|1}`, `{set: i}` and
 * `{own: "cause"|"errors"}`.
 */
export function forEachIdPath(tree, visit) {
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      let index = 0;
      for (const item of node) {
        if (tagOf(item) === 'hole') { index += item.n; continue; }
        walk(item, [...path, index]);
        index += 1;
      }
      return;
    }
    const tag = node.$dr;
    if (tag === undefined) { for (const key of Object.keys(node)) walk(node[key], [...path, key]); return; }
    switch (tag) {
      case 'id': visit(node.n, path); walk(node.value, path); return;
      case 'escape': case 'nullproto': for (const key of Object.keys(node.value)) walk(node.value[key], [...path, key]); return;
      case 'symkeys': walk(node.value, path); return;
      case 'array': walk(node.items, path); if (node.props) for (const key of Object.keys(node.props)) walk(node.props[key], [...path, key]); return;
      case 'map': node.entries.forEach(([key, value], index) => { walk(key, [...path, { map: index, part: 0 }]); walk(value, [...path, { map: index, part: 1 }]); }); return;
      case 'set': node.values.forEach((value, index) => walk(value, [...path, { set: index }])); return;
      case 'class':
        for (const key of Object.keys(node.value)) walk(node.value[key], [...path, key]);
        if (node.cause !== undefined) walk(node.cause, [...path, { own: 'cause' }]);
        if (node.errors !== undefined) walk(node.errors, [...path, { own: 'errors' }]);
        return;
      default:
    }
  };
  walk(tree, []);
}

/**
 * For each step, the objects first named in one of its output slots, as
 * `{slot, path, n}`: the engine binds the object at that path of what it made
 * to the recording's n, so a later input naming n gets that very object.
 */
export function bindPlan(kase) {
  const seen = new Set();
  const visit = (bind, slot, tree, output) => forEachIdPath(tree, (n, path) => {
    if (seen.has(n)) return;
    seen.add(n);
    if (output) bind.push({ slot, path, n });
  });
  // A stateful family's entry state is the engine's own (as it stands, or as seeded): its objects are bound first.
  const entry = [];
  if (kase.entry?.state) visit(entry, 'entry', kase.entry.state, true);
  const plan = kase.steps.map((step) => {
    const bind = [];
    for (const [slot, tree, output] of stepSlots(step)) visit(bind, slot, tree, output);
    // What the step handed the test as engine code is named `<entry>#<n>` by later steps (recording 7: `handedOut`).
    if (Number.isInteger(step.handedOut)) bind.push({ slot: 'returns', path: [], name: `${step.input.entry}#${step.handedOut}` });
    // The j-th timer the step sets is the recording's timer `id`, which a later `timer` input names (ids are each side's own).
    let sets = 0;
    for (const item of step.effects) if (item.kind === 'timer.set') { bind.push({ timer: item.id, index: sets }); sets += 1; }
    return bind;
  });
  plan.entry = entry;
  return plan;
}

// --------------------------------------------------------------- the comparison

const show = (value) => { const text = JSON.stringify(value); return text === undefined ? 'undefined' : text.length > 200 ? `${text.slice(0, 197)}...` : text; };
const kindName = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
// Tags whose node is a value but no object: no identity of their own.
const PRIMITIVE_TAGS = new Set(['undefined', 'number', 'bigint', 'symbol', 'accessor', 'hole', 'unencodable']);

/**
 * The identity structure of a case, judged as the slots are compared in
 * order: the recording's object numbers and the engine's are two namings of
 * positions, and they must name the same positions alike. A pairing of a
 * recorded object with a replayed one is made the first time either is met;
 * meeting one of them again with another partner is an identity difference.
 * An object a side writes without a number (it reached it once) is a partner
 * of its own that no later position can name. Symbols are paired the same way.
 */
export function createIdentityJudge() {
  const pairs = { left: new Map(), right: new Map() };
  const symbols = { left: new Map(), right: new Map() };
  let fresh = 0;
  const pair = (table, left, right) => {
    const known = table.left.get(left);
    const other = table.right.get(right);
    if (known === undefined && other === undefined) { table.left.set(left, right); table.right.set(right, left); return true; }
    return known === right && other === left;
  };
  return {
    object(left, right) {
      const l = left ?? `left-${(fresh += 1)}`;
      const r = right ?? `right-${(fresh += 1)}`;
      return pair(pairs, l, r);
    },
    symbol(left, right) { return pair(symbols, left, right); },
  };
}

/**
 * The first difference of two trees at a value position, the identity judge
 * spanning every slot of the case: `{ path, kind, expected, actual }` or null.
 * Content is compared before identity, so a changed value is reported as a
 * value, and the same content held by another object as identity.
 */
export function compareValues(expected, actual, judge, where = '') {
  const at = where || '/';
  const make = (kind, path = at, left = expected, right = actual) => ({ path, kind, expected: show(left), actual: show(right), raw: [left, right] });
  const leftTag = tagOf(expected);
  const rightTag = tagOf(actual);
  const leftRef = leftTag === 'ref';
  const rightRef = rightTag === 'ref';
  if (leftRef || rightRef) {
    if (!(leftRef && rightRef)) return make('identity');
    return judge.object(expected.n, actual.n) ? null : make('identity');
  }
  const leftId = leftTag === 'id' ? expected.n : null;
  const rightId = rightTag === 'id' ? actual.n : null;
  const left = leftId !== null ? expected.value : expected;
  const right = rightId !== null ? actual.value : actual;
  const found = compareContent(left, right, judge, where);
  if (found) return found;
  const isObject = (node) => node !== null && typeof node === 'object' && !PRIMITIVE_TAGS.has(tagOf(node));
  if (isObject(left) && !judge.object(leftId, rightId)) return make('identity');
  if (tagOf(left) === 'symbol' && left.n !== undefined && !judge.symbol(left.n, right.n)) return make('identity');
  return null;
}

function compareMembers(left, right, judge, where) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) {
    const sorted = (list) => [...list].sort().join('\0');
    return { path: `${where}/{keys}`, kind: sorted(leftKeys) === sorted(rightKeys) ? 'key-order' : 'members', expected: show(leftKeys), actual: show(rightKeys), raw: [left, right] };
  }
  for (const key of leftKeys) {
    const found = compareValues(left[key], right[key], judge, `${where}/${key}`);
    if (found) return found;
  }
  return null;
}
function compareList(left, right, judge, where, item = compareValues) {
  if (!Array.isArray(left) || !Array.isArray(right)) return { path: where || '/', kind: 'value', expected: show(left), actual: show(right), raw: [left, right] };
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const found = item(left[index], right[index], judge, `${where}/${index}`);
    if (found) return found;
  }
  if (left.length !== right.length) return { path: `${where}/${length}`, kind: 'value', expected: left.length > length ? show(left[length]) : '(end)', actual: right.length > length ? show(right[length]) : '(end)', raw: [left[length], right[length]] };
  return null;
}
const entryPair = (left, right, judge, where) => compareList(left, right, judge, where);
const dataDifference = (left, right, where) => (JSON.stringify(left) === JSON.stringify(right) ? null : { path: where || '/', kind: 'value', expected: show(left), actual: show(right), raw: [left, right] });

/** Compares two nodes' content (not their identity): the structure each codec tag gives, member and item values recursively. */
function compareContent(left, right, judge, where) {
  if (left === right) return null;
  const type = kindName(left);
  if (type !== kindName(right) || typeof left !== 'object' || left === null) {
    const undefinedNull = (tagOf(left) === 'undefined' && right === null) || (left === null && tagOf(right) === 'undefined');
    return { path: where || '/', kind: undefinedNull ? 'undefined-null' : 'value', expected: show(left), actual: show(right), raw: [left, right] };
  }
  if (Array.isArray(left)) return compareList(left, right, judge, where);
  const leftTag = tagOf(left);
  const rightTag = tagOf(right);
  if (leftTag !== rightTag) {
    const undefinedNull = (leftTag === 'undefined' && right === null) || (left === null && rightTag === 'undefined');
    return { path: where || '/', kind: undefinedNull ? 'undefined-null' : 'value', expected: show(left), actual: show(right), raw: [left, right] };
  }
  if (leftTag === undefined) return compareMembers(left, right, judge, where);
  // Members other than the tag's value-holding ones are data, compared as written.
  const data = (keys) => {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (keys.includes(key)) continue;
      const found = dataDifference(left[key], right[key], `${where}/${key}`);
      if (found) return found;
    }
    return null;
  };
  switch (leftTag) {
    case 'escape': case 'nullproto': return compareMembers(left.value, right.value, judge, `${where}/value`);
    case 'symkeys': return compareContent(left.value, right.value, judge, `${where}/value`) ?? compareList(left.symbols, right.symbols, judge, `${where}/symbols`, entryPair);
    case 'array': return data(['items', 'props']) ?? compareList(left.items, right.items, judge, `${where}/items`) ?? (left.props || right.props ? compareMembers(left.props ?? {}, right.props ?? {}, judge, `${where}/props`) : null);
    case 'map': return data(['entries']) ?? compareList(left.entries, right.entries, judge, `${where}/entries`, entryPair);
    case 'set': return data(['values']) ?? compareList(left.values, right.values, judge, `${where}/values`);
    case 'class': {
      const found = data(['value', 'primitive', 'cause', 'errors']);
      if (found) return found;
      for (const key of ['primitive']) if (key in left || key in right) { const inner = compareValues(left[key], right[key], judge, `${where}/${key}`); if (inner) return inner; }
      const members = compareMembers(left.value, right.value, judge, `${where}/value`);
      if (members) return members;
      for (const key of ['cause', 'errors']) if (key in left || key in right) { const inner = compareValues(left[key], right[key], judge, `${where}/${key}`); if (inner) return inner; }
      return null;
    }
    case 'regexp': return data(['lastIndex']) ?? compareValues(left.lastIndex, right.lastIndex, judge, `${where}/lastIndex`);
    case 'abortsignal': return data(['reason']) ?? compareValues(left.reason, right.reason, judge, `${where}/reason`);
    case 'date': return data(['value']) ?? compareValues(left.value, right.value, judge, `${where}/value`);
    case 'symbol': return data(['n']);
    default: return data([]);
  }
}

const numberOf = (node) => (typeof node === 'number' ? node : tagOf(node) === 'number' ? Number(node.value) : null);
/**
 * Refines a value difference by what the harness supplied (§4.2): a recorded
 * number that is a time the steps were given, where the engine has another,
 * is a `time-oracle` difference; a recorded value that is a draw the steps
 * were given is a `draw-oracle` one.
 */
function oracleKind(found, supplied) {
  if (found.kind !== 'value') return found;
  const [expected, actual] = found.raw;
  const expectedNumber = numberOf(expected);
  if (expectedNumber !== null && supplied.times.has(expectedNumber) && !supplied.times.has(numberOf(actual))) {
    return { ...found, kind: 'time-oracle', detail: `the engine stored ${show(actual)}, which is no time supplied up to here; the recording has the supplied ${expectedNumber}` };
  }
  const key = show(expected);
  if (supplied.draws.has(key)) return { ...found, kind: 'draw-oracle', detail: `the recording has a value drawn ${supplied.draws.get(key)}; the engine has ${show(actual)}` };
  return found;
}

const EFFECT_SLOTS = Object.freeze(['args', 'answer', 'throws', 'value', 'state', 'previous', 'handle']);
const RESULT_SLOTS = Object.freeze(['returns', 'throws', 'after', 'changes', 'state', 'stateChanges']);
const stripSite = (item) => { const { site: _site, ...rest } = item; return rest; };
const describeEffect = (item) => `${item.kind}${item.port ? ` ${item.port}` : ''}${item.source ? ` ${item.source}` : ''}`;

/**
 * Compares a replayed case with the recorded one. `recorded` is the case with
 * its slots resolved; `replayed` what the engine's `end` answered. Returns
 * `{ differences, stepsCompared }`: every difference of the first step that
 * differs (each `{ check, kind, step, path, expected, actual, detail }`, the
 * check one of input, effects, result, after, change-set), or the halt, the
 * missing steps, effects outside a step; empty when the case is reproduced.
 */
export function compareReplayed(recorded, replayed, { unordered = [] } = {}) {
  const differences = [];
  const expectedSteps = recorded.steps;
  const actualSteps = replayed.steps ?? [];
  const horizon = Math.min(expectedSteps.length, actualSteps.length);
  // The compared slots of both sides (the steps both have; no context, no draw sites), and where each step's sit.
  const flatten = (steps) => {
    const trees = [];
    const at = (tree) => { trees.push(tree); return trees.length - 1; };
    const index = steps.slice(0, horizon).map((step) => {
      const entry = { args: at(step.input.args), value: Object.prototype.hasOwnProperty.call(step.input, 'value') ? at(step.input.value) : undefined, target: Object.prototype.hasOwnProperty.call(step.input, 'target') ? at(step.input.target) : undefined, effects: [], parts: {} };
      for (const item of step.effects) {
        const slots = {};
        for (const key of EFFECT_SLOTS) if (Object.prototype.hasOwnProperty.call(item, key)) slots[key] = at(item[key]);
        entry.effects.push(slots);
      }
      for (const key of RESULT_SLOTS) if (Object.prototype.hasOwnProperty.call(step, key)) entry.parts[key] = at(step[key]);
      return entry;
    });
    return { trees, index };
  };
  const left = flatten(expectedSteps);
  const right = flatten(actualSteps);
  const supplied = { times: new Set(), draws: new Map() };
  const judge = createIdentityJudge();
  const names = { call: createIdentityJudge().object, timer: createIdentityJudge().object };
  let stepsCompared = 0;
  // A stateful family's case starts from its entry state (as the engine had it, or as it was seeded): compared first.
  const recordedEntry = recorded.entry?.state ?? null;
  if (recordedEntry !== null && recordedEntry !== undefined) {
    supplied.times.add(recorded.entry.now);
    const difference = replayed.entry === undefined ? { path: '/entry/state', kind: 'value', expected: 'the entry state', actual: '(none)', raw: [recordedEntry, undefined] } : compareValues(recordedEntry, replayed.entry, judge, '/entry/state');
    if (difference) { differences.push({ check: 'entry-state', step: 0, ...oracleKind(difference, supplied) }); return { differences, stepsCompared }; }
  }
  for (let index = 0; index < horizon; index += 1) {
    const expected = expectedSteps[index];
    const actual = actualSteps[index];
    const step = expected.n;
    const l = left.index[index];
    const r = right.index[index];
    const value = (leftSlot, rightSlot, path) => compareValues(left.trees[leftSlot], right.trees[rightSlot], judge, path);
    supplied.times.add(expected.input.now);
    for (const item of expected.effects) {
      if (item.kind === 'clock') { const time = numberOf(item.value); if (time !== null) supplied.times.add(time); }
      if (item.kind === 'draw') supplied.draws.set(show(item.value), `by ${item.source} in step ${step}`);
    }
    const found = [];
    const add = (check, difference) => found.push({ check, step, ...difference });
    // Input: what the engine was handed, as it saw it (a broken rebuild shows here first).
    if (expected.input.kind !== actual.input.kind || expected.input.entry !== actual.input.entry || expected.input.now !== actual.input.now) {
      add('input', { kind: 'value', path: `/steps/${index}/input`, expected: `${expected.input.kind} ${expected.input.entry} at ${expected.input.now}`, actual: `${actual.input.kind} ${actual.input.entry} at ${actual.input.now}` });
    }
    const inputDifference = value(l.args, r.args, `/steps/${index}/input/args`);
    if (inputDifference) add('input', oracleKind(inputDifference, supplied));
    if (l.target !== undefined || r.target !== undefined) {
      const called = l.target === undefined || r.target === undefined ? { path: `/steps/${index}/input/target`, kind: 'value', expected: l.target === undefined ? '(none)' : 'a function', actual: r.target === undefined ? '(none)' : 'a function' } : value(l.target, r.target, `/steps/${index}/input/target`);
      if (called) add('input', called);
    }
    if (l.value !== undefined || r.value !== undefined) {
      const settled = l.value === undefined || r.value === undefined ? { path: `/steps/${index}/input/value`, kind: 'value', expected: l.value === undefined ? '(none)' : 'a value', actual: r.value === undefined ? '(none)' : 'a value' } : value(l.value, r.value, `/steps/${index}/input/value`);
      if (settled) add('input', settled);
    }
    // Effects, in order: their kinds and names first, then each one's members and payloads.
    const expectedEffects = expected.effects.map(stripSite);
    const actualEffects = actual.effects.map(stripSite);
    const expectedNames = expectedEffects.map(describeEffect);
    const actualNames = actualEffects.map(describeEffect);
    const sameNames = expectedNames.length === actualNames.length && expectedNames.every((name, at) => name === actualNames[at]);
    if (!sameNames) {
      const sorted = (list) => [...list].sort().join('\0');
      const onlyOrder = sorted(expectedNames) === sorted(actualNames);
      const waived = onlyOrder && expectedNames.every((name, at) => name === actualNames[at] || unordered.some((port) => name === `port ${port}`));
      if (!waived) {
        const at = expectedNames.findIndex((name, position) => name !== actualNames[position]);
        const position = at < 0 ? Math.min(expectedNames.length, actualNames.length) : at;
        const kind = onlyOrder ? 'order' : expectedNames.length > actualNames.length ? 'missing' : expectedNames.length < actualNames.length ? 'extra' : 'value';
        add('effects', { kind, path: `/steps/${index}/effects/${position}`, expected: show(expectedNames), actual: show(actualNames) });
      }
    } else {
      for (let at = 0; at < expectedEffects.length; at += 1) {
        const e = expectedEffects[at];
        const a = actualEffects[at];
        const memberKeys = [...new Set([...Object.keys(e), ...Object.keys(a)])].filter((key) => !EFFECT_SLOTS.includes(key));
        for (const key of memberKeys) {
          // A port call's number and a timer's id are each side's own names: compared as a pairing across the case.
          const paired = key === 'call' && e.kind === 'port' ? 'call' : key === 'id' && (e.kind === 'timer.set' || e.kind === 'timer.clear') && e[key] !== null && a[key] !== null ? 'timer' : null;
          if (paired) { if (!names[paired](e[key], a[key])) add('effects', { kind: 'identity', path: `/steps/${index}/effects/${at}/${key}`, expected: show(e[key]), actual: show(a[key]), detail: `the recording's ${paired} ${show(e[key])} is paired with another ${paired} of the engine's already` }); continue; }
          if (JSON.stringify(e[key]) !== JSON.stringify(a[key])) add('effects', { kind: 'value', path: `/steps/${index}/effects/${at}/${key}`, expected: show(e[key]), actual: show(a[key]) });
        }
        const keys = Object.keys(l.effects[at]);
        const otherKeys = Object.keys(r.effects[at]);
        if (keys.join() !== otherKeys.join()) { add('effects', { kind: 'value', path: `/steps/${index}/effects/${at}/{keys}`, expected: show(keys), actual: show(otherKeys) }); continue; }
        for (const key of keys) {
          const difference = value(l.effects[at][key], r.effects[at][key], `/steps/${index}/effects/${at}/${key}`);
          if (difference) add('effects', oracleKind(difference, supplied));
        }
      }
    }
    // The result: what the call returned or threw, the arguments after it, the change set.
    for (const [key, check] of [['returns', 'result'], ['throws', 'result'], ['after', 'after'], ['changes', 'change-set'], ['state', 'state'], ['stateChanges', 'state-changes']]) {
      const has = l.parts[key] !== undefined;
      const other = r.parts[key] !== undefined;
      if (has && other) {
        const difference = value(l.parts[key], r.parts[key], `/steps/${index}/${key}`);
        if (difference) add(check, oracleKind(difference, supplied));
      } else if (has !== other) {
        add(check, { kind: key === 'returns' || key === 'throws' ? 'thrown' : 'value', path: `/steps/${index}/${key}`, expected: has ? show(left.trees[l.parts[key]]) : '(none)', actual: other ? show(right.trees[r.parts[key]]) : '(none)' });
      }
    }
    // Where the step's effects sit relative to its return (recording 7): how many came before the synchronous part
    // returned or threw. Compared once the effects themselves agree, so a moved effect is told from a changed one.
    if (!found.some((item) => item.check === 'effects') && (Object.prototype.hasOwnProperty.call(expected, 'returnedAt') || Object.prototype.hasOwnProperty.call(actual, 'returnedAt')) && expected.returnedAt !== actual.returnedAt) {
      const position = (count) => (count === undefined ? '(not reported)' : `${count} of ${expectedEffects.length} effects before the return`);
      add('effects', { kind: 'return-position', path: `/steps/${index}/returnedAt`, expected: position(expected.returnedAt), actual: position(actual.returnedAt),
        detail: expected.returnedAt === undefined || actual.returnedAt === undefined ? 'one side does not say where the return was' : actual.returnedAt < expected.returnedAt ? 'an effect the recording made before the return came after it' : 'an effect the recording made after the return came before it' });
    }
    if (replayed.halt && replayed.halt.step === step) found.unshift({ check: 'halt', kind: replayed.halt.check, step, path: `/steps/${index}`, expected: 'the step answered from the recording', actual: replayed.halt.detail, detail: replayed.halt.detail });
    if (found.length) { differences.push(...found); return { differences, stepsCompared }; }
    stepsCompared += 1;
  }
  if (replayed.halt) {
    differences.push({ check: 'halt', kind: replayed.halt.check, step: replayed.halt.step, path: '/steps', expected: 'every step answered from the recording', actual: replayed.halt.detail, detail: replayed.halt.detail });
    return { differences, stepsCompared };
  }
  if (expectedSteps.length !== actualSteps.length) {
    differences.push({ check: 'step-count', kind: 'value', step: horizon + 1, path: '/steps', expected: String(expectedSteps.length), actual: String(actualSteps.length) });
    return { differences, stepsCompared };
  }
  // The state the case ended with (at its test's end; inputs that came later are its late steps).
  const recordedEnd = recorded.end?.state ?? null;
  if (recordedEnd !== null && recordedEnd !== undefined) {
    const difference = replayed.end === undefined ? { path: '/end/state', kind: 'value', expected: 'the end state', actual: '(none)', raw: [recordedEnd, undefined] } : compareValues(recordedEnd, replayed.end, judge, '/end/state');
    if (difference) { differences.push({ check: 'end-state', step: null, ...oracleKind(difference, supplied) }); return { differences, stepsCompared }; }
  }
  // The engine timers still pending when the test ended (C0e fix round): which (the recording's name, given by the
  // bind of their set), the delay each was set with, timeout or interval, and the step that set it.
  const difference = comparePending(recorded.end?.pending ?? [], replayed.pending, recorded.steps, judge);
  if (difference) { differences.push({ check: 'pending-timers', step: null, ...difference }); return { differences, stepsCompared }; }
  if ((replayed.outside ?? []).length) {
    differences.push({ check: 'outside', kind: 'value', step: null, path: '/outside', expected: 'no effect while no step is open', actual: show(replayed.outside.map((item) => item.what)) });
  }
  return { differences, stepsCompared };
}

/**
 * The first difference between the pending timers a case recorded at its end and those the engine reports
 * (`{timer, delay, repeat, step}`, the engine's step being its own count, mapped to the recorded step number), or
 * null. An engine that says nothing of them is a difference when the recording has any.
 */
export function comparePending(recorded, replayed, steps, judge) {
  if (!Array.isArray(replayed)) return recorded.length ? { kind: 'value', path: '/end/pending', expected: show(recorded.map((item) => item.timer)), actual: '(not reported)' } : null;
  const mapped = replayed.map((item) => ({ ...item, step: Number.isInteger(item?.step) ? (steps[item.step - 1]?.n ?? item.step) : item?.step }));
  const length = Math.max(recorded.length, mapped.length);
  for (let index = 0; index < length; index += 1) {
    const left = recorded[index];
    const right = mapped[index];
    const where = `/end/pending/${index}`;
    if (!left || !right) return { kind: 'value', path: where, expected: left ? show({ timer: left.timer, step: left.step }) : '(none)', actual: right ? show({ timer: right.timer, step: right.step }) : '(none)' };
    for (const key of ['timer', 'repeat', 'step']) if (left[key] !== right[key]) return { kind: 'value', path: `${where}/${key}`, expected: show(left[key]), actual: show(right[key]) };
    const found = compareValues(left.delay, right.delay, judge, `${where}/delay`);
    if (found) return found;
  }
  return null;
}
