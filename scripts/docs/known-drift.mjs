// Shrink-only baseline for the docs drift checks (`known-drift.json`).
//
// Each entry is `{ check, doc, token }`, without line numbers, so unrelated edits
// to a document keep it valid. Because entries carry no line number, a second
// occurrence of an already-baselined token in the same document passes by
// design. A violation missing from the baseline fails; an
// entry that no longer occurs also fails, naming the entry, until it is deleted
// (`--prune` deletes exactly those). Nothing adds entries: new drift is fixed in
// the document, never recorded.
import { readFileSync, writeFileSync } from 'node:fs';

export const DRIFT_CHECKS = ['anchor', 'bun-run', 'export', 'env'];

const keyOf = ({ check, doc, token }) => JSON.stringify([check, doc, token]);

export function compareEntries(left, right) {
  return DRIFT_CHECKS.indexOf(left.check) - DRIFT_CHECKS.indexOf(right.check)
    || (left.doc < right.doc ? -1 : left.doc > right.doc ? 1 : 0)
    || (left.token < right.token ? -1 : left.token > right.token ? 1 : 0);
}

/** Distinct entries in baseline order. */
export function normalizeEntries(entries) {
  const unique = new Map();
  for (const { check, doc, token } of entries) unique.set(keyOf({ check, doc, token }), { check, doc, token });
  return [...unique.values()].sort(compareEntries);
}

/** One entry per line, sorted, so a review diff shows exactly the entries removed. */
export function formatBaseline(entries) {
  const lines = normalizeEntries(entries).map((entry) => `  ${JSON.stringify(entry)}`);
  return lines.length ? `[\n${lines.join(',\n')}\n]\n` : '[]\n';
}

export function parseBaseline(text, source = 'known-drift.json') {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error(`${source}: expected an array of { check, doc, token }`);
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).sort().join(',') !== 'check,doc,token'
      || !DRIFT_CHECKS.includes(entry.check) || typeof entry.doc !== 'string' || typeof entry.token !== 'string') {
      throw new Error(`${source}: invalid entry ${JSON.stringify(entry)}; entries are { check: ${DRIFT_CHECKS.join('|')}, doc, token }`);
    }
  }
  return parsed;
}

/** `{ entries, canonical }`; a non-canonical file (unsorted, duplicated, reformatted) fails until `--prune` rewrites it. */
export function readBaseline(file) {
  const text = readFileSync(file, 'utf8');
  const entries = parseBaseline(text, file);
  return { entries, canonical: text === formatBaseline(entries) };
}

/**
 * Splits current violations against the baseline: `added` (fail), `stale`
 * baseline entries that no longer occur (fail until deleted), and per-check
 * counts of `known` and `added` violations.
 */
export function compareWithBaseline(violations, baseline) {
  const current = normalizeEntries(violations);
  const known = new Set(baseline.map(keyOf));
  const occurring = new Set(current.map(keyOf));
  const added = current.filter((entry) => !known.has(keyOf(entry)));
  const stale = normalizeEntries(baseline).filter((entry) => !occurring.has(keyOf(entry)));
  const counts = Object.fromEntries(DRIFT_CHECKS.map((check) => [check, { known: 0, added: 0 }]));
  for (const entry of current) counts[entry.check][known.has(keyOf(entry)) ? 'known' : 'added']++;
  return { added, stale, counts };
}

/** Removes stale entries only (and rewrites the rest in canonical form); returns the removed entries. Never adds one. */
export function pruneBaseline(file, baseline, stale) {
  const remove = new Set(stale.map(keyOf));
  const kept = baseline.filter((entry) => !remove.has(keyOf(entry)));
  writeFileSync(file, formatBaseline(kept));
  return normalizeEntries(baseline).filter((entry) => remove.has(keyOf(entry)));
}

export function describeEntry({ check, doc, token }) {
  return `[${check}] ${doc}: ${token}`;
}
