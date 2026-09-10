// Central, ordered selective undo. Positions refer to immutable runs in the
// execution's base revision, never to a text search in today's working file.
// Strings here are byte strings (latin1); storage and filesystem boundaries use
// Buffers, so invalid UTF-8 and newline conventions round-trip without loss.

/** Myers' bisect diff uses linear auxiliary space, including for large rewrites. */
export function mutationDiff(before, after) {
  const result = [];
  const push = (kind, text) => {
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
    if (!a) push('insert', b);
    else if (!b) push('delete', a);
    else {
      const split = bisect(a, b);
      if (!split || (split[0] === 0 && split[1] === 0) || (split[0] === a.length && split[1] === b.length)) {
        push('delete', a); push('insert', b);
      } else {
        walk(a.slice(0, split[0]), b.slice(0, split[1]));
        walk(a.slice(split[0]), b.slice(split[1]));
      }
    }
    push('equal', tail);
  };
  walk(before, after);
  return result;
}

function bisect(a, b) {
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
      while (x < a.length && y < b.length && a[x] === b[y]) { x++; y++; }
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
      while (x < a.length && y < b.length && a[a.length - x - 1] === b[b.length - y - 1]) { x++; y++; }
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

function splitAt(runs, id, offset) {
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (run.id !== id || offset <= run.start || offset >= run.start + run.text.length) continue;
    const cut = offset - run.start;
    runs.splice(i, 1, { ...run, text: run.text.slice(0, cut), deletedBy: [...run.deletedBy] },
      { ...run, start: offset, text: run.text.slice(cut), deletedBy: [...run.deletedBy] });
    return;
  }
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
    if (offset <= position + run.text.length) {
      if (offset > position) left = { id: run.id, offset: run.start + offset - position };
      return { left, right: { id: run.id, offset: run.start + offset - position } };
    }
    position += run.text.length;
    left = { id: run.id, offset: run.start + run.text.length };
  }
  return { left, right: null };
}

/** Record changes from a private base, including when that base has since been
 * reverted. Tombstones and replacement ancestry remain addressable forever
 * while any execution or undo record references them. */
export function applyMutationText(runs, base, after, operationID) {
  const result = runs.map((run) => ({ ...run, deletedBy: [...run.deletedBy] }));
  const changes = mutationDiff(base.map((run) => run.text).join(''), after);
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
      splitAt(result, range.id, range.start); splitAt(result, range.id, range.start + range.length);
      for (const run of result) {
        if (run.id !== range.id || run.start < range.start || run.start >= range.start + range.length) continue;
        if (!run.deletedBy.includes(operationID)) run.deletedBy.push(operationID);
        // A later replacement must keep suppressing the replaced value when an
        // earlier replacement is undone. It is not a new insertion beside it.
        for (const ancestor of run.replaces) visit(ancestor);
      }
    };
    for (const range of ranges) visit(range);
    if (inserted) {
      if (anchor.left) splitAt(result, anchor.left.id, anchor.left.offset);
      if (anchor.right) splitAt(result, anchor.right.id, anchor.right.offset);
      let at = anchor.right ? result.findIndex((run) => run.id === anchor.right.id && run.start === anchor.right.offset) : -1;
      if (at < 0 && anchor.left) {
        const left = result.findIndex((run) => run.id === anchor.left.id && run.start + run.text.length === anchor.left.offset);
        if (left >= 0) at = left + 1;
      }
      if (at < 0) at = result.length;
      result.splice(at, 0, { id: `${operationID}:${index++}`, start: 0, text: inserted,
        owner: operationID, deletedBy: [], replaces: [...covered.values()] });
    }
    offset += removed.length;
  }
  return result;
}
