// Central, ordered selective undo. Positions refer to immutable runs in the
// execution's base revision, never to a text search in today's working file.
// Strings here are byte strings (latin1); storage and filesystem boundaries use
// Buffers, so invalid UTF-8 and newline conventions round-trip without loss.
import { isUtf8 } from 'node:buffer';

// Keep UTF-8 code points indivisible when assigning replacement ownership.
// Byte-level matching could otherwise combine a restored leading byte with a
// surviving contributor's continuation byte, producing a different character.
const units = (text) => {
  if (!/[\x80-\xff]/.test(text) || !isUtf8(Buffer.from(text, 'latin1'))) return text;
  const result = [];
  for (let offset = 0; offset < text.length;) {
    const first = text.charCodeAt(offset);
    const size = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
    result.push(text.slice(offset, offset + size)); offset += size;
  }
  return result;
};

// A diff runs synchronously on the host event loop (in Electron, the window's
// main thread). Myers is O((N+M)·D): two unrelated 16 KiB texts took seconds.
// Past this many diagonal/snake steps the remaining ranges become one
// replacement each. The text stays exact; only ownership gets coarser.
export const MUTATION_DIFF_WORK_BUDGET = 4_000_000;

/** Myers' bisect diff uses linear auxiliary space, including for large rewrites. */
export function mutationDiff(before, after, { budget = MUTATION_DIFF_WORK_BUDGET } = {}) {
  if (before === after) return before ? [{ kind: 'equal', text: before }] : [];
  if ([before, after].some((text) => text.includes('\0') || !isUtf8(Buffer.from(text, 'latin1')))) {
    return [...(before ? [{ kind: 'delete', text: before }] : []), ...(after ? [{ kind: 'insert', text: after }] : [])];
  }
  const result = [], work = { remaining: budget };
  const push = (kind, value) => {
    const text = typeof value === 'string' ? value : value.join('');
    if (!text) return;
    if (result.at(-1)?.kind === kind) result.at(-1).text += text;
    else result.push({ kind, text });
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
      const split = work.remaining > 0 ? bisect(a, b, work) : null;
      if (!split || (split[0] === 0 && split[1] === 0) || (split[0] === a.length && split[1] === b.length)) {
        push('delete', a); push('insert', b);
      } else {
        walk(a.slice(0, split[0]), b.slice(0, split[1]));
        walk(a.slice(split[0]), b.slice(split[1]));
      }
    }
    push('equal', tail);
  };
  walk(units(before), units(after));
  return result;
}

function bisect(a, b, work) {
  // Disjoint alphabets are common for generated/binary replacements. Avoid a
  // quadratic search when there cannot be an equal run.
  const alphabet = new Set(a);
  if (![...new Set(b)].some((char) => alphabet.has(char))) return null;
  const max = Math.ceil((a.length + b.length) / 2), offset = max + 1;
  const forward = new Int32Array(2 * max + 3).fill(-1);
  const reverse = new Int32Array(2 * max + 3).fill(-1);
  forward[offset + 1] = reverse[offset + 1] = 0;
  const delta = a.length - b.length, odd = delta % 2 !== 0;
  let fStart = 0, fEnd = 0, rStart = 0, rEnd = 0;
  for (let d = 0; d <= max; d++) {
    for (let k = -d + fStart; k <= d - fEnd; k += 2) {
      const p = offset + k;
      let x = k === -d || (k !== d && forward[p - 1] < forward[p + 1]) ? forward[p + 1] : forward[p - 1] + 1;
      let y = x - k;
      const start = x;
      while (x < a.length && y < b.length && a[x] === b[y]) { x++; y++; }
      if ((work.remaining -= 1 + x - start) <= 0) return null;
      forward[p] = x;
      if (x > a.length) fEnd += 2;
      else if (y > b.length) fStart += 2;
      else if (odd) {
        const q = offset + delta - k;
        if (q >= 0 && q < reverse.length && reverse[q] !== -1 && x >= a.length - reverse[q]) return [x, y];
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
      if (x > a.length) rEnd += 2;
      else if (y > b.length) rStart += 2;
      else if (!odd) {
        const q = offset + delta - k;
        if (q >= 0 && q < forward.length && forward[q] !== -1 && forward[q] >= a.length - x) return [forward[q], forward[q] - (delta - k)];
      }
    }
  }
  return null;
}

const enabled = (id, inactive) => id === null || !inactive.has(id);
export const visibleMutationRuns = (runs, inactive = new Set()) => runs.filter((run) =>
  enabled(run.owner, inactive) && !run.deletedBy.some((id) => enabled(id, inactive)));
export const mutationText = (runs, inactive = new Set()) => visibleMutationRuns(runs, inactive).map((run) => run.text).join('');
export const initialMutationRuns = (text, id) => text ? [{ id, start: 0, text, owner: null, deletedBy: [], replaces: [] }] : [];

// Runs sharing an id partition that id's text, so (id, offset) names one run.
const indexRuns = (runs) => {
  const byId = new Map();
  for (const run of runs) { const list = byId.get(run.id); if (list) list.push(run); else byId.set(run.id, [run]); }
  return byId;
};

function splitAt(runs, byId, id, offset) {
  const list = byId.get(id) ?? [];
  const k = list.findIndex((run) => offset > run.start && offset < run.start + run.text.length);
  if (k < 0) return;
  const run = list[k], cut = offset - run.start;
  const left = { ...run, text: run.text.slice(0, cut), deletedBy: [...run.deletedBy] };
  const right = { ...run, start: offset, text: run.text.slice(cut), deletedBy: [...run.deletedBy] };
  runs.splice(runs.indexOf(run), 1, left, right);
  list.splice(k, 1, left, right);
}

function baseRange(base, start, length) {
  const ranges = [];
  let position = 0;
  for (const run of base) {
    const low = Math.max(start, position), high = Math.min(start + length, position + run.text.length);
    if (low < high) ranges.push({ id: run.id, start: run.start + low - position, length: high - low });
    position += run.text.length;
  }
  return ranges;
}

function anchorAt(base, offset) {
  let position = 0, left = null;
  for (const run of base) {
    if (offset < position + run.text.length) {
      if (offset > position) left = { id: run.id, offset: run.start + offset - position };
      return { left, right: { id: run.id, offset: run.start + offset - position } };
    }
    position += run.text.length;
    left = { id: run.id, offset: run.start + run.text.length };
  }
  return { left, right: null };
}

const inRange = (run, range) => run.id === range.id && run.start >= range.start && run.start < range.start + range.length;

// Runs keep only the ranges they replaced directly; ancestry is the closure
// through those ranges' runs, derived when needed instead of copied per run.
function replacedClosure(byId, owner) {
  const ranges = [], seen = new Set();
  const add = (range) => {
    const key = `${range.id}:${range.start}:${range.length}`;
    if (seen.has(key)) return;
    seen.add(key); ranges.push(range);
    for (const run of byId.get(range.id) ?? []) if (inRange(run, range)) for (const ancestor of run.replaces) add(ancestor);
  };
  for (const range of owner.replaces) add(range);
  return ranges;
}

function pastReplaced(runs, byId, at) {
  const ranges = replacedClosure(byId, runs[at - 1]);
  while (at < runs.length && ranges.some((range) => inRange(runs[at], range))) at++;
  return at;
}

/** Record changes from a private base, including when that base has since been
 * reverted. Tombstones remain addressable while any execution or undo record
 * references them. A replacement run stores only the ranges its hunk replaced
 * directly; `visit` follows that ancestry through older runs (marking every
 * ancestor deleted by the operation), and `pastReplaced` derives the closure
 * when it needs it. Storing the closure on every run grew quadratically: two
 * often-rewritten files held 120-154 MB of run pages in one ledger. */
// Each hunk scans the run list (split, anchor, ownership). Past this many
// hunk × run steps, every hunk merges into one replacement spanning the first
// to the last change: the same text, with coarser ownership.
export const MUTATION_HUNK_WORK_BUDGET = 2_000_000;
const coalesceChanges = (changes) => {
  const first = changes.findIndex((change) => change.kind !== 'equal');
  const last = changes.findLastIndex((change) => change.kind !== 'equal');
  if (first < 0) return changes;
  const span = changes.slice(first, last + 1);
  const removed = span.filter((change) => change.kind !== 'insert').map((change) => change.text).join('');
  const inserted = span.filter((change) => change.kind !== 'delete').map((change) => change.text).join('');
  return [...changes.slice(0, first), ...(removed ? [{ kind: 'delete', text: removed }] : []),
    ...(inserted ? [{ kind: 'insert', text: inserted }] : []), ...changes.slice(last + 1)];
};

// `onHunk` (tests) observes the runs and their id index after each hunk.
export function applyMutationText(runs, base, after, operationID, { hunkBudget = MUTATION_HUNK_WORK_BUDGET, onHunk } = {}) {
  const result = runs.map((run) => ({ ...run, deletedBy: [...run.deletedBy] }));
  const byId = indexRuns(result);
  let changes = mutationDiff(base.map((run) => run.text).join(''), after);
  const hunks = changes.reduce((count, change, index) => count + (change.kind !== 'equal' && changes[index - 1]?.kind !== 'delete'
    && changes[index - 1]?.kind !== 'insert' ? 1 : 0), 0);
  if (hunks > 1 && hunks * (result.length + base.length) > hunkBudget) changes = coalesceChanges(changes);
  let offset = 0, index = 0;
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    if (change.kind === 'equal') { offset += change.text.length; continue; }
    let removed = '', inserted = '';
    while (i < changes.length && changes[i].kind !== 'equal') {
      if (changes[i].kind === 'delete') removed += changes[i].text;
      else inserted += changes[i].text;
      i++;
    }
    i--;
    const anchor = anchorAt(base, offset);
    const ranges = baseRange(base, offset, removed.length);
    const covered = new Map();
    const visit = (range) => {
      const key = `${range.id}:${range.start}:${range.length}`;
      if (covered.has(key)) return;
      covered.set(key, range);
      splitAt(result, byId, range.id, range.start); splitAt(result, byId, range.id, range.start + range.length);
      // Ancestry only names strictly older ids, so recursion never edits this list.
      const list = byId.get(range.id) ?? [];
      for (let j = 0; j < list.length; j++) {
        const run = list[j];
        if (run.start < range.start || run.start >= range.start + range.length) continue;
        if (!run.deletedBy.includes(operationID)) run.deletedBy.push(operationID);
        // A later replacement must keep suppressing the replaced value when an
        // earlier replacement is undone. It is not a new insertion beside it.
        for (const ancestor of run.replaces) visit(ancestor);
      }
    };
    for (const range of ranges) visit(range);
    const direct = [...new Map(ranges.map((range) => [`${range.id}:${range.start}:${range.length}`, range])).values()];
    if (inserted) {
      if (anchor.left) splitAt(result, byId, anchor.left.id, anchor.left.offset);
      if (anchor.right) splitAt(result, byId, anchor.right.id, anchor.right.offset);
      const boundary = !removed && anchor.left && (!anchor.right || anchor.left.id !== anchor.right.id
        || anchor.left.offset !== anchor.right.offset);
      const position = (id, match) => { const run = (byId.get(id) ?? []).find(match); return run ? result.indexOf(run) : -1; };
      let at = !boundary && anchor.right ? position(anchor.right.id, (run) => run.start === anchor.right.offset) : -1;
      if (at < 0 && anchor.left) {
        const left = position(anchor.left.id, (run) => run.start + run.text.length === anchor.left.offset);
        if (left >= 0) at = boundary ? pastReplaced(result, byId, left + 1) : left + 1;
      }
      if (at < 0) at = result.length;
      const created = { id: `${operationID}:${index++}`, start: 0, text: inserted,
        owner: operationID, deletedBy: [], replaces: direct };
      result.splice(at, 0, created);
      byId.set(created.id, [created]);
    }
    offset += removed.length;
    onHunk?.(result, byId);
  }
  return result;
}

// Stored run rows. A run's first 32 KiB chunk carries its metadata; further
// chunks carry only text (`continues`). Format 1 rows repeated the metadata,
// `replaces` included, on every chunk. Decoding yields the same runs either way:
// one run per chunk, each chunk starting where the previous one ends.
export const MUTATION_RUN_CHUNK = 32_768;

export function encodeMutationRunRows(runs) {
  const rows = [];
  for (const run of runs) {
    const { text, ...metadata } = run;
    for (let offset = 0; offset < text.length; offset += MUTATION_RUN_CHUNK) {
      const bytes = Buffer.from(text.slice(offset, offset + MUTATION_RUN_CHUNK), 'latin1').toString('base64');
      rows.push(offset === 0 ? { ...metadata, bytes } : { continues: true, bytes });
    }
  }
  return rows;
}

export function decodeMutationRunRows(rows) {
  const runs = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row) || typeof row.bytes !== 'string') {
      throw new TypeError('invalid mutation run row');
    }
    const text = Buffer.from(row.bytes, 'base64').toString('latin1');
    if (row.continues === true) {
      const previous = runs.at(-1);
      if (!previous || Object.keys(row).length !== 2) throw new TypeError('invalid mutation run row');
      runs.push({ ...previous, start: previous.start + previous.text.length, text, deletedBy: [...previous.deletedBy] });
      continue;
    }
    const { bytes: _bytes, ...metadata } = row;
    if (typeof metadata.id !== 'string' || !Number.isSafeInteger(metadata.start) || !Array.isArray(metadata.deletedBy)
      || !Array.isArray(metadata.replaces)) throw new TypeError('invalid mutation run row');
    runs.push({ ...metadata, text });
  }
  return runs;
}

// Compaction of runs written before direct ancestry, which stored the closure
// of every replaced range. A list keeps a range only when its kept ranges do
// not already reach it in one step (their own units and the lists of the runs
// starting inside them). Ranges are examined in decreasing ancestry height, so
// a listed range is examined after every listed range that can reach it, and a
// stored closure keeps about its hunk's direct ranges. A dropped range lies in
// the closure of the kept ones, so the list's closure is unchanged; with
// acyclic ancestry (checked) that holds for every run by induction on height.
// Each reduction is re-checked in one batch, apart from the incremental pass.
// Projected text is no evidence: `mutationText` never reads `replaces`.
// The work yields every `sliceMs`, so a shared event loop is never held long.
const validRange = (range) => range !== null && typeof range === 'object' && typeof range.id === 'string'
  && Number.isSafeInteger(range.start) && range.start >= 0 && Number.isSafeInteger(range.length) && range.length >= 0;
const sameRanges = (left, right) => left === right || (left.length === right.length && left.every((range, index) =>
  range.id === right[index].id && range.start === right[index].start && range.length === right[index].length));

// Sorted, merged [start, end) intervals per id.
const addInterval = (intervals, id, start, end) => {
  if (end <= start) return;
  const list = intervals.get(id);
  if (!list) { intervals.set(id, [[start, end]]); return; }
  let low = 0;
  while (low < list.length && list[low][1] < start) low++;
  let high = low;
  for (; high < list.length && list[high][0] <= end; high++) { start = Math.min(start, list[high][0]); end = Math.max(end, list[high][1]); }
  list.splice(low, high - low, [start, end]);
};
const containsInterval = (intervals, id, start, end) => {
  const list = intervals.get(id) ?? [];
  let low = 0, high = list.length;
  while (low < high) { const middle = (low + high) >> 1; if (list[middle][0] <= start) low = middle + 1; else high = middle; }
  return low > 0 && list[low - 1][1] >= end;
};

export async function minimizeMutationAncestry(runs, { yieldNow = () => new Promise((resolve) => setImmediate(resolve)), sliceMs = 25 } = {}) {
  // `due` counts work without allocating; `pause` yields once a slice is spent.
  let sliceStarted = performance.now(), work = 0;
  const due = (units = 1) => (work += units) >= 256;
  const pause = async () => {
    work = 0;
    if (performance.now() - sliceStarted < sliceMs) return;
    await yieldNow(); sliceStarted = performance.now();
  };
  // Format 1 rows repeat a run's list on every chunk: one array per distinct list.
  const lists = new Map(), canonical = new Map(), pieces = new Map();
  let before = 0;
  for (const run of runs) {
    if (!run.replaces.every(validRange)) throw new Error('mutation_ancestry_invalid');
    before += run.replaces.length;
    const known = lists.get(run.id) ?? [];
    let list = known.find((candidate) => sameRanges(candidate, run.replaces));
    if (!list) { list = run.replaces; known.push(list); lists.set(run.id, known); }
    canonical.set(run, list);
    const same = pieces.get(run.id);
    if (same) same.push(run); else pieces.set(run.id, [run]);
    if (due(1 + run.replaces.length)) await pause();
  }
  for (const same of pieces.values()) same.sort((left, right) => left.start - right.start);
  // Runs starting inside `range`, as `inRange` selects them.
  const starting = (range) => {
    const same = pieces.get(range.id) ?? [];
    let low = 0, high = same.length;
    while (low < high) { const middle = (low + high) >> 1; if (same[middle].start < range.start) low = middle + 1; else high = middle; }
    const result = [];
    for (let index = low; index < same.length && same[index].start < range.start + range.length; index++) result.push(same[index]);
    return result;
  };
  // One step of reach: the range itself and every ancestor its runs list.
  const reach = function* (range) {
    yield range;
    const seen = new Set();
    for (const run of starting(range)) {
      const list = canonical.get(run);
      if (seen.has(list)) continue;
      seen.add(list);
      yield* list;
    }
  };
  // Height: 0 without ancestry, else one above the highest id it lists.
  const heights = new Map();
  const children = (id) => [...new Set((lists.get(id) ?? []).flatMap((list) => list.map((range) => range.id)))];
  for (const id of lists.keys()) {
    if (heights.has(id)) continue;
    const stack = [{ id, children: children(id), next: 0, height: 0 }], active = new Set([id]);
    while (stack.length) {
      const frame = stack.at(-1);
      if (frame.next < frame.children.length) {
        const child = frame.children[frame.next++];
        if (due()) await pause();
        if (heights.has(child)) { frame.height = Math.max(frame.height, heights.get(child) + 1); continue; }
        if (active.has(child)) throw new Error('mutation_ancestry_cycle');
        active.add(child);
        stack.push({ id: child, children: children(child), next: 0, height: 0 });
        continue;
      }
      heights.set(frame.id, frame.height); active.delete(frame.id); stack.pop();
      if (stack.length) stack.at(-1).height = Math.max(stack.at(-1).height, frame.height + 1);
    }
  }
  const reductions = new Map();
  for (const known of lists.values()) {
    for (const list of known) {
      const order = list.map((range, index) => ({ range, index, height: heights.get(range.id) ?? 0 }))
        .sort((left, right) => right.height - left.height || right.range.length - left.range.length || left.index - right.index);
      const covered = new Map(), kept = [];
      for (const entry of order) {
        if (due()) await pause();
        const { range } = entry;
        if (!range.length || containsInterval(covered, range.id, range.start, range.start + range.length)) continue;
        kept.push(entry);
        for (const reached of reach(range)) {
          addInterval(covered, reached.id, reached.start, reached.start + reached.length);
          if (due()) await pause();
        }
      }
      const check = new Map();
      for (const { range } of kept) for (const reached of reach(range)) {
        if (due()) await pause();
        if (!reached.length) continue;
        const intervals = check.get(reached.id);
        if (intervals) intervals.push([reached.start, reached.start + reached.length]);
        else check.set(reached.id, [[reached.start, reached.start + reached.length]]);
      }
      for (const intervals of check.values()) {
        intervals.sort((left, right) => left[0] - right[0]);
        let write = 0;
        for (const interval of intervals) {
          if (write && interval[0] <= intervals[write - 1][1]) intervals[write - 1][1] = Math.max(intervals[write - 1][1], interval[1]);
          else intervals[write++] = interval;
        }
        intervals.length = write;
      }
      for (const range of list) {
        if (due()) await pause();
        if (range.length && !containsInterval(check, range.id, range.start, range.start + range.length)) {
          throw new Error('mutation_ancestry_verification_failed');
        }
      }
      reductions.set(list, kept.length === list.length ? list : kept.sort((left, right) => left.index - right.index).map(({ range }) => range));
    }
  }
  let after = 0;
  const result = runs.map((run) => {
    const replaces = reductions.get(canonical.get(run));
    after += replaces.length;
    return replaces.length === run.replaces.length ? run : { ...run, replaces };
  });
  return { runs: result, before, after, changed: after < before };
}
