// The reshaped engine's transforms (package C0g): what makes an engine's end
// answer look like one a non-JavaScript engine would give, with the same
// observable behaviour, and the planted engines that differ just outside each
// freedom. Pure functions over an end answer as protocol 5 carries it (steps
// with their group and positions, the groups' effects), its strings put back;
// the reshaped engine process applies them to the TypeScript engine's
// answers, and the comparer's self-test applies them to recorded replays
// without a process.
//
// `reshaped`, the second engine: (1) the clock reads of a group each of whose
// steps had its reads of each source answered with one value (what the engine
// was handed, its steps' envs) are dropped, every step's opening and return position counting
// the other effects, as a Rust module handed `now` would; (2) every settled
// answer opens at the end of its group (where the first reaction of its
// promise runs is the JavaScript engine's own job order, which a Rust engine
// does not have), so the recorder's attribution of the group's effects to its
// steps is not what the exact rules rebuild; (3) object identity numbers are
// renamed by a bijection that changes their order, port call numbers and
// timer ids are counted from other bases; (4) the protocol objects (the
// answer, each step, each input, each group, each effect) list their members
// in reverse order. Nothing it does is observable by the candidate rules, and
// each is observable by the exact ones.
//
// The planted engines (`outside-*`) are the reshaped engine with one change
// just outside a freedom; each must come out different.
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const setMember = (out, key, value) => {
  if (key === '__proto__') Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true });
  else out[key] = value;
};

/** How many steps a step message carries nested in its port calls (`during`, recursively). */
export const nestedCount = (step) => (Array.isArray(step?.during) ? step.during.reduce((sum, item) => sum + 1 + nestedCount(item.step), 0) : 0);
/**
 * What the engine learns of each step from a step message, in the engine's
 * numbering (the step, then what is nested in it): its input's kind and
 * arrival (`together`, `immediate`), whether it was held, whether it is
 * nested, its env list.
 */
export const stepsOfMessage = (step, nested = false) => [
  { kind: step?.input?.kind, together: step?.input?.together === true, immediate: step?.input?.immediate, hold: step?.hold === true, nested, env: step?.env ?? [] },
  ...(Array.isArray(step?.during) ? step.during.flatMap((item) => stepsOfMessage(item.step, true)) : []),
];

/**
 * Renames every object identity number of a codec tree by `rename` (`id` and
 * `ref` nodes only: a hole's `n` is a count, a symbol's is paired apart and
 * left).
 */
export function renameIds(tree, rename) {
  const members = (node) => { const out = {}; for (const key of Object.keys(node)) setMember(out, key, walk(node[key])); return out; };
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isObject(node)) return node;
    switch (node.$dr) {
      case undefined: return members(node);
      case 'id': return { ...node, n: rename(node.n), value: walk(node.value) };
      case 'ref': return { ...node, n: rename(node.n) };
      case 'escape': case 'nullproto': return { ...node, value: members(node.value) };
      case 'symkeys': return { ...node, value: walk(node.value), symbols: node.symbols.map(([key, value]) => [walk(key), walk(value)]) };
      case 'array': return { ...node, items: walk(node.items), ...(node.props ? { props: members(node.props) } : {}) };
      case 'map': return { ...node, entries: node.entries.map(([key, value]) => [walk(key), walk(value)]) };
      case 'set': return { ...node, values: walk(node.values) };
      case 'class': {
        const out = { ...node, value: members(node.value) };
        for (const key of ['primitive', 'cause', 'errors']) if (own(node, key)) out[key] = walk(node[key]);
        return out;
      }
      case 'regexp': return { ...node, lastIndex: walk(node.lastIndex) };
      case 'abortsignal': return { ...node, reason: walk(node.reason) };
      case 'date': return { ...node, value: walk(node.value) };
      case 'bytes': case 'typed': return node.props ? { ...node, props: members(node.props) } : node;
      default: return node;
    }
  };
  return walk(tree);
}

const EFFECT_TREES = ['args', 'answer', 'throws', 'value', 'state', 'previous', 'handle', 'delay'];
const STEP_TREES = ['returns', 'throws', 'after', 'changes', 'state', 'stateChanges'];
const reversed = (object) => { const out = {}; for (const key of Object.keys(object).reverse()) setMember(out, key, object[key]); return out; };
const describe = (item) => `${item.kind}${item.port ? ` ${item.port}` : ''}${item.source ? ` ${item.source}` : ''}`;
const isInteger = Number.isInteger;

/** A bijection of positive integers that changes their order (identity numbers are small). */
export const renameNumber = (n) => (Number.isInteger(n) && n > 0 && n < 1000003 ? (n * 7919) % 1000003 : n);

/** An answer with its steps and groups copied (each group's effects a list of its own). */
export const copyAnswer = (replayed) => ({ ...replayed, steps: (replayed.steps ?? []).map((step) => ({ ...step })), groups: (replayed.groups ?? []).map((group) => ({ ...group, effects: [...(group?.effects ?? [])] })) });

/** The steps of group `g` (1-based), as indices in step order. */
export const membersOf = (replayed, group) => (replayed.steps ?? []).map((step, index) => [step, index]).filter(([step]) => step.group === group).map(([, index]) => index);

/** Takes the effect at `position` out of group `group`, every position after it one less. */
export function removeEffect(replayed, group, position) {
  const [removed] = replayed.groups[group - 1].effects.splice(position, 1);
  for (const step of replayed.steps) {
    if (step.group !== group) continue;
    for (const key of ['openedAt', 'returnedAt']) if (isInteger(step[key]) && step[key] > position) step[key] -= 1;
  }
  return removed;
}

/**
 * Puts `item` at `position` of group `group` (before what is there), every position after it one more; `glued` puts
 * it with the effect before it (a step that opened or returned right after that effect then comes after it too).
 */
export function insertEffect(replayed, group, position, item, { glued = false } = {}) {
  replayed.groups[group - 1].effects.splice(position, 0, item);
  const from = glued ? position - 1 : position;
  for (const step of replayed.steps) {
    if (step.group !== group) continue;
    for (const key of ['openedAt', 'returnedAt']) if (isInteger(step[key]) && step[key] > from) step[key] += 1;
  }
}

/** The positions of group `group` inside no step's synchronous part (its continuations), in order. */
export function continuationPositions(replayed, group) {
  const effects = replayed.groups[group - 1]?.effects ?? [];
  const sync = membersOf(replayed, group).map((index) => replayed.steps[index]).filter((step) => isInteger(step.openedAt) && isInteger(step.returnedAt));
  return effects.map((_, position) => position).filter((position) => !sync.some((step) => step.openedAt <= position && position < step.returnedAt));
}

/**
 * Every value tree of an end answer mapped by `map` (its steps' inputs and
 * results, its groups' effects, its entry and end states, its pending
 * timers' delays).
 */
function mapTrees(replayed, map) {
  const steps = (replayed.steps ?? []).map((step) => {
    const input = { ...step.input };
    for (const key of ['args', 'value', 'target']) if (own(input, key)) input[key] = map(input[key]);
    const out = { ...step, input };
    for (const key of STEP_TREES) if (own(out, key)) out[key] = map(out[key]);
    return out;
  });
  const groups = (replayed.groups ?? []).map((group) => ({ ...group, effects: (group.effects ?? []).map((item) => { const out = { ...item }; for (const key of EFFECT_TREES) if (own(out, key)) out[key] = map(out[key]); return out; }) }));
  const out = { ...replayed, steps, groups };
  for (const key of ['entry', 'end']) if (own(out, key) && out[key] !== undefined) out[key] = map(out[key]);
  if (Array.isArray(out.pending)) out.pending = out.pending.map((item) => (isObject(item) && own(item, 'delay') ? { ...item, delay: map(item.delay) } : item));
  return out;
}

/** The env items of a group answered every read of each clock source with one value. */
const clockUniform = (env) => {
  const seen = new Map();
  for (const item of env ?? []) {
    if (item?.kind !== 'clock') continue;
    const value = JSON.stringify(item.value);
    if (seen.has(item.source) && seen.get(item.source) !== value) return false;
    seen.set(item.source, value);
  }
  return true;
};

/**
 * The reshaped engine's answer: `replayed` a protocol-5 end answer (strings
 * put back), `steps` what each step was sent (stepsOfMessage, in the engine's
 * numbering); `transforms` picks the parts (all by default; the self-test
 * runs each alone to show each needs its own freedom, and the names none).
 */
export function reshape(replayed, { steps: sent = [], transforms = { clock: true, group: true, names: true } }) {
  let answer = copyAnswer(replayed);
  // (1) Clock reads dropped where each step of the group was answered every read of each source with one value (a
  // top-level step's env holds the answers of the inputs nested in it too).
  if (transforms.clock) {
    answer.groups.forEach((group, at) => {
      const number = at + 1;
      if (!membersOf(answer, number).every((index) => clockUniform(sent[index]?.env ?? []))) return;
      for (let position = group.effects.length - 1; position >= 0; position -= 1) if (group.effects[position]?.kind === 'clock') removeEffect(answer, number, position);
    });
  }
  // (2) A settled answer opens at the end of its group (a Rust engine has no first reaction of a promise to open it at).
  if (transforms.group) {
    answer.steps = answer.steps.map((step) => (step.input?.kind === 'settle' && isInteger(step.group) && answer.groups[step.group - 1] ? { ...step, openedAt: answer.groups[step.group - 1].effects.length } : step));
  }
  // (3) Other names: identity numbers renamed, call numbers and timer ids from other bases.
  if (!transforms.names) return answer;
  answer.groups = answer.groups.map((group) => ({ ...group, effects: group.effects.map((item) => {
    const out = { ...item };
    if ((item.kind === 'port' || item.kind === 'new') && Number.isInteger(item.call)) out.call = item.call + 1000;
    if ((item.kind === 'timer.set' || item.kind === 'timer.clear') && Number.isInteger(item.id)) out.id = item.id + 500;
    return out;
  }) }));
  answer = mapTrees(answer, (tree) => renameIds(tree, renameNumber));
  // (4) Protocol objects with their members in reverse order.
  return reversed({ ...answer, steps: answer.steps.map((step) => reversed({ ...step, input: reversed(step.input) })), groups: answer.groups.map((group) => reversed({ ...group, effects: group.effects.map(reversed) })) });
}

const firstNumberPath = (tree, wanted) => {
  // The path of the first plain number equal to one of `wanted` in a tree, or null.
  const walk = (node, at) => {
    if (typeof node === 'number' && wanted.has(node)) return at;
    if (Array.isArray(node)) { for (let index = 0; index < node.length; index += 1) { const found = walk(node[index], [...at, index]); if (found) return found; } return null; }
    if (!isObject(node)) return null;
    // A tag's own numbers (an identity's or a symbol's `n`, a hole's count) are no values.
    for (const key of Object.keys(node)) { if (key === '$dr' || (node.$dr !== undefined && key === 'n')) continue; const found = walk(node[key], [...at, key]); if (found) return found; }
    return null;
  };
  return walk(tree, []);
};
const setAt = (tree, at, value) => {
  if (!at.length) return value;
  const [head, ...rest] = at;
  if (Array.isArray(tree)) { const out = [...tree]; out[head] = setAt(tree[head], rest, value); return out; }
  const out = {};
  for (const key of Object.keys(tree)) setMember(out, key, key === String(head) ? setAt(tree[key], rest, value) : tree[key]);
  return out;
};

/** The answer with the first number of a step's results equal to a supplied time (`reads`, else a now up to that step) one more. */
function shiftTime(replayed, reads, nows) {
  for (const [index, step] of replayed.steps.entries()) {
    const wanted = reads ?? new Set(nows.slice(0, index + 1).filter((now) => typeof now === 'number'));
    for (const key of STEP_TREES) {
      if (!own(step, key)) continue;
      const at = firstNumberPath(step[key], wanted);
      if (!at) continue;
      const steps = [...replayed.steps];
      const old = at.reduce((node, part) => node[part], step[key]);
      steps[index] = { ...step, [key]: setAt(step[key], at, old + 1) };
      return { ...replayed, steps };
    }
  }
  return null;
}

/** The first top-level step of each group (in step order), or undefined. */
const firstOf = (replayed, group) => membersOf(replayed, group)[0];
/** Where a moved effect goes in the next group: right after its first step's synchronous part, or at its start. */
const afterSyncPart = (replayed, group) => {
  const step = replayed.steps[firstOf(replayed, group)];
  return step && isInteger(step.returnedAt) ? step.returnedAt : 0;
};

/**
 * Moves group `group`'s last continuation effect that is no clock read into the next group, right after the next
 * group's first step's synchronous part: what the engine did before the next group's input came, made after it.
 */
function leak(replayed, group) {
  const positions = continuationPositions(replayed, group).filter((position) => replayed.groups[group - 1].effects[position]?.kind !== 'clock');
  if (!positions.length || !replayed.groups[group]) return null;
  const moved = removeEffect(replayed, group, positions[positions.length - 1]);
  insertEffect(replayed, group + 1, afterSyncPart(replayed, group + 1), moved);
  return replayed;
}

/**
 * The planted engines just outside a freedom, each the reshaped answer with
 * one change (`steps` and `nows` as the engine learnt them: stepsOfMessage,
 * each step's `now`). Returns the changed answer, or null when the case gives
 * the change no place (the check counts the cases a plant applies to and
 * requires some).
 */
export const OUTSIDE = Object.freeze({
  // An effect of a group moved into the next group: a group runs to quiescence before the next input is delivered,
  // so which group an effect is in is observable.
  'outside-group-leak': (given) => {
    for (let group = 1; group < (given.groups ?? []).length; group += 1) { const found = leak(copyAnswer(given), group); if (found) return found; }
    return null;
  },
  // B1 of the C0g review: an effect made after a later test call instead of before it, where that call was held in
  // the same delivery (between a port call and its immediate answer) and the TypeScript engine gives it only once
  // the engine ran out. The groups end before such a call, so the move crosses a group boundary.
  'outside-async-past-later-input': (given, { steps: sent = [] }) => {
    for (let group = 2; group <= (given.groups ?? []).length; group += 1) {
      const first = firstOf(given, group);
      if (first === undefined || sent[first]?.nested) continue;
      // The top-level step before it was held: the call came in the same delivery, after the engine ran out.
      let before = first - 1;
      while (before >= 0 && sent[before]?.nested) before -= 1;
      if (before < 0 || !sent[before]?.hold) continue;
      const found = leak(copyAnswer(given), group - 1);
      if (found) return found;
    }
    return null;
  },
  // The last effect a step made before it returned made after it instead.
  'outside-sync-to-async': (given) => {
    const answer = copyAnswer(given);
    const index = answer.steps.findIndex((step) => isInteger(step.openedAt) && isInteger(step.returnedAt) && step.returnedAt > step.openedAt);
    if (index < 0) return null;
    answer.steps[index].returnedAt -= 1;
    return answer;
  },
  // A step's first synchronous effect made inside the synchronous part of a step of its group before it.
  'outside-sync-across-members': (given) => {
    for (const [group] of (given.groups ?? []).entries()) {
      const answer = copyAnswer(given);
      const sync = membersOf(answer, group + 1).filter((index) => isInteger(answer.steps[index].openedAt) && isInteger(answer.steps[index].returnedAt));
      for (let at = 1; at < sync.length; at += 1) {
        const before = answer.steps[sync[at - 1]];
        const member = answer.steps[sync[at]];
        if (member.returnedAt <= member.openedAt || before.returnedAt > member.openedAt) continue;
        const moved = removeEffect(answer, group + 1, member.openedAt);
        const into = before.returnedAt;
        insertEffect(answer, group + 1, into, moved);
        before.returnedAt = into + 1;
        return answer;
      }
    }
    return null;
  },
  // Two adjacent continuation effects of a group, of different kinds or ports, made in the other order (the C0g
  // review's B2 engine, a wrong order an attribution to two steps would hide, is this one in protocol 5).
  'outside-async-reordered': (given) => {
    for (let group = 1; group <= (given.groups ?? []).length; group += 1) {
      const positions = continuationPositions(given, group);
      const effects = given.groups[group - 1].effects;
      for (let k = 0; k + 1 < positions.length; k += 1) {
        if (positions[k + 1] !== positions[k] + 1 || describe(effects[positions[k]]) === describe(effects[positions[k + 1]])) continue;
        const answer = copyAnswer(given);
        const list = answer.groups[group - 1].effects;
        [list[positions[k]], list[positions[k + 1]]] = [list[positions[k + 1]], list[positions[k]]];
        return answer;
      }
    }
    return null;
  },
  // A continuation effect made twice (a request sent twice).
  'outside-continuation-duplicated': (given) => {
    for (let group = 1; group <= (given.groups ?? []).length; group += 1) {
      const positions = continuationPositions(given, group).filter((position) => given.groups[group - 1].effects[position]?.kind !== 'clock');
      if (!positions.length) continue;
      const answer = copyAnswer(given);
      const position = positions[0];
      insertEffect(answer, group, position + 1, structuredClone(answer.groups[group - 1].effects[position]));
      return answer;
    }
    return null;
  },
  // Of two equal continuation effects in a row (no clock read), one made only once.
  'outside-repeat-dropped': (given) => {
    for (let group = 1; group <= (given.groups ?? []).length; group += 1) {
      const positions = continuationPositions(given, group);
      const effects = given.groups[group - 1].effects;
      const same = (a, b) => a.kind !== 'clock' && JSON.stringify({ ...a, call: 0, id: 0 }) === JSON.stringify({ ...b, call: 0, id: 0 });
      for (let k = 0; k + 1 < positions.length; k += 1) {
        if (positions[k + 1] !== positions[k] + 1 || !same(effects[positions[k]], effects[positions[k + 1]])) continue;
        const answer = copyAnswer(given);
        removeEffect(answer, group, positions[k + 1]);
        return answer;
      }
    }
    return null;
  },
  // A timer still pending at the end named by another group than the one that set it.
  'outside-pending-across-group': (given) => {
    const pending = Array.isArray(given.pending) ? given.pending : [];
    const count = (given.groups ?? []).length;
    for (const [at, item] of pending.entries()) {
      if (!isInteger(item?.group) || count < 2) continue;
      const moved = [...pending];
      moved[at] = { ...item, group: item.group === 1 ? 2 : item.group - 1 };
      return { ...given, pending: moved };
    }
    return null;
  },
  // A time the engine stores or returns, one millisecond off the time it was given: a value a clock read returned that
  // is no step's now (performance.now's) first, else a now.
  'outside-clock-time-shifted': (given, { nows, steps: sent = [] }) => {
    const reads = new Set(sent.flatMap((step) => step.env ?? []).filter((item) => item?.kind === 'clock' && typeof item.value === 'number' && !nows.includes(item.value)).map((item) => item.value));
    for (const pass of [reads, null]) {
      const found = shiftTime(given, pass, nows);
      if (found) return found;
    }
    return null;
  },
  // A draw dropped as if it were a clock read: draws are inputs taken in order, never free.
  'outside-draw-dropped': (given) => {
    for (let group = 1; group <= (given.groups ?? []).length; group += 1) {
      const position = given.groups[group - 1].effects.findIndex((item) => item?.kind === 'draw');
      if (position < 0) continue;
      const answer = copyAnswer(given);
      removeEffect(answer, group, position);
      return answer;
    }
    return null;
  },
});

/** A planted engine's answer: the reshaped one, then the plant's change (null when the case gives it no place). */
export function plantedAnswer(mode, replayed, context) {
  const shaped = reshape(replayed, context);
  if (mode === 'reshaped') return shaped;
  const plant = OUTSIDE[mode];
  if (!plant) throw new Error(`no reshaped engine mode ${mode}`);
  return plant(shaped, context);
}
