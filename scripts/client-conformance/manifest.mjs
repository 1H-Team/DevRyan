// The recording manifest of the client engine conformance harness: what a
// recording directory must hold, written by the family command (family-run.mjs
// `--out`) next to the containers it writes, and required by every reader of
// such a directory (replay.mjs `--from`, replay-product.mjs `--from`). It lists
// every family the recording was asked for (one with no container included),
// each container with its family, its SHA-256 digest, its size and its cases
// counted by outcome, and the counts per family. A container that is missing,
// one that is not listed, one whose bytes changed, a count that changed or a
// case whose outcome changed (each changes the container's digest) is a
// problem of the directory, never a smaller recording that passes.
//
//   {"format":"devryan-client-conformance-recording","version":2,"portMap":"<digest>","scope":null|[names],
//    "families":{"<family>":{"containers":["<file>",...],"cases":n,"outcomes":{"recorded":n,...}}},
//    "containers":{"<file>":{"family":"<family>","digest":"sha256:<hex>","bytes":n,"cases":n,"outcomes":{...}}},
//    "verdict":{"code":n,"failures":n,"inconclusive":n,"unstable":n}?,
//    "items":{"<family>":{"exports":[...],"ports":[...],"events":[...]}}?}
//
// Version 2 (package C0g) adds what the family command judged: `verdict`, its
// exit code and the counts behind it, and `items`, what its census judges per
// family (census.mjs censusItems), so a reader that judges an engine's
// coverage knows the items no case exercises and whether the recording passed
// its own checks. Both are written by the family command; the replayer does
// not need them, the candidate comparer requires them.
//
// It guards a directory against loss and damage (a container dropped or cut
// short, a case re-marked, a file from another recording), not against a
// writer who edits the manifest too: it is a list, not a signature.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const MANIFEST_FILE = 'recording-manifest.json';
export const MANIFEST_FORMAT = 'devryan-client-conformance-recording';
export const MANIFEST_VERSION = 2;

const digestOf = (text) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
const familyOfName = (name) => String(name).split('.').slice(-2, -1)[0] ?? '?';

/** The cases of a container counted by outcome, read from its case lines (line 3 on). */
export function countOutcomes(text) {
  const outcomes = {};
  let cases = 0;
  const lines = text.split('\n');
  for (let index = 2; index < lines.length; index += 1) {
    if (!lines[index]) continue;
    let record;
    try { record = JSON.parse(lines[index]).case; } catch { record = null; }
    const outcome = record && typeof record.outcome === 'string' ? record.outcome : '(unreadable)';
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    cases += 1;
  }
  return { cases, outcomes };
}

/** The manifest of `containers` (`[{ name, text }]`, as written), for the families asked for, with the family command's `verdict` and census `items` when given. */
export function buildManifest(containers, { portMap, families, scope = null, verdict = null, items = null }) {
  const manifest = { format: MANIFEST_FORMAT, version: MANIFEST_VERSION, portMap, scope, families: {}, containers: {} };
  if (verdict) manifest.verdict = { code: verdict.code, failures: verdict.failures, inconclusive: verdict.inconclusive, unstable: verdict.unstable };
  if (items) manifest.items = items;
  for (const name of families) manifest.families[name] = { containers: [], cases: 0, outcomes: {} };
  for (const { name, text } of [...containers].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const family = familyOfName(name);
    const { cases, outcomes } = countOutcomes(text);
    manifest.containers[name] = { family, digest: digestOf(text), bytes: Buffer.byteLength(text), cases, outcomes };
    const row = (manifest.families[family] ??= { containers: [], cases: 0, outcomes: {} });
    row.containers.push(name);
    row.cases += cases;
    for (const [outcome, count] of Object.entries(outcomes)) row.outcomes[outcome] = (row.outcomes[outcome] ?? 0) + count;
  }
  return manifest;
}

/** Writes the manifest of `containers` into `directory`. */
export function writeManifest(directory, containers, options) {
  writeFileSync(path.join(directory, MANIFEST_FILE), `${JSON.stringify(buildManifest(containers, options), null, 2)}\n`);
}

/**
 * Checks `list` (`[{ name, text }]`, the containers of a directory) against the
 * manifest text (null when the directory has none). Returns `{ problems,
 * manifest }`: each problem `{ check: 'manifest', container?, detail }`.
 */
export function checkManifest(manifestText, list, { portMap = null } = {}) {
  const problems = [];
  const fail = (detail, container) => problems.push({ check: 'manifest', ...(container ? { container } : {}), detail });
  if (manifestText === null) { fail(`the directory has no ${MANIFEST_FILE}: which containers a recording holds is unknown, so a missing one could not be seen`); return { problems, manifest: null }; }
  let manifest;
  try { manifest = JSON.parse(manifestText); } catch (error) { fail(`${MANIFEST_FILE} is no JSON: ${error.message}`); return { problems, manifest: null }; }
  if (manifest?.format !== MANIFEST_FORMAT || manifest.version !== MANIFEST_VERSION || typeof manifest.containers !== 'object' || typeof manifest.families !== 'object') {
    fail(`${MANIFEST_FILE} is not a ${MANIFEST_FORMAT}@${MANIFEST_VERSION} manifest`);
    return { problems, manifest: null };
  }
  if (manifest.verdict !== undefined && (manifest.verdict === null || typeof manifest.verdict !== 'object' || !Number.isInteger(manifest.verdict.code))) fail(`${MANIFEST_FILE}: its verdict has no exit code`);
  if (manifest.items !== undefined && (manifest.items === null || typeof manifest.items !== 'object' || Array.isArray(manifest.items))) fail(`${MANIFEST_FILE}: its items are not an object of families`);
  if (portMap !== null && manifest.portMap !== portMap) fail(`recorded with port map ${manifest.portMap}, read with ${portMap}`);
  const present = new Map(list.map((item) => [item.name, item.text]));
  for (const [name, entry] of Object.entries(manifest.containers)) {
    const text = present.get(name);
    if (text === undefined) { fail(`${name} (family ${entry.family}, ${entry.cases} cases) is listed but missing`, name); continue; }
    if (digestOf(text) !== entry.digest) {
      const now = countOutcomes(text);
      const counts = JSON.stringify(now.outcomes) === JSON.stringify(entry.outcomes) ? 'its counts by outcome are as listed' : `its cases by outcome are ${JSON.stringify(now.outcomes)}, listed ${JSON.stringify(entry.outcomes)}`;
      fail(`${name} is not the container recorded (its digest differs; ${counts})`, name);
    }
  }
  for (const name of present.keys()) if (!Object.hasOwn(manifest.containers, name)) fail(`${name} is not in the recording's manifest`, name);
  for (const [family, row] of Object.entries(manifest.families)) {
    const listed = Object.entries(manifest.containers).filter(([, entry]) => entry.family === family).map(([name]) => name).sort();
    if (JSON.stringify(listed) !== JSON.stringify([...(row.containers ?? [])].sort())) fail(`family ${family}: the manifest's own lists disagree`);
  }
  return { problems, manifest };
}

/** The manifest text of `directory`, or null when it has none. */
export const readManifestText = (directory) => (existsSync(path.join(directory, MANIFEST_FILE)) ? readFileSync(path.join(directory, MANIFEST_FILE), 'utf8') : null);

/** The families of a manifest that hold a recorded case (each must have a judged case). */
export const recordedFamilies = (manifest) => Object.entries(manifest?.families ?? {}).filter(([, row]) => (row.outcomes?.recorded ?? 0) > 0).map(([name]) => name).sort();
