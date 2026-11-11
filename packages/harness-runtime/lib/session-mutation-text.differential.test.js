// The Rust diff core against the JavaScript reference, on seeded inputs: the
// whole result of mutationDiff with DEVRYAN_LEDGER_RUST=1 (answered by the
// core, which the path counters prove) must equal javascriptMutationDiff's.
// Sized by time, not by count: harness tests have run past Bun's 5 s default on
// a loaded machine, so each case sets its own timeout and the random pairs
// stop after DEVRYAN_LEDGER_DIFFERENTIAL_MS (default 2,000 ms).
//
// Extended run (by hand, before the switch is turned on by default; millions
// of pairs and large inputs):
//   cd packages/harness-runtime && DEVRYAN_LEDGER_DIFFERENTIAL=extended DEVRYAN_LEDGER_DIFFERENTIAL_MS=1800000 \
//     bun run test ./lib/session-mutation-text.differential.test.js --timeout 7200000
// DEVRYAN_LEDGER_DIFFERENTIAL_SEED picks another seed (default 20261111) and
// DEVRYAN_LEDGER_DIFFERENTIAL_PAIRS the minimum number of random pairs (1,000).
// The extended run prints its counts as JSON lines; any run prints them on a
// mismatch.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { LEDGER_CORE_RETAINED_MEMORY_BYTES, ledgerCore } from './ledger-core.js';
import { GRANULAR_TEXT_BYTES } from './session-mutation-files.js';
import { MUTATION_DIFF_WORK_BUDGET, javascriptMutationDiff, mutationDiff, mutationDiffPaths } from './session-mutation-text.js';

const SWITCH = 'DEVRYAN_LEDGER_RUST';
const EXTENDED = process.env.DEVRYAN_LEDGER_DIFFERENTIAL === 'extended';
const DURATION_MS = Number(process.env.DEVRYAN_LEDGER_DIFFERENTIAL_MS) > 0 ? Number(process.env.DEVRYAN_LEDGER_DIFFERENTIAL_MS) : 2_000;
// At least this many random pairs run whatever the clock says, so the coverage
// check does not depend on the machine's speed; a mismatch's pair index can be
// replayed by setting DEVRYAN_LEDGER_DIFFERENTIAL_PAIRS above it.
const MIN_PAIRS = Number.isSafeInteger(Number(process.env.DEVRYAN_LEDGER_DIFFERENTIAL_PAIRS)) && Number(process.env.DEVRYAN_LEDGER_DIFFERENTIAL_PAIRS) > 0
  ? Number(process.env.DEVRYAN_LEDGER_DIFFERENTIAL_PAIRS) : 1_000;
const SEED = Number.isSafeInteger(Number(process.env.DEVRYAN_LEDGER_DIFFERENTIAL_SEED)) && process.env.DEVRYAN_LEDGER_DIFFERENTIAL_SEED
  ? Number(process.env.DEVRYAN_LEDGER_DIFFERENTIAL_SEED) : 20261111;
// Generous: the loop itself stops at DURATION_MS; the rest is setup and the
// largest pairs on a machine running at several times its core count.
const TIMEOUT_MS = DURATION_MS + 120_000;

let previous;
beforeAll(() => { previous = process.env[SWITCH]; process.env[SWITCH] = '1'; });
afterAll(() => { if (previous === undefined) delete process.env[SWITCH]; else process.env[SWITCH] = previous; });

const latin1 = (utf8) => Buffer.from(utf8, 'utf8').toString('latin1');
// xorshift32: a small, seedable generator independent of Math.random.
function generator(seed) {
  let state = (seed >>> 0) || 1;
  const random = () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 4294967296; };
  const int = (limit) => Math.floor(random() * limit);
  const pick = (list) => list[int(list.length)];
  return { random, int, pick };
}

const ASCII = [[...'ab'], [...'abc\n'], [...'abcdefgh \n'], [...'aab'], [...'ab\n\t {}();']];
// Four-byte code points sharing their leading bytes: U+1F600-1F602 (F0 9F 98 8x),
// U+1F680-1F681 (F0 9F 9A 8x), U+10000-10001 (F0 90 80 8x).
const FOUR_BYTE = ['😀', '😁', '😂', '🚀', '🚁', '𐀀', '𐀁'].map(latin1);
const WIDE = ['é', 'è', 'ê', '中', '丸', '丹', ...['😀', '😁', '😂', '🚀', '🚁', '𐀀', '𐀁']].map(latin1);
const NON_ASCII = [['a', 'b', '\n', ...WIDE], ['a', ...FOUR_BYTE], FOUR_BYTE, ['a', ...['é', 'è'].map(latin1)], ['a', 'b', ...['中', '丸'].map(latin1)]];
const ALPHABETS = [...ASCII, ...NON_ASCII];
const NON_ASCII_BYTE = /[\x80-\xff]/;

/** Same kinds, same texts, nothing else on any change. */
function sameResult(expected, actual) {
  return expected.length === actual.length && expected.every((change, index) => {
    const other = actual[index];
    return Object.keys(other).join() === 'kind,text' && Object.keys(change).join() === 'kind,text' && change.kind === other.kind && change.text === other.text;
  });
}
const describeChanges = (changes) => changes.map((change) => `${change.kind}:${change.text.length}`).join(' ');

/** Compares both paths on one input; returns which path the Rust run took. */
function compare(state, label, before, after, budget) {
  const options = budget === undefined ? undefined : { budget };
  const expected = javascriptMutationDiff(before, after, options);
  const start = mutationDiffPaths();
  const actual = mutationDiff(before, after, options);
  const end = mutationDiffPaths();
  state.compared += 1;
  if (end.javascript !== start.javascript) state.fallbacks += 1;
  if (end.rust !== start.rust) state.rust += 1;
  if (end.early !== start.early) state.early += 1;
  if (!sameResult(expected, actual) && state.mismatches.length < 20) {
    state.mismatches.push({ label, budget, before: Buffer.from(before, 'latin1').toString('base64').slice(0, 400),
      after: Buffer.from(after, 'latin1').toString('base64').slice(0, 400), expected: describeChanges(expected), actual: describeChanges(actual) });
  }
  return expected;
}

const newState = () => ({ compared: 0, rust: 0, early: 0, fallbacks: 0, mismatches: [] });

describe('mutationDiff on the Rust path equals the JavaScript reference', () => {
  test('seeded random pairs, for the time budget', () => {
    const { random, int, pick } = generator(SEED);
    const state = newState();
    const cover = { pairs: 0, oneAsciiSide: 0, fourByteShared: 0, unrelated: 0, emptySide: 0, earlyExit: 0, large: 0,
      budgets: { default: 0, zero: 0, one: 0, small: 0, random: 0, negative: 0 } };
    const make = (pieces, length) => Array.from({ length }, () => pick(pieces));
    const edit = (units, pieces) => {
      const result = [...units];
      for (let k = 0, n = 1 + int(6); k < n; k += 1) result.splice(int(result.length + 1), int(4), ...make(pieces, int(5)));
      return result;
    };
    const started = performance.now();
    while (cover.pairs < MIN_PAIRS || performance.now() - started < DURATION_MS) {
      // Mostly short pairs, so the budget runs out in every part of the recursion;
      // some longer ones; in the extended run, also pairs of up to 64 KiB.
      const roll = random();
      const length = roll < 0.85 ? int(48) : roll < 0.99 || !EXTENDED ? int(400) : 4096 + int(60_000);
      // A large pair is an edit: unrelated large texts only spend the budget.
      const shape = length >= 4096 ? 1 + int(3) : int(4);
      let aPieces = pick(ALPHABETS), bPieces = aPieces;
      // One ASCII side and one non-ASCII side: only ASCII can match.
      if (shape === 3) { aPieces = pick(ASCII); bPieces = pick(NON_ASCII); if (random() < 0.5) [aPieces, bPieces] = [bPieces, aPieces]; }
      let a = make(aPieces, length);
      // Unrelated pairs (shape 0) or an edit of the first side.
      let b = shape === 0 ? make(bPieces, int(length + 8)) : edit(a, bPieces);
      if (random() < 0.04) { if (random() < 0.5) a = []; else b = []; }
      let before = a.join(''), after = b.join('');
      // A few early exits: a NUL byte or invalid UTF-8 on one side.
      if (random() < 0.01) { if (random() < 0.5) before += '\0'; else after += '\xc3'; cover.earlyExit += 1; }
      cover.pairs += 1;
      if (length >= 4096) cover.large += 1;
      if (shape === 0) cover.unrelated += 1;
      if (!before || !after) cover.emptySide += 1;
      if (NON_ASCII_BYTE.test(before) !== NON_ASCII_BYTE.test(after)) cover.oneAsciiSide += 1;
      if (FOUR_BYTE.filter((unit) => before.includes(unit) || after.includes(unit)).length >= 2) cover.fourByteShared += 1;
      const total = before.length + after.length;
      const budgets = [['default', undefined], ['zero', 0], ['one', 1], ['small', 2 + int(30)], ['random', 1 + int(Math.min(Math.max(1, total * total / 4), 2 * MUTATION_DIFF_WORK_BUDGET))]];
      if (random() < 0.05) budgets.push(['negative', -1 - int(10)]);
      for (const [name, budget] of budgets) {
        cover.budgets[name] += 1;
        compare(state, `seed ${SEED} pair ${cover.pairs - 1} budget ${name}`, before, after, budget);
      }
    }
    const elapsedMs = Math.round(performance.now() - started);
    if (EXTENDED || state.mismatches.length) console.log(JSON.stringify({ differential: 'random', seed: SEED, elapsedMs, ...state, cover }));
    expect(state.mismatches).toEqual([]);
    expect(state.fallbacks).toBe(0);
    // Every pair past the early exits was answered by the Rust core.
    expect(state.rust + state.early).toBe(state.compared);
    expect(state.rust).toBeGreaterThan(state.compared * 0.9);
    // The generator reached every kind of input it is meant to cover.
    const { budgets, large, ...kinds } = cover;
    expect(Object.entries({ ...kinds, ...budgets }).filter(([, count]) => count === 0).map(([name]) => name)).toEqual([]);
    if (EXTENDED) expect(large).toBeGreaterThan(0);
  }, TIMEOUT_MS);

  test('budgets that run out inside the second recursive call', () => {
    // before = A1 + SEP + A2, after = B1 + SEP + B2, with SEP a run of a unit
    // neither side's halves use: the top-level split falls inside SEP, the
    // first recursive call diffs (A1, B1) and the second (A2, B2). A budget
    // that leaves the first half exactly as an unlimited diff has it, keeps
    // SEP equal, and still changes the result ran out inside the second call.
    const { int, pick } = generator(SEED ^ 0x5eed);
    const state = newState();
    const separator = 'Z'.repeat(32);
    const unlimited = { budget: Number.MAX_SAFE_INTEGER };
    let windows = 0, inWindow = 0;
    const spans = (changes) => {
      let x = 0, y = 0;
      return changes.map(({ kind, text }) => {
        const span = { kind, x, y, length: text.length };
        if (kind !== 'insert') x += text.length;
        if (kind !== 'delete') y += text.length;
        return span;
      });
    };
    const left = (changes, X, Y) => spans(changes).filter((span) => span.x + (span.kind === 'insert' ? 0 : span.length) <= X
      && span.y + (span.kind === 'delete' ? 0 : span.length) <= Y && !(span.kind === 'equal' && span.x + span.length > X));
    const sameSpans = (p, q) => p.length === q.length && p.every((span, index) => Object.entries(span).every(([key, value]) => q[index][key] === value));
    const keepsSeparator = (changes, X) => spans(changes).some((span) => span.kind === 'equal' && span.x <= X && span.x + span.length >= X + separator.length);
    const started = performance.now();
    for (let attempt = 0; attempt < 400 && performance.now() - started < Math.max(1_000, DURATION_MS / 2); attempt += 1) {
      const pieces = pick([[...'ab'], [...'ab\n'], ['a', ...FOUR_BYTE.slice(0, 3)], [...'abc']]);
      const make = (length) => Array.from({ length }, () => pick(pieces)).join('');
      const a1 = make(4 + int(8)), cut = int(a1.length + 1);
      const b1 = `${a1.slice(0, cut)}c${a1.slice(cut)}`;
      const a2 = make(30 + int(60)), b2 = make(30 + int(60));
      const before = `${a1}${separator}${a2}`, after = `${b1}${separator}${b2}`;
      const full = javascriptMutationDiff(before, after, unlimited);
      const X = a1.length, Y = b1.length;
      const fullLeft = left(full, X, Y);
      if (!keepsSeparator(full, X) || !fullLeft.some((span) => span.kind === 'insert')) continue;
      const leftDone = (budget) => { const changes = javascriptMutationDiff(before, after, { budget }); return keepsSeparator(changes, X) && sameSpans(left(changes, X, Y), fullLeft); };
      const complete = (budget) => sameResult(full, javascriptMutationDiff(before, after, { budget }));
      // Smallest budgets at which the first half is done and the whole diff is
      // done (both monotone in the budget), by doubling then bisection.
      const smallest = (predicate) => {
        let high = 1;
        while (!predicate(high)) high *= 2;
        let low = Math.floor(high / 2);
        while (low + 1 < high) { const middle = Math.floor((low + high) / 2); if (predicate(middle)) high = middle; else low = middle; }
        return high;
      };
      const leftAt = smallest(leftDone), fullAt = smallest(complete);
      if (leftAt >= fullAt) continue;
      windows += 1;
      const budgets = new Set([leftAt, leftAt + 1, fullAt - 1, fullAt, leftAt + int(fullAt - leftAt)]);
      for (const budget of budgets) {
        if (budget < fullAt && leftDone(budget) && !complete(budget)) inWindow += 1;
        compare(state, `second call ${attempt} budget ${budget}`, before, after, budget);
      }
    }
    if (EXTENDED || state.mismatches.length) console.log(JSON.stringify({ differential: 'second-call', windows, inWindow, ...state }));
    expect(state.mismatches).toEqual([]);
    expect(state.fallbacks).toBe(0);
    expect(state.rust).toBe(state.compared);
    expect(windows).toBeGreaterThan(10);
    expect(inWindow).toBeGreaterThan(10);
  }, TIMEOUT_MS);

  test('every small pair, exhaustively, and whether a split point ever overshoots', () => {
    // Every pair of strings up to a small length over a two- and a
    // three-letter alphabet (extended: R0's search, 'ab' to length 8 and 'abc'
    // to length 5), across the budgets that change small diffs. Both paths
    // must agree. An instrumented copy of the JavaScript bisect, checked
    // against javascriptMutationDiff on every input, counts split points that
    // run past the end of a text (`x > a.length` or `y > b.length`), the case
    // the Rust core clamps like JavaScript's slice.
    const state = newState();
    const counts = { pairs: 0, bisects: 0, storedPastEdge: 0, splitPastEdge: 0 };
    const strings = (alphabet, length) => {
      const out = [''];
      let layer = [''];
      for (let size = 1; size <= length; size += 1) { layer = layer.flatMap((text) => [...alphabet].map((unit) => text + unit)); out.push(...layer); }
      return out;
    };
    // javascriptMutationDiff for ASCII texts (where units are the text itself), with counters.
    const instrumented = (before, after, budget) => {
      const result = [], work = { remaining: budget };
      const push = (kind, text) => { if (!text) return; if (result.at(-1)?.kind === kind) result.at(-1).text += text; else result.push({ kind, text }); };
      const bisect = (a, b) => {
        counts.bisects += 1;
        const alphabet = new Set(a);
        if (![...new Set(b)].some((char) => alphabet.has(char))) return null;
        const max = Math.ceil((a.length + b.length) / 2), offset = max + 1;
        const forward = new Int32Array(2 * max + 3).fill(-1), reverse = new Int32Array(2 * max + 3).fill(-1);
        forward[offset + 1] = reverse[offset + 1] = 0;
        const delta = a.length - b.length, odd = delta % 2 !== 0;
        let fStart = 0, fEnd = 0, rStart = 0, rEnd = 0;
        const split = (x, y) => { if (x > a.length || y > b.length || x < 0 || y < 0) counts.splitPastEdge += 1; return [x, y]; };
        for (let d = 0; d <= max; d++) {
          for (let k = -d + fStart; k <= d - fEnd; k += 2) {
            const p = offset + k;
            let x = k === -d || (k !== d && forward[p - 1] < forward[p + 1]) ? forward[p + 1] : forward[p - 1] + 1;
            let y = x - k;
            const start = x;
            while (x < a.length && y < b.length && a[x] === b[y]) { x++; y++; }
            if ((work.remaining -= 1 + x - start) <= 0) return null;
            forward[p] = x;
            if (x > a.length || y > b.length) counts.storedPastEdge += 1;
            if (x > a.length) fEnd += 2;
            else if (y > b.length) fStart += 2;
            else if (odd) {
              const q = offset + delta - k;
              if (q >= 0 && q < reverse.length && reverse[q] !== -1 && x >= a.length - reverse[q]) return split(x, y);
            }
          }
          for (let k = -d + rStart; k <= d - rEnd; k += 2) {
            const p = offset + k;
            let x = k === -d || (k !== d && reverse[p - 1] < reverse[p + 1]) ? reverse[p + 1] : reverse[p - 1] + 1;
            let y = x - k;
            const start = x;
            while (x < a.length && y < b.length && a[a.length - x - 1] === b[b.length - y - 1]) { x++; y++; }
            if ((work.remaining -= 1 + x - start) <= 0) return null;
            reverse[p] = x;
            if (x > a.length || y > b.length) counts.storedPastEdge += 1;
            if (x > a.length) rEnd += 2;
            else if (y > b.length) rStart += 2;
            else if (!odd) {
              const q = offset + delta - k;
              if (q >= 0 && q < forward.length && forward[q] !== -1 && forward[q] >= a.length - x) return split(forward[q], forward[q] - (delta - k));
            }
          }
        }
        return null;
      };
      const walk = (a, b) => {
        if (a === b) { push('equal', a); return; }
        let prefix = 0;
        while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
        push('equal', a.slice(0, prefix)); a = a.slice(prefix); b = b.slice(prefix);
        let suffix = 0;
        while (suffix < a.length && suffix < b.length && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++;
        const tail = a.slice(a.length - suffix);
        a = a.slice(0, a.length - suffix); b = b.slice(0, b.length - suffix);
        if (!a.length) push('insert', b);
        else if (!b.length) push('delete', a);
        else {
          const split = work.remaining > 0 ? bisect(a, b) : null;
          if (!split || (split[0] === 0 && split[1] === 0) || (split[0] === a.length && split[1] === b.length)) { push('delete', a); push('insert', b); }
          else { walk(a.slice(0, split[0]), b.slice(0, split[1])); walk(a.slice(split[0]), b.slice(split[1])); }
        }
        push('equal', tail);
      };
      if (before === after) return before ? [{ kind: 'equal', text: before }] : [];
      walk(before, after);
      return result;
    };
    const budgets = [undefined, 0, 1, 2, 3, 4, 5, 6, 8, 10, 13, 17, 22, 30, 40, 60];
    const sets = EXTENDED ? [['ab', 8], ['abc', 5]] : [['ab', 4], ['abc', 3]];
    let unfaithful = 0;
    for (const [alphabet, length] of sets) {
      const all = strings(alphabet, length);
      for (const before of all) for (const after of all) {
        counts.pairs += 1;
        for (const budget of budgets) {
          const expected = compare(state, `exhaustive ${alphabet} budget ${budget}`, before, after, budget);
          if (!sameResult(expected, instrumented(before, after, budget ?? MUTATION_DIFF_WORK_BUDGET))) unfaithful += 1;
        }
      }
    }
    if (EXTENDED || state.mismatches.length || unfaithful) console.log(JSON.stringify({ differential: 'exhaustive', sets, budgets: budgets.length, ...counts, unfaithful, ...state }));
    expect(unfaithful).toBe(0);
    expect(state.mismatches).toEqual([]);
    expect(state.fallbacks).toBe(0);
    expect(state.rust + state.early).toBe(state.compared);
    expect(counts.bisects).toBeGreaterThan(0);
  }, EXTENDED ? 7_200_000 : TIMEOUT_MS);

  test('texts at and near the 8 MiB granular limit, and nothing large retained', () => {
    const state = newState();
    const line = (index) => `  const value${index % 997} = compute(${index}); // line ${index}\n`;
    let ascii = '';
    for (let index = 0; ascii.length < GRANULAR_TEXT_BYTES; index += 1) ascii += line(index);
    ascii = ascii.slice(0, GRANULAR_TEXT_BYTES);
    expect(ascii.length).toBe(GRANULAR_TEXT_BYTES);
    const at = (text, fraction, insert, remove = 0) => { const offset = text.indexOf('\n', Math.floor(text.length * fraction)) + 1; return text.slice(0, offset) + insert + text.slice(offset + remove); };
    // Exactly at the limit against one byte under it, two edits far apart.
    const nearAscii = at(at(ascii, 0.9, 'inserted one\n', 14), 0.1, '', 1);
    expect(nearAscii.length).toBe(GRANULAR_TEXT_BYTES - 2);
    compare(state, '8 MiB ASCII', ascii, nearAscii.slice(0, GRANULAR_TEXT_BYTES - 1) + '\n', MUTATION_DIFF_WORK_BUDGET);
    // Non-ASCII near the limit: four-byte code points that share leading bytes.
    const prefix = latin1('// café 😀😁 🚀\n');
    const wide = (prefix + ascii).slice(0, GRANULAR_TEXT_BYTES - 3);
    const wideAfter = at(at(wide, 0.5, latin1('  😂 é\n')), 0.95, latin1('  😁\n'));
    compare(state, '8 MiB non-ASCII', wide, wideAfter.slice(0, GRANULAR_TEXT_BYTES - 1), undefined);
    compare(state, '8 MiB against empty', '', wide, undefined);
    // A budget of 1 on the largest pair: the middle becomes one replacement.
    compare(state, '8 MiB budget 1', ascii, nearAscii, 1);
    if (EXTENDED || state.mismatches.length) console.log(JSON.stringify({ differential: 'limit', ...state }));
    expect(state.mismatches).toEqual([]);
    expect(state.fallbacks).toBe(0);
    expect(state.rust).toBe(state.compared);
    // The instance an 8 MiB call grew is dropped, never kept.
    expect(ledgerCore.inspect().memoryBytes).toBeLessThanOrEqual(LEDGER_CORE_RETAINED_MEMORY_BYTES);
  }, 300_000);
});
