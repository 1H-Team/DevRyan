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
  { what: 'where an effect sits relative to the step\'s return', why: 'the recording does not hold it: the recorder places an effect in the step of the engine chain that made it, whether the entry had returned or not, so an effect moved into a job after the return is not seen (C0d review, note 1). Comparing it needs the recorder to write, per step, how many of its effects were made before the entry returned (`returnedAt`, set when the synchronous call returns), a recording version up and toy/expected rewritten; the engine would then report the same count. For a sans-IO Rust step the distinction does not exist (a step returns its effects)' },
  { what: 'non-enumerable own properties', why: 'the codec writes enumerable own properties only (a codec limit); no module a mapped family reaches in packages/ui (or in shared-runtime) defines a property or reads one\'s enumerability, and orchestration-runtime, reached only for a predicate, freezes only its own constants (`replay-product.full.test.mjs` checks the sources); a Rust value has no such attribute' },
  { what: 'whether an object is frozen, sealed or extensible, and whether a property is writable', why: 'the codec does not write it (a codec limit); no module a mapped family reaches in packages/ui freezes, seals or prevents extension (`replay-product.full.test.mjs` checks), and a Rust value has no such state' },
  { what: 'case-level `flags`, `entry`, `end` and `status`, and the engine\'s codec `flags`', why: '`entry.state` and `end.state` are null for every family replayed today (a family with state is not replayable yet, C0e); flags and status are the recorder\'s and the engine\'s diagnostics' },
  { what: 'what a unit noted while its module loaded', why: 'no case was open (a module-level clock read, say): it is reported as a note, never charged to a case; what is noted between two cases is charged to the case before (`outside`)' },
  { what: 'bindings the engine could not make', why: 'no difference by itself: a later input that names the object then holds another one and differs by identity; reported as a note' },
  { what: 'the step\'s `now` as a value of its own', why: 'the replayer sends it; it is compared only as what the engine says it was given (an echo), and stored times are judged by the time oracle' },
]);

// --------------------------------------------------------------- what can be replayed yet

/** The later package that replays a feature this replayer does not. */
export const LATER = Object.freeze({ store: 'C0e (store families)', timer: 'C0e (time-driven families)', transport: 'C0f (transport ports)' });

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
export function notReplayable(kase, family) {
  if (family.state) return { feature: `the family snapshots module state (${family.state})`, later: LATER.store };
  for (const step of kase.steps ?? []) {
    const { input } = step;
    if (input.kind === 'timer') return { feature: 'a timer firing as input', later: LATER.timer };
    if (step.late) return { feature: 'an input after its test ended', later: LATER.timer };
    if (input.kind === 'get' || String(input.entry ?? '').includes('#')) return { feature: 'engine code the family handed out', later: LATER.store };
    if (input.kind !== 'call') return { feature: `an input of kind ${input.kind}`, later: LATER.transport };
    if (input.during !== undefined || input.caller !== undefined) return { feature: 'an input another family or a port call delivered', later: LATER.transport };
    const held = holdsTag(input.args, ['promise', 'port', 'response', 'request', 'opaque', 'unencodable', 'weak']);
    if (held) return { feature: `an argument holding a ${held}`, later: LATER.transport };
    for (const item of step.effects) {
      if (item.late) return { feature: 'an effect after its test ended', later: LATER.timer };
      if (item.kind === 'timer.set' || item.kind === 'timer.clear') return { feature: `a ${item.kind} effect`, later: LATER.timer };
      if (item.kind === 'clock' || item.kind === 'draw') continue;
      if (item.kind !== 'port') return { feature: `a ${item.kind} effect`, later: LATER.transport };
      if (!item.port.startsWith('module:') && !(family.injectedNames ?? []).includes(item.port)) return { feature: `a call of port ${item.port}`, later: LATER.transport };
      const answer = Object.prototype.hasOwnProperty.call(item, 'answer') ? item.answer : item.throws;
      const answered = holdsTag(answer, ['promise', 'port', 'response', 'request', 'opaque', 'unencodable', 'weak', 'function']);
      if (answered) return { feature: `a port answer holding a ${answered}`, later: LATER.transport };
      if (holdsTag(item.args, ['function'])) return { feature: 'a function handed to a port (a callback)', later: LATER.transport };
    }
  }
  return null;
}

// --------------------------------------------------------------- the step's inputs

/** What the engine may know of a step's effects: their answers, in recorded order. */
export function envOf(step) {
  const env = [];
  for (const item of step.effects) {
    if (item.kind === 'port') env.push(Object.prototype.hasOwnProperty.call(item, 'throws') ? { kind: 'port', port: item.port, throws: item.throws } : { kind: 'port', port: item.port, answer: item.answer });
    else if (item.kind === 'clock' || item.kind === 'draw') env.push({ kind: item.kind, source: item.source, value: item.value });
  }
  return env;
}

// The slots of a recorded step in written order, each `[key, tree, output]`: output slots are what the engine makes.
function stepSlots(step) {
  const slots = [['input.args', step.input.args, false]];
  step.effects.forEach((item, index) => {
    if (item.args !== undefined) slots.push([`effects.${index}.args`, item.args, true]);
    for (const key of ['answer', 'throws', 'value']) if (Object.prototype.hasOwnProperty.call(item, key)) slots.push([`effects.${index}.${key}`, item[key], item.kind === 'settled']);
  });
  for (const key of ['returns', 'throws', 'after', 'changes']) if (Object.prototype.hasOwnProperty.call(step, key)) slots.push([key, step[key], true]);
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
  return kase.steps.map((step) => {
    const bind = [];
    for (const [slot, tree, output] of stepSlots(step)) {
      forEachIdPath(tree, (n, path) => {
        if (seen.has(n)) return;
        seen.add(n);
        if (output) bind.push({ slot, path, n });
      });
    }
    return bind;
  });
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

const EFFECT_SLOTS = Object.freeze(['args', 'answer', 'throws', 'value']);
const RESULT_SLOTS = Object.freeze(['returns', 'throws', 'after', 'changes']);
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
      const entry = { args: at(step.input.args), effects: [], parts: {} };
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
  let stepsCompared = 0;
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
    for (const [key, check] of [['returns', 'result'], ['throws', 'result'], ['after', 'after'], ['changes', 'change-set']]) {
      const has = l.parts[key] !== undefined;
      const other = r.parts[key] !== undefined;
      if (has && other) {
        const difference = value(l.parts[key], r.parts[key], `/steps/${index}/${key}`);
        if (difference) add(check, oracleKind(difference, supplied));
      } else if (has !== other) {
        add(check, { kind: key === 'returns' || key === 'throws' ? 'thrown' : 'value', path: `/steps/${index}/${key}`, expected: has ? show(left.trees[l.parts[key]]) : '(none)', actual: other ? show(right.trees[r.parts[key]]) : '(none)' });
      }
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
  if ((replayed.outside ?? []).length) {
    differences.push({ check: 'outside', kind: 'value', step: null, path: '/outside', expected: 'no effect while no step is open', actual: show(replayed.outside.map((item) => item.what)) });
  }
  return { differences, stepsCompared };
}
