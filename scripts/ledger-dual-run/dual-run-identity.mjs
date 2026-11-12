// Identifiers a ledger chooses at random (randomUUID: lease tokens, view and
// standby directories, record, operation, transaction and removal IDs), as a
// one-to-one map from run A's values to run B's.
//
// A pair is learned only where the two runs put an identifier at the same
// place: the same position of a call result, the same JSON path of two
// records aligned by key, the same entry of two aligned trees. Derived forms
// are learned with it: the identifier without dashes, and its SHA-256 hex
// (`changeKey(id)` names records `leases/<sha256(token)>.json`). A value that
// would map to two partners is a conflict, reported as a difference, so a
// real difference cannot hide behind an earlier guess.
import { createHash } from 'node:crypto';

export const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// A wall-clock time a ledger returned (13 digits of milliseconds) and a hex
// digest (a proof): values a later input may pass back as returned.
const OPAQUE_TIME = (value) => Number.isSafeInteger(value) && value >= 1e12 && value < 1e13;
const OPAQUE_DIGEST = /^[0-9a-f]{40,64}$/;
const PROOF_DIGEST = { test: (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) };

/**
 * `opaque: true` builds the map a replay uses for inputs only: besides
 * identifiers it pairs times and digests found at the same place of two
 * results (`alignOpaque`), so a later input that passes one back passes run
 * B's own. Never used to excuse a difference.
 */
export function createIdentityMap({ opaque = false } = {}) {
  const forward = new Map(), backward = new Map();
  const scalars = new Map();
  const conflicts = [];
  const pairs = [];
  const pattern = () => {
    const keys = [...forward.keys()].sort((x, y) => y.length - x.length).map((key) => key.replace(/[-]/g, '\\-'));
    return keys.length ? new RegExp(keys.join('|'), 'g') : null;
  };
  let compiled = null;
  const set = (a, b, where) => {
    if (forward.get(a) === b) return true;
    if (forward.has(a) || backward.has(b)) { conflicts.push({ a, b, where, had: forward.get(a) ?? null, hadBack: backward.get(b) ?? null }); return false; }
    forward.set(a, b); backward.set(b, a); compiled = null;
    return true;
  };
  const learn = (a, b, where = '') => {
    if (a === b) { if (!forward.has(a) && !backward.has(a)) { forward.set(a, a); backward.set(a, a); compiled = null; } return true; }
    if (!set(a, b, where)) return false;
    pairs.push({ a, b, where });
    set(a.replaceAll('-', ''), b.replaceAll('-', ''), `${where} (undashed)`);
    set(sha256(a), sha256(b), `${where} (sha256)`);
    return true;
  };
  const substituteText = (text) => {
    if (typeof text !== 'string' || !forward.size) return text;
    compiled ??= pattern();
    return compiled ? text.replace(compiled, (match) => forward.get(match) ?? match) : text;
  };
  const substitute = (value) => {
    if (opaque && scalars.has(value)) return scalars.get(value);
    if (typeof value === 'string') return substituteText(value);
    if (Array.isArray(value)) return value.map(substitute);
    if (value && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [substituteText(key), substitute(entry)]));
    }
    return value;
  };
  /** Learns pairs from two strings: their identifiers in order, when both hold the same number. */
  const alignText = (a, b, where) => {
    if (typeof a !== 'string' || typeof b !== 'string' || a === b) return;
    const left = a.match(UUID) ?? [], right = b.match(UUID) ?? [];
    if (left.length && left.length === right.length) left.forEach((value, index) => learn(value, right[index], where));
  };
  /** Learns pairs from two values of the same shape. */
  const align = (a, b, where = '$') => {
    if (typeof a === 'string') { alignText(a, b, where); return; }
    if (Array.isArray(a) && Array.isArray(b)) { a.forEach((item, index) => align(item, b[index], `${where}[${index}]`)); return; }
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Buffer.isBuffer(a)) {
      const keysA = Object.keys(a), keysB = Object.keys(b);
      // Keys that are identifiers align by position.
      keysA.forEach((key, index) => alignText(key, keysB[index], `${where}{key ${index}}`));
      for (const key of keysA) {
        const partner = forward.has(key) ? forward.get(key) : substituteText(key);
        if (!Object.hasOwn(b, partner)) continue;
        // A proof digest is computed over tree IDs of records that hold file
        // stamps (inode, ctime), so it differs in every run: paired one to one
        // like an identifier, so it must recur wherever run A repeats it.
        if (key === 'digest' && PROOF_DIGEST.test(a[key]) && PROOF_DIGEST.test(b[partner])) { learn(a[key], b[partner], `${where}.digest`); continue; }
        align(a[key], b[partner], `${where}.${key}`);
      }
    }
  };
  /** Pairs times and digests at the same place of two values (opaque maps only). */
  const alignOpaque = (a, b) => {
    if (!opaque) return;
    if ((OPAQUE_TIME(a) && OPAQUE_TIME(b)) || (typeof a === 'string' && typeof b === 'string' && OPAQUE_DIGEST.test(a) && OPAQUE_DIGEST.test(b))) {
      if (a !== b && !scalars.has(a)) scalars.set(a, b);
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) { a.forEach((item, index) => alignOpaque(item, b[index])); return; }
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Buffer.isBuffer(a)) for (const key of Object.keys(a)) if (Object.hasOwn(b, key)) alignOpaque(a[key], b[key]);
  };
  return { learn, align, alignText, alignOpaque, substitute, substituteText, conflicts, pairs, has: (a) => forward.has(a), get: (a) => forward.get(a), get size() { return forward.size; } };
}
