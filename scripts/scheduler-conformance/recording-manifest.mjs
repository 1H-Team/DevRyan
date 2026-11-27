// The recording manifest of the scheduler conformance harness (design file
// 30 §4.6, package O0e fix round 1): what a source's container directory
// must hold, written by the closure check next to the containers it records
// and required by the census of the whole corpus. It lists each container
// with its test file, its SHA-256 digest, its size and its cases counted by
// outcome. A container that is missing or not listed, or whose bytes changed
// (a case dropped, the file cut short, a case re-marked), is a problem of the
// directory, never a smaller corpus that passes. It guards against loss and
// damage, not against a writer who edits the manifest too: it is a list, not
// a signature. The client harness keeps a manifest of the same kind.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const MANIFEST_FILE = 'recording-manifest.json';
export const MANIFEST_FORMAT = 'devryan-scheduler-conformance-recording';
export const MANIFEST_VERSION = 1;
const digestOf = (text) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

/** A container's test file and cases by outcome, read from its lines (no parse of its values). */
function containerSummary(text) {
  const lines = text.split('\n').filter(Boolean);
  let testFile = null;
  try { testFile = JSON.parse(lines[0]).testFile ?? null; } catch { /* unreadable: no test file */ }
  const outcomes = {};
  let cases = 0;
  for (const line of lines.slice(2)) {
    let record = null;
    try { record = JSON.parse(line).case ?? null; } catch { record = null; }
    if (!record) continue;
    outcomes[record.outcome] = (outcomes[record.outcome] ?? 0) + 1;
    cases += 1;
  }
  return { testFile, cases, outcomes };
}

/**
 * The manifest of one source's containers (`[{ name, text }]`, as written at
 * record time): each container's test file, digest, size and cases by
 * outcome. It guards a directory against loss and damage (a container dropped,
 * added or cut short, a case dropped or re-marked: each changes a digest or
 * the list), not against a writer who edits the manifest too.
 */
export function buildManifest(source, containers) {
  const manifest = { format: MANIFEST_FORMAT, version: MANIFEST_VERSION, source, containers: {} };
  for (const { name, text } of [...containers].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) manifest.containers[name] = { ...containerSummary(text), digest: digestOf(text), bytes: Buffer.byteLength(text) };
  return manifest;
}

/** Writes the manifest of a source's container files into `directory`. */
export const writeManifest = (directory, source, files) => writeFileSync(path.join(directory, MANIFEST_FILE), `${JSON.stringify(buildManifest(source, files.map((file) => ({ name: path.basename(file), text: readFileSync(file, 'utf8') }))), null, 2)}\n`);
/** The manifest text of `directory`, or null when it has none. */
export const readManifestText = (directory) => (existsSync(path.join(directory, MANIFEST_FILE)) ? readFileSync(path.join(directory, MANIFEST_FILE), 'utf8') : null);

/** Checks a source's containers (`[{ name, text }]`) against its manifest text (null: none). Returns the problems. */
export function checkManifest(text, source, containers) {
  if (text === null || text === undefined) return [`${source}: no ${MANIFEST_FILE}: which containers its recording wrote is unknown, so a missing case could not be seen`];
  let manifest;
  try { manifest = JSON.parse(text); } catch (error) { return [`${source}: ${MANIFEST_FILE} is no JSON: ${error.message}`]; }
  if (manifest?.format !== MANIFEST_FORMAT || manifest.version !== MANIFEST_VERSION || manifest.source !== source || !manifest.containers || typeof manifest.containers !== 'object') return [`${source}: ${MANIFEST_FILE} is not a ${MANIFEST_FORMAT}@${MANIFEST_VERSION} manifest of the source ${source}`];
  const problems = [];
  const present = new Map(containers.map((container) => [container.name, container.text]));
  for (const [name, entry] of Object.entries(manifest.containers)) {
    const held = present.get(name);
    if (held === undefined) { problems.push(`${source} ${name} (${entry.cases} cases) is listed but missing`); continue; }
    if (typeof held !== 'string') { problems.push(`${source} ${name}: no text to check against the manifest`); continue; }
    if (digestOf(held) !== entry.digest) {
      const now = containerSummary(held);
      problems.push(`${source} ${name} is not the container recorded: its digest differs (${now.cases} cases ${JSON.stringify(now.outcomes)}, listed ${entry.cases} ${JSON.stringify(entry.outcomes)})`);
    }
  }
  for (const name of present.keys()) if (!Object.hasOwn(manifest.containers, name)) problems.push(`${source} ${name} is not in the recording's manifest`);
  return problems;
}
