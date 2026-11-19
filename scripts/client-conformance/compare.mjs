// Exact comparison of two containers (used by the toy corpus check and the
// stability tool). Nothing is masked: key order, undefined against null, -0,
// Set and Map order and aliasing all live in the value bytes, and in the end
// the bytes themselves are compared, line by line. Every difference names its
// check and where it is: the case id, the step, and the path to the first
// differing member, with value slots resolved into their trees.
//   format       a container the strict reader refuses (container.mjs)
//   header       a header member, or the header's bytes
//   value-table  the value table: content, or the order of first reference
//   case-set     a case present in one container only
//   case-order   the same cases in another order (a replay runs them in order)
//   naming       line, describe path, name, ordinal, kind or test status
//   flags        outcome, flags and reason (unrecordable, inconclusive)
//   seed         the case's random seed
//   state        entry or end state, or their nominal times
//   step-count   one recording has more steps
//   input        a step's input (kind, entry, port, arguments, now, during, caller) and whether it came late
//   effects      a step's effects, in order
//   result       return value, thrown value, arguments after the call
//   changes      the change set of a draft
//   context      test-originated records (context, never compared by a port)
//   bytes        a case line whose bytes differ although no check above found a difference
import { ContainerError, readContainer, VALUE_REF } from './container.mjs';

const isSlot = (value) => typeof value === 'string' && VALUE_REF.test(value);
const show = (value) => { const text = JSON.stringify(value); return text === undefined ? 'undefined' : text.length > 160 ? `${text.slice(0, 157)}...` : text; };
const identity = (value) => value;

/**
 * The first difference between two JSON records, `{ path, expected, actual }`
 * or null. Slots are resolved through the resolvers (pass `identity` for
 * members that hold no slots: they are then compared as strings).
 */
export function firstDifference(expected, actual, resolveExpected, resolveActual, where = '') {
  const slots = resolveExpected !== identity;
  if (slots && isSlot(expected) && isSlot(actual)) {
    if (expected === actual) return null;
    return firstDifference(resolveExpected(expected), resolveActual(actual), resolveExpected, resolveActual, where);
  }
  if (slots && isSlot(expected)) return firstDifference(resolveExpected(expected), actual, resolveExpected, resolveActual, where);
  if (slots && isSlot(actual)) return firstDifference(expected, resolveActual(actual), resolveExpected, resolveActual, where);
  if (expected === actual) return null;
  const type = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
  if (type(expected) !== type(actual) || typeof expected !== 'object' || expected === null) return { path: where || '/', expected: show(expected), actual: show(actual) };
  if (Array.isArray(expected)) {
    const length = Math.min(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      const found = firstDifference(expected[index], actual[index], resolveExpected, resolveActual, `${where}/${index}`);
      if (found) return found;
    }
    if (expected.length !== actual.length) return { path: `${where}/${length}`, expected: expected.length > length ? show(expected[length]) : '(end)', actual: actual.length > length ? show(actual[length]) : '(end)' };
    return null;
  }
  const expectedKeys = Object.keys(expected);
  const actualKeys = Object.keys(actual);
  for (let index = 0; index < Math.max(expectedKeys.length, actualKeys.length); index += 1) {
    const key = expectedKeys[index];
    if (key !== actualKeys[index]) return { path: `${where}/{keys}`, expected: show(expectedKeys), actual: show(actualKeys) };
    const found = firstDifference(expected[key], actual[key], resolveExpected, resolveActual, `${where}/${key}`);
    if (found) return found;
  }
  return null;
}

const CASE_CHECKS = { id: 'naming', digest: 'naming', kind: 'naming', file: 'naming', line: 'naming', describe: 'naming', name: 'naming', ordinal: 'naming', family: 'naming', status: 'naming',
  outcome: 'flags', flags: 'flags', reason: 'flags', seed: 'seed', entry: 'state', end: 'state', context: 'context' };
const VALUE_MEMBERS = new Set(['entry', 'steps', 'end', 'context']);
const STEP_CHECKS = { n: 'input', input: 'input', late: 'input', effects: 'effects', returns: 'result', throws: 'result', after: 'result', changes: 'changes' };

/**
 * All differences between two container texts: header, value table, case set
 * and order, then one per case (the first one found), then a `bytes`
 * difference for any case line whose bytes differ with nothing else found.
 * `ignoreHeader` lists header members not compared (a planted difference's
 * copy has its own recorder sources).
 */
export function compareContainers(expectedText, actualText, { ignoreHeader = [] } = {}) {
  let expected;
  let actual;
  try { expected = readContainer(expectedText); } catch (error) { return [{ check: error instanceof ContainerError ? error.check : 'format', detail: `expected: ${error.message}` }]; }
  try { actual = readContainer(actualText); } catch (error) { return [{ check: error instanceof ContainerError ? error.check : 'format', detail: `actual: ${error.message}` }]; }
  const differences = [];
  for (const key of new Set([...Object.keys(expected.header), ...Object.keys(actual.header)])) {
    if (ignoreHeader.includes(key)) continue;
    if (expected.header[key] !== actual.header[key]) differences.push({ check: 'header', path: key, expected: show(expected.header[key]), actual: show(actual.header[key]) });
  }
  if (!differences.some((entry) => entry.check === 'header')) {
    const strip = (header) => JSON.stringify(Object.fromEntries(Object.entries(header).filter(([key]) => !ignoreHeader.includes(key))));
    if (strip(expected.header) !== strip(actual.header)) differences.push({ check: 'header', path: '{keys}', expected: strip(expected.header), actual: strip(actual.header) });
  }
  if (expected.lines[1] !== actual.lines[1]) {
    const expectedHashes = [...expected.values.keys()];
    const actualHashes = [...actual.values.keys()];
    const sameSet = expectedHashes.length === actualHashes.length && expectedHashes.every((hash) => actual.values.has(hash));
    differences.push({ check: 'value-table', path: '/values', detail: sameSet ? 'the same values in another order' : `${expectedHashes.filter((hash) => !actual.values.has(hash)).length} values only expected, ${actualHashes.filter((hash) => !expected.values.has(hash)).length} only recorded` });
  }
  const actualCases = new Map(actual.cases.map((record) => [record.id, record]));
  const expectedIds = new Set(expected.cases.map((record) => record.id));
  for (const id of [...expected.cases, ...actual.cases].map((record) => record.id)) {
    if (expected.cases.filter((record) => record.id === id).length > 1 || actual.cases.filter((record) => record.id === id).length > 1) {
      differences.push({ check: 'case-set', case: id, detail: 'the id occurs more than once' });
      break;
    }
  }
  const commonExpected = expected.cases.map((record) => record.id).filter((id) => actualCases.has(id));
  const commonActual = actual.cases.map((record) => record.id).filter((id) => expectedIds.has(id));
  const moved = commonExpected.findIndex((id, index) => id !== commonActual[index]);
  if (moved >= 0) differences.push({ check: 'case-order', case: commonExpected[moved], detail: `expected at position ${moved + 1}, recorded ${commonActual[moved]} there` });
  const expectedLines = new Map(expected.cases.map((record, index) => [record.id, expected.lines[index + 2]]));
  const actualLines = new Map(actual.cases.map((record, index) => [record.id, actual.lines[index + 2]]));
  for (const record of expected.cases) {
    const other = actualCases.get(record.id);
    if (!other) { differences.push({ check: 'case-set', case: record.id, detail: 'expected but not recorded' }); continue; }
    const found = compareCase(record, other, expected.resolve, actual.resolve);
    if (found) differences.push({ case: record.id, ...found });
    else if (expectedLines.get(record.id) !== actualLines.get(record.id)) {
      const left = expectedLines.get(record.id);
      const right = actualLines.get(record.id);
      let index = 0;
      while (index < left.length && left[index] === right[index]) index += 1;
      differences.push({ check: 'bytes', case: record.id, path: `byte ${index}`, expected: show(left.slice(index, index + 40)), actual: show(right.slice(index, index + 40)) });
    }
  }
  for (const record of actual.cases) if (!expectedIds.has(record.id)) differences.push({ check: 'case-set', case: record.id, detail: 'recorded but not expected' });
  return differences;
}

function compareCase(expected, actual, resolveExpected, resolveActual) {
  const resolversFor = (key) => (VALUE_MEMBERS.has(key) ? [resolveExpected, resolveActual] : [identity, identity]);
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])];
  // Identity and entry first, then the steps in order, then the end state and the context.
  for (const key of keys.filter((name) => name !== 'steps' && name !== 'context' && name !== 'end')) {
    const found = firstDifference(expected[key], actual[key], ...resolversFor(key), `/${key}`);
    if (found) return { check: CASE_CHECKS[key] ?? 'naming', ...found };
  }
  const order = (record) => Object.keys(record).join(',');
  if (order(expected) !== order(actual)) return { check: 'naming', path: '/{keys}', expected: order(expected), actual: order(actual) };
  const left = expected.steps ?? [];
  const right = actual.steps ?? [];
  const steps = Math.min(left.length, right.length);
  for (let index = 0; index < steps; index += 1) {
    for (const key of [...new Set([...Object.keys(left[index]), ...Object.keys(right[index])])]) {
      const found = firstDifference(left[index][key], right[index][key], resolveExpected, resolveActual, `/steps/${index}/${key}`);
      if (found) return { check: STEP_CHECKS[key] ?? 'input', step: index + 1, ...found };
    }
    if (Object.keys(left[index]).join(',') !== Object.keys(right[index]).join(',')) return { check: 'result', step: index + 1, path: `/steps/${index}/{keys}`, expected: Object.keys(left[index]).join(','), actual: Object.keys(right[index]).join(',') };
  }
  if (left.length !== right.length) {
    return { check: 'step-count', step: steps + 1, path: '/steps', expected: String(left.length), actual: String(right.length) };
  }
  const end = firstDifference(expected.end, actual.end, resolveExpected, resolveActual, '/end');
  if (end) return { check: 'state', ...end };
  const found = firstDifference(expected.context, actual.context, resolveExpected, resolveActual, '/context');
  return found ? { check: 'context', ...found } : null;
}
