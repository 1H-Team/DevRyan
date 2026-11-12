// The comparer of a dual run. Between run A and run B it compares, and names
// every difference with where it is:
// - each call: result or error fields, summary step names and counts, the
//   journal records it reported, its observer payloads, its callbacks into
//   the host and their arguments, and the bytes of every result stream;
// - every file the run left under the stage (ledger folder and project), by
//   type, mode, link target and bytes;
// - each ledger's Git repository: refs, and every object reachable from them
//   by type and content, objects paired through the trees that name them;
//   unreachable objects by count and type; the loose/packed split;
// - `git fsck --strict` of each repository, and Git's own entry order of
//   every reachable tree (oracles independent of either run).
//
// What legitimately differs between two runs is listed in VOLATILE below,
// each with the narrowest rule that absorbs it. Identifiers chosen at random
// are not masked but paired one-to-one (dual-run-identity.mjs). Stored times
// and file stamps are not masked either: each is replaced by what the harness
// itself observed in the same run (the call window a time falls in; the file
// and the moment a stamp describes), and those are compared.
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { decodeValue } from './dual-run-codec.mjs';
import { UUID } from './dual-run-identity.mjs';
import { gitTreeOrder, parseTree } from './dual-run-snapshot.mjs';
import { resultMessage, traceOf } from './dual-run-runner.mjs';

/**
 * Every source of run-to-run difference the comparer absorbs, and how. The
 * report (docs/TESTING.md and the L0 report) lists the same table.
 */
export const VOLATILE = Object.freeze({
  // Durations measured by the ledger. Masked as numbers; their keys are kept.
  durationKeys: Object.freeze(['elapsedMs', 'queueMs', 'waitMs', 'holdMs', 'lockWaitMs', 'ms']),
  // Wall-clock times written by the ledger (Date.now()). A number at these keys
  // inside the run is replaced by the window of the harness's own timeline it
  // falls in (the group of calls in flight, or the gap after one); any other
  // number at these keys is compared as is.
  timeKeys: Object.freeze(['reservedAt', 'parkedAt', 'createdAt', 'startedAt', 'updatedAt', 'finishedAt', 'completedAt',
    'claimedAt', 'settledAt', 'observedAt', 'committedAt', 'from', 'to', 'at']),
  // File stamps `dev:ino` and `dev:ino:size:mtimeNs:ctimeNs[:mode]` (bigint
  // lstat): replaced by the path and moment of the harness's own observation
  // the stamp equals exactly; a stamp that equals none names the inode's path,
  // the moment and which fields differ from it.
  stampKeys: Object.freeze(['identity', 'observation', 'stamp', 'before', 'after']),
});

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// ---------------------------------------------------------------- masking
/**
 * The masker of one run. `timeline`: the harness's call windows of that run
 * ({ start, end } in order, at least 1 ms apart); `observations`: its stat
 * observations (observeStage); `mapPath`: how a path of this run is written in
 * run B's terms (identifiers substituted for run A, identity for run B).
 */
export function createMasker({ timeline = [], observations = [], mapPath = (text) => text } = {}) {
  const windows = timeline.filter((window) => Number.isFinite(window.start) && Number.isFinite(window.end));
  const first = windows[0]?.start ?? Infinity, last = windows.at(-1)?.end ?? -Infinity;
  /** The window of the timeline a stored time falls in; null outside the run (compared as is). */
  const timeLabel = (number) => {
    if (!(number >= first && number <= last)) return null;
    for (let index = 0; index < windows.length; index += 1) {
      const window = windows[index];
      if (number >= window.start && number <= window.end) {
        // Calls issued together share their group's window: which call's own
        // window (posted to returned) a time falls in races with when results
        // are delivered (seen: a lock taken by one session just before or just
        // after the other's result arrived), so it is not compared.
        return `<time in window ${index}>`;
      }
      if (number > window.end && number < (windows[index + 1]?.start ?? Infinity)) return `<time after window ${index}>`;
    }
    return '<time outside every window>';
  };
  /** Labels for every time of one record, with each time's rank among that record's times of the same window (equal times share a rank), so order and equality inside a window are compared too. */
  const rankedLabels = (numbers) => {
    const labels = new Map();
    const byLabel = new Map();
    for (const number of numbers) { const label = timeLabel(number); if (label) { labels.set(number, label); (byLabel.get(label) ?? byLabel.set(label, new Set()).get(label)).add(number); } }
    const ranked = new Map();
    for (const [label, set] of byLabel) [...set].sort((x, y) => x - y).forEach((number, rank) => ranked.set(number, set.size > 1 ? `${label.slice(0, -1)} #${rank + 1} of ${set.size}>` : label));
    return ranked;
  };
  const fives = new Map();
  const fiveOf = (index) => {
    if (!fives.has(index)) fives.set(index, new Map([...observations[index].stamps].map(([key, file]) => [key.split(':').slice(0, 5).join(':'), file])));
    return fives.get(index);
  };
  /** Stamps no observation accounts for, by where they were stored (`at` sets the location). */
  const unaccounted = [];
  let location = '';
  const at = (where) => { location = where; };
  const nsLabel = (ns) => timeLabel(Math.floor(Number(ns) / 1e6)) ?? `${ns}`;
  /** A stamp replaced by what the harness observed: the path and the first observation it equals. */
  const stampToken = (text) => {
    const parts = text.split(':');
    const identity = parts.slice(0, 2).join(':');
    if (parts.length === 2) {
      const index = observations.findIndex((observation) => observation.inodes.has(identity));
      if (index !== -1) return `<identity ${mapPath(observations[index].inodes.get(identity))}@${index}>`;
      unaccounted.push({ where: location, token: '<identity unobserved>' });
      return '<identity unobserved>';
    }
    for (let index = 0; index < observations.length; index += 1) {
      const file = parts.length === 6 ? observations[index].stamps.get(text) : fiveOf(index).get(text);
      if (file !== undefined) return `<stamp ${mapPath(file)}@${index}>`;
    }
    // No observation equals it: kept with every value that does not differ by run (size, mode, and its times by window).
    const index = observations.findIndex((observation) => observation.inodes.has(identity));
    let token;
    if (index === -1) token = `<stamp unobserved size ${parts[2]}${parts[5] ? ` mode ${parts[5]}` : ''} mtime ${nsLabel(parts[3])} ctime ${nsLabel(parts[4])}>`;
    else {
      const file = observations[index].inodes.get(identity);
      const seen = [...observations[index].stamps].find(([, other]) => other === file)?.[0].split(':') ?? [];
      const fields = ['dev', 'ino', 'size', 'mtime', 'ctime', 'mode'].filter((_, position) => position < parts.length && parts[position] !== seen[position]);
      token = `<stamp ${mapPath(file)}@${index} differs in ${fields.join(',')} size ${parts[2]} mtime ${nsLabel(parts[3])} ctime ${nsLabel(parts[4])}>`;
    }
    unaccounted.push({ where: location, token });
    return token;
  };
  const durationKeys = new Set(VOLATILE.durationKeys), timeKeys = new Set(VOLATILE.timeKeys), stampKeys = new Set(VOLATILE.stampKeys);
  const STAMP = /^\d+:\d+(?::\d+:\d+:\d+(?::\d+)?)?$/;
  // `{ identity: "dev:ino", observation: "dev:ino:size:..." }` (a file
  // record's `published` entry) and `{ identity, stamp }` (a view entry)
  // describe one file at one moment. A file system reuses a freed inode number at once (Linux does:
  // the ledger's ref file is replaced on every commit), so the first
  // observation holding that number can be another, older file. The stamp is
  // matched whole, times included, and names the observation; the identity
  // beside it, of the same inode, takes that observation. Returns the two
  // tokens, or null when the pair is not one file or the stamp was not observed.
  const IDENTITY = /^\d+:\d+$/;
  const pairedTokens = (identity, stamp) => {
    if (typeof identity !== 'string' || typeof stamp !== 'string' || !IDENTITY.test(identity) || !STAMP.test(stamp) || !stamp.startsWith(`${identity}:`)) return null;
    for (let index = 0; index < observations.length; index += 1) {
      const file = stamp.split(':').length === 6 ? observations[index].stamps.get(stamp) : fiveOf(index).get(stamp);
      if (file !== undefined) return { identity: `<identity ${mapPath(file)}@${index}>`, stamp: `<stamp ${mapPath(file)}@${index}>` };
    }
    return null;
  };
  // The same record names its file (`path`, relative to the project or a
  // view). When the stamp beside the identity matches no observation exactly
  // (the file changed again before the harness looked), the identity still
  // belongs to the first observation in which that inode is a file of that
  // path, not to an older file that held the number. Null when no observation
  // has the inode under that path: the identity is then judged alone.
  const identityByPath = (identity, file) => {
    if (typeof identity !== 'string' || typeof file !== 'string' || !file || !IDENTITY.test(identity)) return null;
    for (let index = 0; index < observations.length; index += 1) {
      const seen = observations[index].inodes.get(identity);
      if (seen !== undefined && (seen === file || seen.endsWith(`/${file}`))) return `<identity ${mapPath(seen)}@${index}>`;
    }
    return null;
  };
  const timesIn = (item, key = null, found = []) => {
    if (typeof item === 'number' && key !== null && timeKeys.has(key)) found.push(item);
    else if (Array.isArray(item)) for (const entry of item) timesIn(entry, null, found);
    else if (item && typeof item === 'object' && !Buffer.isBuffer(item)) for (const [name, entry] of Object.entries(item)) timesIn(entry, name, found);
    return found;
  };
  /** A JSON-shaped value with volatile members replaced (structure and keys kept). */
  const value = (root) => {
    const ranked = rankedLabels(timesIn(root));
    const visit = (item, key = null) => {
      if (typeof item === 'number' && key !== null) {
        if (durationKeys.has(key)) return '<duration>';
        if (timeKeys.has(key)) return ranked.get(item) ?? item;
        return item;
      }
      if (typeof item === 'string' && key !== null && stampKeys.has(key) && STAMP.test(item)) return stampToken(item);
      if (Array.isArray(item)) return item.map((entry) => visit(entry, null));
      if (item && typeof item === 'object' && !Buffer.isBuffer(item)) {
        const out = {};
        const beside = stampKeys.has('identity') ? ['stamp', 'observation'].find((name) => stampKeys.has(name) && typeof item[name] === 'string') : undefined;
        const paired = beside ? pairedTokens(item.identity, item[beside]) : null;
        const named = !paired && stampKeys.has('identity') ? identityByPath(item.identity, item.path) : null;
        for (const [name, entry] of Object.entries(item)) {
          if (paired && name === 'identity') out[name] = paired.identity;
          else if (paired && name === beside) out[name] = paired.stamp;
          else if (named && name === 'identity') out[name] = named;
          else out[name] = name === 'steps' && typeof entry === 'string' ? maskSteps(entry) : visit(entry, name);
        }
        return out;
      }
      return item;
    };
    return visit(root);
  };
  /** JSON text with the same rules applied in place, so key order and spelling still compare byte for byte. */
  const NUMBER = /"([A-Za-z]+)":(-?\d+(?:\.\d+)?)/g;
  const text = (source) => {
    const ranked = rankedLabels([...source.matchAll(NUMBER)].filter(([, key]) => timeKeys.has(key)).map(([, , number]) => Number(number)));
    return source
      .replace(NUMBER, (match, key, number) => {
        if (durationKeys.has(key)) return `"${key}":"<duration>"`;
        if (timeKeys.has(key)) { const label = ranked.get(Number(number)); return label ? `"${key}":"${label}"` : match; }
        return match;
      })
      .replace(/"identity":"(\d+:\d+)","(stamp|observation)":"(\d+:\d+:\d+:\d+:\d+(?::\d+)?)"/g, (match, identity, key, stamp) => {
        const paired = stampKeys.has(key) ? pairedTokens(identity, stamp) : null;
        return paired ? `"identity":"${paired.identity}","${key}":"${paired.stamp}"` : match;
      })
      .replace(/"([A-Za-z]+)":"(\d+:\d+(?::\d+:\d+:\d+(?::\d+)?)?)"/g, (match, key, stamp) => (stampKeys.has(key) ? `"${key}":"${stampToken(stamp)}"` : match));
  };
  /** `verified-objects.v1`: `<sha256> <dev:ino:size:mtimeNs:ctimeNs>` per line. */
  const verifiedLine = (line) => line.replace(/ (\d+:\d+:\d+:\d+:\d+)$/, (_, stamp) => ` ${stampToken(stamp)}`);
  const maskSteps = (steps) => steps.replace(/:(\d+)\/(\d+)/g, ':$1/<duration>');
  return { value, text, steps: maskSteps, verifiedLine, timeLabel, stampToken, unaccounted, at };
}

// ---------------------------------------------------------------- differences
export function createDifferences() {
  const list = [], notes = [];
  const add = (category, where, detail) => { list.push({ category, where, detail }); };
  const note = (where, detail) => { notes.push({ where, detail }); };
  return { add, note, list, notes };
}
const show = (value) => {
  const text = typeof value === 'string' ? value : value === undefined ? 'undefined' : typeof value === 'bigint' ? `${value}n` : JSON.stringify(value) ?? String(value);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
};
/** First path at which two JSON values differ, for a readable message. */
// Key order counts: JSON.stringify writes members in insertion order.
export function firstDifference(a, b, where = '$') {
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return a.equals(b) ? null : { where, a: `${a.length} bytes`, b: `${b.length} bytes` };
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return isDeepStrictEqual(a, b) ? null : { where, a: show(a), b: show(b) };
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return { where, a: `array of ${a.length}`, b: `array of ${b.length}` };
    for (let index = 0; index < a.length; index += 1) { const found = firstDifference(a[index], b[index], `${where}[${index}]`); if (found) return found; }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Buffer.isBuffer(a) && !Buffer.isBuffer(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.join('\0') !== kb.join('\0')) {
      const sa = new Set(ka), sb = new Set(kb);
      const missing = ka.filter((key) => !sb.has(key)), extra = kb.filter((key) => !sa.has(key));
      if (missing.length || extra.length) return { where, a: `keys ${ka.join(',')}`, b: `keys ${kb.join(',')}`, missing, extra };
      return { where, a: `key order ${ka.join(',')}`, b: `key order ${kb.join(',')}` };
    }
    for (const key of ka) { const found = firstDifference(a[key], b[key], `${where}.${key}`); if (found) return found; }
    return null;
  }
  return { where, a: show(a), b: show(b) };
}
const textDifference = (a, b) => {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
  return { offset: index, a: show(a.slice(Math.max(0, index - 60), index + 80)), b: show(b.slice(Math.max(0, index - 60), index + 80)) };
};

// ---------------------------------------------------------------- traces
const STREAM = '__devryanStream';
const ERROR_FIELDS = ['name', 'message', 'code', 'status', 'committed', 'rollbackFailed', 'retryable', 'reason'];
const errorShape = (error) => {
  if (!error) return null;
  const out = {};
  for (const field of ERROR_FIELDS) if (error[field] !== undefined) out[field] = error[field];
  if (Array.isArray(error.errors)) out.errors = error.errors.map(errorShape);
  if (error.cause) out.cause = errorShape(error.cause);
  return out;
};
/** The comparable content of one call's trace, in one run's own terms (identities not yet substituted). */
function callView(trace, masker, method, seeded) {
  const view = { result: null, steps: [], reports: [], slowReports: 0, progress: [], callbacks: [], observed: {}, streams: [] };
  masker.at(`call ${method}`);
  const streamBytes = new Map();
  for (const { dir, message } of trace) {
    const decoded = decodeValue(message);
    switch (decoded.type) {
      case 'result':
        // `undefined` and `null` are different results on the seam: compared as they are.
        view.result = decoded.failed ? { failed: true, error: errorShape(decoded.error) } : { failed: false, value: decoded.value };
        view.steps = (decoded.steps ?? []).map(([phase, step]) => [phase, step.count]);
        for (const id of streamOrder(decoded.value)) streamBytes.set(id, []);
        break;
      case 'report':
        // Records a phase emits only because it ran past a duration threshold
        // (`slow: true`, quietExecutionPhase's 250 ms, a summary's slowMs)
        // depend on load: counted, not compared.
        if (decoded.record?.slow === true) view.slowReports += 1;
        else view.reports.push(masker.value(decoded.record));
        break;
      case 'progress':
        if (view.progress.at(-1) !== decoded.waiting) view.progress.push(decoded.waiting);
        break;
      case 'callback':
        view.callbacks.push({ target: decoded.target?.observer ?? `fn:${decoded.target?.fn}`, args: masker.value(decoded.args) });
        break;
      case 'callback-result':
        // `undefined` and `null` are different values on the seam (structured clone and the wire keep them apart).
        view.callbacks.push({ answer: decoded.failed ? { failed: true, error: errorShape(decoded.error) } : { failed: false, value: masker.value(decoded.value) } });
        break;
      case 'observe': {
        // The worker's own event-loop stalls measure load, nothing the ledger decides.
        if (decoded.observer === 'onWorkerStall') break;
        (view.observed[decoded.observer] ??= []).push(masker.value(decoded.payload));
        break;
      }
      case 'chunk':
        if (streamBytes.has(decoded.stream) && decoded.value) streamBytes.get(decoded.stream).push(Buffer.from(decoded.value));
        break;
      default: void dir;
    }
  }
  // Each result stream is replaced in place by the digest of its bytes.
  const inline = (value) => {
    if (Array.isArray(value)) return value.map(inline);
    if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
      if (typeof value[STREAM] === 'number') return { [STREAM]: streamBytes.has(value[STREAM]) ? sha256(Buffer.concat(streamBytes.get(value[STREAM]))) : '<unread>' };
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, inline(entry)]));
    }
    return value;
  };
  if (view.result && !view.result.failed) {
    let value = inline(view.result.value);
    // A receipt lists files in the order of the lease's base list, which follows
    // the files/<sha256(random document ID)> keys: compared as they are when
    // both runs drew the protocol's identifiers, else ordered by path.
    if (!seeded && method === 'executionReceipt' && Array.isArray(value?.files)) value = { ...value, files: [...value.files].sort((x, y) => String(x.path).localeCompare(String(y.path))) };
    // `drain` resolves Promise.allSettled over the background work still in
    // flight when it was called (standby retirement, maintenance): how many
    // depends on timing. Whether it settled is compared.
    if (method === 'drain' && Array.isArray(value)) value = '<background work settled>';
    view.result.value = masker.value(value);
  }
  delete view.streams;
  return view;
}
const streamOrder = (value, found = []) => {
  if (Array.isArray(value)) { for (const item of value) streamOrder(item, found); return found; }
  if (value && typeof value === 'object') {
    if (typeof value[STREAM] === 'number') { found.push(value[STREAM]); return found; }
    for (const entry of Object.values(value)) streamOrder(entry, found);
  }
  return found;
};

/** Compares every call of a recording (run A) with the same call of a replay (run B). */
export function compareTraces({ recording, run, identities, maskers, differences, labels, seeded = false }) {
  for (const label of labels ?? Object.keys(recording.calls)) {
    const recorded = recording.calls[label], replayed = run.calls[label];
    if (!replayed) { differences.add('call', label, 'not reached in run B'); continue; }
    const traceA = traceOf(recording.generations[recorded.generation].entries, recorded.seamID);
    const traceB = traceOf(run.generations[replayed.generation].entries, replayed.seamID);
    const resultA = resultMessage(recording.generations[recorded.generation].entries, recorded.seamID);
    const resultB = resultMessage(run.generations[replayed.generation].entries, replayed.seamID);
    if (resultA && resultB && !resultA.failed && !resultB.failed) identities.align(decodeValue(resultA.value ?? null), decodeValue(resultB.value ?? null), `${label}.result`);
    const viewA = identities.substitute(callView(traceA, maskers.a, recorded.method, seeded)), viewB = callView(traceB, maskers.b, recorded.method, seeded);
    // A call its host aborted stops wherever the abort lands, which follows
    // timing (queue wait, lock wait, or before either): its result and
    // callbacks are compared, how far its work got is a note.
    const aborted = traceA.some(({ dir, message }) => dir === 'h2w' && message.type === 'abort');
    for (const part of ['result', 'steps', 'reports', 'progress', 'callbacks', 'observed']) {
      const found = firstDifference(viewA[part], viewB[part], part);
      if (found && aborted && part !== 'result' && part !== 'callbacks') differences.note(`${label} (${recorded.method}), aborted`, found);
      else if (found) differences.add('call', `${label} (${recorded.method})`, found);
    }
  }
  // Messages tied to no call: the ready message's method list, observers and
  // observer callbacks (onChange, onMaterialize) of background work, as multisets.
  for (let generation = 0; generation < recording.generations.length; generation += 1) {
    const untiedA = recording.generations[generation]?.untied ?? [], untiedB = run.generations[generation]?.untied ?? [];
    const methods = (list) => decodeValue(list.find(({ message }) => message?.type === 'ready')?.message ?? { methods: null }).methods;
    const found = firstDifference(methods(untiedA), methods(untiedB), 'ready.methods');
    if (found && run.generations[generation]) differences.add('protocol', `generation ${generation}`, found);
    const background = (list, masker) => list.flatMap(({ message }) => {
      if (message?.type === 'observe' && message.observer !== 'onWorkerStall') return [JSON.stringify(['observe', message.observer, masker.value(decodeValue(message.payload))])];
      if (message?.type === 'callback' && message.target?.observer !== undefined) return [JSON.stringify(['callback', message.target.observer, masker.value(decodeValue(message.args ?? null))])];
      return [];
    }).sort();
    const backgroundFound = firstDifference(identities.substitute(background(untiedA, maskers.a)), background(untiedB, maskers.b), 'background observers and callbacks');
    if (backgroundFound && run.generations[generation]) differences.add('journal', `generation ${generation}`, backgroundFound);
  }
}

// ---------------------------------------------------------------- disk
const maskedName = (name) => name.replace(UUID, '<id>').replace(/[0-9a-f]{64}/g, '<h>');

/**
 * Compares two snapshots. `identities` maps run A's identifiers to run B's
 * (seeded from the call traces, extended here); `masker` holds the run
 * windows. Paths are stage-relative, and both runs ran at the same stage path.
 */
export async function compareSnapshots({ a, b, identities, maskers, differences, seeded = false }) {
  const objectPairs = new Map();
  for (const root of new Set([...Object.keys(a.ledgers), ...Object.keys(b.ledgers)])) {
    const ledgerA = a.ledgers[root], ledgerB = b.ledgers[root];
    if (!ledgerA || !ledgerB) { differences.add('ledger', root, ledgerA ? 'missing in run B' : 'only in run B'); continue; }
    compareRepositories({ root, ledgerA, ledgerB, identities, maskers, differences, objectPairs, seeded });
  }
  compareFiles({ a, b, identities, maskers, differences });
  return { objectPairs };
}

function compareRepositories({ root, ledgerA, ledgerB, identities, maskers, differences, objectPairs, seeded }) {
  const where = (detail) => `ledger ${root.slice(0, 12)}…: ${detail}`;
  for (const [name, ledger] of [['A', ledgerA], ['B', ledgerB]]) {
    if (ledger.fsck.code !== 0 || ledger.fsck.output) differences.add('oracle', where(`git fsck --strict in run ${name}`), ledger.fsck.output || `exit ${ledger.fsck.code}`);
  }
  if (ledgerA.format !== ledgerB.format) differences.add('git', where('object format'), { a: ledgerA.format, b: ledgerB.format });
  if (ledgerA.head !== ledgerB.head) differences.add('git', where('HEAD'), { a: ledgerA.head, b: ledgerB.head });
  // Refs: names carry lease tokens; pair them through the identities.
  const refsB = new Map(ledgerB.refs.map((ref) => [ref.name, ref]));
  const reachedA = new Set(), reachedB = new Set();
  const pairObjects = (idA, idB, path) => compareObject({ idA, idB, path, ledgerA, ledgerB, identities, maskers, differences, objectPairs, reachedA, reachedB, where, seeded });
  const refsA = [...ledgerA.refs].sort((x, y) => (x.name.match(UUID) ? 1 : 0) - (y.name.match(UUID) ? 1 : 0));
  const unmatched = [];
  for (const ref of refsA) {
    const partner = refsB.get(identities.substituteText(ref.name));
    if (!partner) { unmatched.push(ref); continue; }
    refsB.delete(partner.name);
    if (ref.type !== partner.type) differences.add('git', where(`ref ${ref.name}`), { a: ref.type, b: partner.type });
    pairObjects(ref.id, partner.id, ref.name);
  }
  // Refs named by identifiers no result carried: pair by masked name when unambiguous.
  for (const ref of unmatched) {
    const candidates = [...refsB.values()].filter((other) => maskedName(other.name) === maskedName(ref.name));
    if (candidates.length === 1) {
      identities.alignText(ref.name, candidates[0].name, `ref ${ref.name}`);
      refsB.delete(candidates[0].name);
      pairObjects(ref.id, candidates[0].id, ref.name);
    } else differences.add('git', where(`ref ${ref.name}`), 'missing in run B');
  }
  for (const ref of refsB.values()) differences.add('git', where(`ref ${ref.name}`), 'only in run B');
  // Unreachable objects and the loose/packed split are reported, not compared:
  // superseded pages differ in number when a list's order follows random IDs
  // (see RECEIPT_PAGE). Every reachable object is compared above.
  const unreachable = (ledger, reached) => {
    const counts = {};
    for (const [id, object] of ledger.objects) if (!reached.has(id)) counts[object.type] = (counts[object.type] ?? 0) + 1;
    // Git lists objects in no particular order: types in a fixed order.
    return Object.fromEntries(Object.entries(counts).sort(([x], [y]) => x.localeCompare(y)));
  };
  const storage = (ledger, reached) => ({ unreachable: unreachable(ledger, reached), loose: ledger.loose.size, packs: ledger.packs });
  // With both runs on the same seeded identifiers, record contents (and so
  // object dedupe and every superseded page) are the same: compared. Otherwise reported.
  if (seeded) {
    const found = firstDifference(storage(ledgerA, reachedA), storage(ledgerB, reachedB), 'storage');
    if (found) differences.add('git', where('unreachable objects and loose/packed split'), found);
  } else differences.note(where('storage'), { a: storage(ledgerA, reachedA), b: storage(ledgerB, reachedB) });
}

function compareObject(context) {
  const { idA, idB, path: objectPath, ledgerA, ledgerB, differences, objectPairs, reachedA, reachedB, where } = context;
  const known = objectPairs.get(idA);
  if (known !== undefined) {
    if (known === idB) return true;
    // The same object of run A stands where run B has two different ones (a
    // historical state and the final one, say): name what differs in this one.
    const objectA = ledgerA.objects.get(idA), objectB = ledgerB.objects.get(idB);
    const before = differences.list.length;
    if (objectA?.type === 'blob' && objectB?.type === 'blob') compareBlob({ ...context, objectA, objectB });
    if (differences.list.length === before) differences.add('git', where(`${objectPath}`), `object ${idA} paired with ${known} and ${idB}`);
    return false;
  }
  objectPairs.set(idA, idB);
  reachedA.add(idA); reachedB.add(idB);
  const objectA = ledgerA.objects.get(idA), objectB = ledgerB.objects.get(idB);
  if (!objectA || !objectB) { differences.add('git', where(objectPath), `object missing: ${objectA ? '' : `A ${idA} `}${objectB ? '' : `B ${idB}`}`); return false; }
  if (objectA.type !== objectB.type) { differences.add('git', where(objectPath), { a: objectA.type, b: objectB.type }); return false; }
  if (objectA.type === 'blob') return compareBlob({ ...context, objectA, objectB });
  if (objectA.type === 'tree') return compareTree({ ...context, objectA, objectB });
  if (!objectA.data.equals(objectB.data)) differences.add('git', where(objectPath), `${objectA.type} bytes differ`);
  return true;
}

const RECEIPT_PAGE = /\/publications\/[^/]+\/files\/\d{10}\.json$/;
function compareBlob({ path: objectPath, objectA, objectB, identities, maskers, differences, where, idA, idB, seeded }) {
  if (idA === idB) return true;
  const textA = objectA.data.toString('latin1'), textB = objectB.data.toString('latin1');
  const location = `blob ${maskedName(objectPath.replace(/@\{\d+\}/, ''))}`;
  maskers.a.at(location); maskers.b.at(location);
  let jsonA, jsonB;
  try { jsonA = JSON.parse(objectA.data.toString('utf8')); jsonB = JSON.parse(objectB.data.toString('utf8')); } catch { jsonA = jsonB = undefined; }
  if (jsonA !== undefined) identities.align(jsonA, jsonB, objectPath);
  else identities.alignText(textA, textB, objectPath);
  if (!seeded && RECEIPT_PAGE.test(objectPath) && Array.isArray(jsonA) && Array.isArray(jsonB)) {
    // Rows in base-list order (files/<sha256(random document ID)> key order),
    // without the protocol's identifiers: compared as rows ordered by path,
    // each row byte for byte. With them, the page is compared as written.
    const rows = (rowsOf, map, masker) => rowsOf.map((row) => masker.text(map(JSON.stringify(row)))).sort();
    const found = firstDifference(rows(jsonA, identities.substituteText, maskers.a), rows(jsonB, (text) => text, maskers.b));
    if (found) differences.add('git', where(`blob ${objectPath}`), found);
    return !found;
  }
  const normalA = maskers.a.text(identities.substituteText(textA)), normalB = maskers.b.text(textB);
  if (normalA === normalB) return true;
  const detail = jsonA !== undefined ? firstDifference(maskers.a.value(identities.substitute(jsonA)), maskers.b.value(jsonB)) ?? textDifference(normalA, normalB) : textDifference(normalA, normalB);
  differences.add('git', where(`blob ${objectPath}`), detail);
  return false;
}

function compareTree(context) {
  const { path: objectPath, objectA, objectB, ledgerA, ledgerB, identities, differences, where } = context;
  const entriesA = parseTree(objectA.data, ledgerA.format), entriesB = parseTree(objectB.data, ledgerB.format);
  // Oracle: Git's canonical order, in each run.
  for (const [name, entries] of [['A', entriesA], ['B', entriesB]]) {
    for (let index = 1; index < entries.length; index += 1) {
      if (gitTreeOrder(entries[index - 1], entries[index]) >= 0) {
        differences.add('oracle', where(`tree ${objectPath} in run ${name}`), `entries out of Git order: ${entries[index - 1].name} before ${entries[index].name}`);
        break;
      }
    }
  }
  const byName = new Map(entriesB.map((entry) => [entry.name, entry]));
  const pending = [...entriesA];
  const paired = [];
  const pair = (entryA, entryB) => {
    byName.delete(entryB.name);
    paired.push([entryA, entryB]);
    if (entryA.mode !== entryB.mode) differences.add('git', where(`${objectPath}/${entryA.name}`), { a: `mode ${entryA.mode}`, b: `mode ${entryB.mode}` });
    compareObject({ ...context, idA: entryA.id, idB: entryB.id, path: `${objectPath}/${entryA.name}` });
  };
  // A name derived from an identifier must follow the identifier's pair.
  const pairChecked = (entryA, entryB) => {
    pair(entryA, entryB);
    if (identities.substituteText(entryA.name) !== entryB.name) differences.add('git', where(`${objectPath}/${entryA.name}`), { a: `named ${identities.substituteText(entryA.name)}`, b: `named ${entryB.name}` });
  };
  // Names without unpaired identifiers first: recursing into them teaches the
  // pairs (record IDs) that name the rest (`runs/<id>`, `revisions/<id>`).
  for (let progress = true; progress && pending.length;) {
    progress = false;
    for (let index = 0; index < pending.length;) {
      const entryB = byName.get(identities.substituteText(pending[index].name));
      if (entryB) { pair(pending[index], entryB); pending.splice(index, 1); progress = true; } else index += 1;
    }
  }
  // Left over: names derived from identifiers no result carried (`files/<sha256(id)>.json`).
  // Pair entries whose content is the same up to identifiers and volatile
  // values; the pairing then teaches the identifier, and the name must follow it.
  const fingerprintOf = (ledger, entry, masker) => `${entry.mode} ${maskedName(entry.name)} ${fingerprint(ledger, entry.id, masker)}`;
  const groups = new Map();
  for (const entryA of pending) {
    const key = fingerprintOf(ledgerA, entryA, context.maskers.a);
    (groups.get(key) ?? groups.set(key, { a: [], b: [] }).get(key)).a.push(entryA);
  }
  for (const entryB of byName.values()) groups.get(fingerprintOf(ledgerB, entryB, context.maskers.b))?.b.push(entryB);
  const leftover = [];
  for (const { a: groupA, b: groupB } of groups.values()) {
    const count = Math.min(groupA.length, groupB.length);
    for (let index = 0; index < count; index += 1) {
      identities.alignText(groupA[index].name, groupB[index].name, `${objectPath}/${groupA[index].name}`);
      pairChecked(groupA[index], groupB[index]);
    }
    leftover.push(...groupA.slice(count));
  }
  // Still unpaired: records of the same kind that name the same project path
  // (`files/<sha256(document ID)>.json` without the identifier protocol) are the
  // same record, changed: paired and compared field by field.
  const pathOf = (ledger, entry) => {
    const object = ledger.objects.get(entry.id);
    if (object?.type !== 'blob') return null;
    try { const json = JSON.parse(object.data.toString('utf8')); const file = json?.published?.path ?? json?.path; return typeof file === 'string' ? file : null; } catch { return null; }
  };
  for (const entryA of [...leftover]) {
    const file = pathOf(ledgerA, entryA);
    if (file === null) continue;
    const candidates = [...byName.values()].filter((entryB) => maskedName(entryB.name) === maskedName(entryA.name) && pathOf(ledgerB, entryB) === identities.substituteText(file));
    const others = leftover.filter((other) => maskedName(other.name) === maskedName(entryA.name) && pathOf(ledgerA, other) === file);
    if (candidates.length !== 1 || others.length !== 1) continue;
    identities.alignText(entryA.name, candidates[0].name, `${objectPath}/${entryA.name}`);
    pairChecked(entryA, candidates[0]);
    leftover.splice(leftover.indexOf(entryA), 1);
  }
  // Still unpaired: the same masked name on both sides once each is a changed
  // record (compared field by field); anything else is missing or extra.
  for (const entryA of leftover) {
    const candidates = [...byName.values()].filter((entryB) => maskedName(entryB.name) === maskedName(entryA.name));
    const others = leftover.filter((other) => maskedName(other.name) === maskedName(entryA.name));
    if (candidates.length === 1 && others.length === 1) pairChecked(entryA, candidates[0]);
    else differences.add('git', where(`${objectPath}/${entryA.name}`), 'entry missing in run B');
  }
  for (const entryB of byName.values()) differences.add('git', where(`${objectPath}/${entryB.name}`), 'entry only in run B');
  // Where no name holds an identifier, the stored order must be the same too.
  if (paired.every(([entryA, entryB]) => entryA.name === entryB.name) && entriesA.length === entriesB.length) {
    const orderA = entriesA.map((entry) => entry.name).join('\0'), orderB = entriesB.map((entry) => entry.name).join('\0');
    if (orderA !== orderB) differences.add('git', where(`tree ${objectPath}`), 'same entries in a different order');
  }
  return true;
}

// Content of an object up to identifiers and volatile values (memoized per repository).
const fingerprints = new WeakMap();
function fingerprint(ledger, id, masker) {
  let memo = fingerprints.get(ledger);
  if (!memo) { memo = new Map(); fingerprints.set(ledger, memo); }
  if (memo.has(id)) return memo.get(id);
  const object = ledger.objects.get(id);
  let print = 'missing';
  if (object?.type === 'blob') print = sha256(maskedName(masker.text(object.data.toString('latin1'))));
  else if (object?.type === 'tree') print = sha256(parseTree(object.data, ledger.format).map((entry) => `${entry.mode} ${maskedName(entry.name)} ${fingerprint(ledger, entry.id, masker)}`).sort().join('\n'));
  memo.set(id, print);
  return print;
}

// Files of a ledger's own Git repository the comparer reads through Git
// (loose refs, packed refs, loose objects and packs and Git's list of packs,
// reflogs, info/refs),
// matched only at `<storage>/<root>/git/`, so a project path that merely
// contains such names is compared like any file. A lock file is never one of
// them: at rest it is reported (Git refuses to move a ref while it exists).
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const gitInternals = (storage) => new RegExp(`^${escapeRegExp(storage)}/[^/]+/git/(?:refs/.*|packed-refs|objects/(?:[0-9a-f]{2}|[0-9a-f]{2}/[0-9a-f]{38,62}|pack|pack/pack-[0-9a-f]+\\.(?:pack|idx|rev|bitmap)|info/packs)|ORIG_HEAD|logs/.*|info/refs)$`);
const isGitIndex = (relative) => /(^|\/)\.git\/index$/.test(relative) || /\/state\.metadata-index$/.test(relative);

function compareFiles({ a, b, identities, maskers, differences }) {
  const internal = gitInternals(a.storage);
  const isLedgerGitInternal = (relative) => internal.test(relative) && !relative.endsWith('.lock');
  // Oracle, each run: no lock file left in a ledger's Git repository.
  const gitLock = new RegExp(`^${escapeRegExp(a.storage)}/[^/]+/git/.*\\.lock$`);
  for (const [name, files] of [['A', a.files], ['B', b.files]]) for (const relative of files.keys()) if (gitLock.test(relative)) differences.add('oracle', `${relative} in run ${name}`, 'lock file left in the ledger\'s Git repository');
  const filesB = new Map(b.files);
  const pendingA = [];
  const lookup = (relative) => filesB.get(identities.substituteText(relative));
  for (const [relative, entryA] of a.files) {
    if (isLedgerGitInternal(relative)) {
      // `info/refs` (written by repack) names refs with the ids of that moment: the names are compared.
      const partner = filesB.get(identities.substituteText(relative));
      if (relative.endsWith('/git/info/refs') && entryA.data && partner?.data) {
        const names = (data) => data.toString('latin1').split('\n').filter(Boolean).map((line) => line.split('\t')[1] ?? '');
        const found = firstDifference(names(entryA.data).map(identities.substituteText), names(partner.data));
        if (found) differences.add('file', relative, found);
      } else if (relative.endsWith('/git/info/refs') && Boolean(entryA) !== Boolean(partner)) differences.add('file', relative, partner ? 'only in run B' : 'missing in run B');
      filesB.delete(identities.substituteText(relative));
      continue;
    }
    const entryB = lookup(relative);
    if (!entryB) { pendingA.push(relative); continue; }
    filesB.delete(identities.substituteText(relative));
    compareFile(relative, entryA, entryB, { identities, maskers, differences });
  }
  // Directories named by identifiers no result carried (view-standby/<id>):
  // pair each unmatched top directory with the one of the same masked name
  // whose listing matches.
  const topsA = new Map(), topsB = new Map();
  const top = (relative) => { const match = UUID.exec(relative); UUID.lastIndex = 0; return match ? relative.slice(0, match.index + match[0].length) : null; };
  for (const relative of pendingA) { const key = top(relative); if (key) (topsA.get(key) ?? topsA.set(key, []).get(key)).push(relative); else differences.add('file', relative, 'missing in run B'); }
  for (const relative of filesB.keys()) { if (isLedgerGitInternal(relative)) { filesB.delete(relative); continue; } const key = top(relative); if (key) (topsB.get(key) ?? topsB.set(key, []).get(key)).push(relative); }
  // A Git index caches stat data, so only its presence counts here.
  const listing = (relatives, base, files) => relatives.map((relative) => `${relative.slice(base.length)} ${files.get(relative).type} ${isGitIndex(relative) ? 'index' : files.get(relative).sha256 ?? files.get(relative).target ?? ''}`).sort().join('\n');
  for (const [keyA, relativesA] of topsA) {
    const candidates = [...topsB.entries()].filter(([keyB]) => maskedName(keyB) === maskedName(keyA));
    const printA = listing(relativesA, keyA, a.files);
    // The same listing first; else the first remaining directory of that
    // masked name, compared entry by entry so the difference is named.
    const match = candidates.find(([keyB, relativesB]) => listing(relativesB, keyB, b.files) === printA) ?? candidates[0] ?? null;
    if (!match) { differences.add('file', keyA, `missing in run B (${relativesA.length} entries)`); continue; }
    const [keyB, relativesB] = match;
    topsB.delete(keyB);
    identities.alignText(keyA, keyB, keyA);
    for (const relative of relativesA) {
      const partner = keyB + relative.slice(keyA.length);
      const entryB = b.files.get(partner);
      filesB.delete(partner);
      if (!entryB) { differences.add('file', relative, 'missing in run B'); continue; }
      compareFile(relative, a.files.get(relative), entryB, { identities, maskers, differences });
    }
    for (const relative of relativesB) if (filesB.has(relative)) { differences.add('file', relative, 'only in run B'); filesB.delete(relative); }
  }
  for (const relative of filesB.keys()) differences.add('file', relative, 'only in run B');
}

function compareFile(relative, entryA, entryB, { identities, maskers, differences }) {
  if (entryA.type !== entryB.type) { differences.add('file', relative, { a: entryA.type, b: entryB.type }); return; }
  if (entryA.mode !== entryB.mode) differences.add('file', relative, { a: `mode ${entryA.mode.toString(8)}`, b: `mode ${entryB.mode.toString(8)}` });
  if (entryA.type === 'symlink' && entryA.target !== entryB.target) differences.add('file', relative, { a: `-> ${entryA.target}`, b: `-> ${entryB.target}` });
  if (entryA.type !== 'file' || entryA.sha256 === entryB.sha256) return;
  if (isGitIndex(relative)) {
    // A Git index caches stat data (times, inode) of the files it lists. Its
    // entries are compared by Git in compareIndexes, not its bytes.
    return;
  }
  if (!entryA.data || !entryB.data) { differences.add('file', relative, `bytes differ (${entryA.size} / ${entryB.size} bytes)`); return; }
  const textA = entryA.data.toString('latin1'), textB = entryB.data.toString('latin1');
  maskers.a.at(`file ${maskedName(relative)}`); maskers.b.at(`file ${maskedName(relative)}`);
  if (/(^|\/)verified-objects\.v1$/.test(relative)) {
    // `<sha256> <dev:ino:size:mtimeNs:ctimeNs>` per verified content object,
    // appended as concurrent installs (8 per project) complete: compared as a
    // set of lines, each stamp replaced by the observation it equals.
    const lines = (text, masker) => text.split('\n').map((line) => masker.verifiedLine(line)).sort().join('\n');
    const linesA = lines(textA, maskers.a), linesB = lines(textB, maskers.b);
    if (linesA !== linesB) differences.add('file', relative, firstDifference(linesA.split('\n'), linesB.split('\n'), 'lines') ?? textDifference(linesA, linesB));
    return;
  }
  identities.alignText(textA, textB, relative);
  const normalA = maskers.a.text(identities.substituteText(textA)), normalB = maskers.b.text(textB);
  if (normalA !== normalB) differences.add('file', relative, textDifference(normalA, normalB));
}

/** Git indexes under the stage, compared by their entries (path, mode, stage, object paired through `objectPairs` or by content). */
export async function compareIndexes({ a, b, readIndex, identities, differences, objectPairs }) {
  for (const [relative, entry] of a.files) {
    if (entry.type !== 'file' || !isGitIndex(relative)) continue;
    const partner = identities.substituteText(relative);
    if (!b.files.has(partner)) continue;
    const listA = await readIndex(a, relative), listB = await readIndex(b, partner);
    const rows = (list, mapIDs) => (list.error ? [`error ${list.error}`] : list.entries.map((row) => `${row.mode} ${mapIDs ? (objectPairs.get(row.id) ?? row.id) : row.id} ${row.stage} ${identities.substituteText(row.path)}`));
    const found = firstDifference(rows(listA, true), rows(listB, false), 'entries');
    if (found) differences.add('file', `${relative} (index entries)`, found);
  }
}

// ---------------------------------------------------------------- ref moves
/**
 * The ledger ref moves of one run, as the git shim saw them from outside the
 * implementation (dual-run-git-shim.mjs): per ledger root, the successful
 * moves of `refs/devryan/state` in order (with the lock state before and
 * after each), and the moves of lease refs. Moves outside a ledger's own
 * repository (a view's `HEAD`) are left out.
 */
export function refMoves(events, storageDir) {
  const roots = {};
  const open = new Map();
  for (const event of events) {
    if (!event.ref?.startsWith('refs/devryan/') || !event.gitDir) continue;
    const root = path.basename(path.dirname(event.gitDir));
    if (storageDir && real(path.dirname(path.dirname(event.gitDir))) !== real(storageDir)) continue;
    const key = `${event.pid} ${event.args}`;
    if (event.phase === 'before') { open.set(key, event); continue; }
    const before = open.get(key);
    open.delete(key);
    const moves = (roots[root] ??= { state: [], leases: [] });
    const move = { ref: event.ref, pid: event.pid, deleting: event.deleting, values: event.values, code: event.code, lockBefore: before?.lock ?? null, lockAfter: event.lock, sawBefore: Boolean(before) };
    if (event.ref === 'refs/devryan/state') moves.state.push(move); else moves.leases.push(move);
  }
  for (const before of open.values()) {
    if (!before.ref?.startsWith('refs/devryan/') || !before.gitDir) continue;
    const root = path.basename(path.dirname(before.gitDir));
    (roots[root] ??= { state: [], leases: [] })[before.ref === 'refs/devryan/state' ? 'state' : 'leases'].push({ ref: before.ref, pid: before.pid, values: before.values, code: null, lockBefore: before.lock, lockAfter: null, sawBefore: true, unfinished: true });
  }
  return roots;
}
const real = (file) => { try { return realpathSync(file); } catch { return path.resolve(file); } };

/**
 * The owner.lock format (file 26 §3b, shared with the updater and every other
 * holder of a cross-process lock): exactly these bytes, keys in this order,
 * `createdAt` in milliseconds, one trailing newline.
 */
export const LOCK_FORMAT = /^\{"ownerToken":"([0-9a-f]{32})","pid":(\d+),"createdAt":(\d+)\}\n$/;
/** One lock file seen by the shim, checked on its own: the format, the mover's pid, and a creation time inside the run (when a masker knows the run). */
export function lockProblems(lock, pid, masker) {
  if (lock === null) return [];
  const match = LOCK_FORMAT.exec(lock.raw ?? '');
  if (!match) return [`owner.lock bytes do not follow the format: ${JSON.stringify(lock.raw)}`];
  const problems = [];
  if (Number(match[2]) !== pid) problems.push(`owner.lock names pid ${match[2]}, the mover is ${pid}`);
  const label = masker?.timeLabel(Number(match[3]));
  if (masker && !(label ?? '').startsWith('<time in window')) problems.push(`owner.lock createdAt ${match[3]} is not a time inside one of the run's call windows (${label ?? 'outside the run'})`);
  return problems;
}
/** A lock's bytes with only what legitimately differs replaced: the token, the pid, and the time by its window. */
const lockShape = (lock, masker) => {
  if (lock === null) return 'absent';
  return (lock.raw ?? '').replace(/"ownerToken":"[0-9a-f]{32}"/, '"ownerToken":"<token>"').replace(/"pid":\d+/, '"pid":"<pid>"')
    .replace(/"createdAt":(\d+)/, (_, ms) => `"createdAt":"${masker?.timeLabel(Number(ms)) ?? `<${ms.length} digits>`}"`);
};

const lockState = (lock, pid) => (lock === null ? 'absent' : lock.unparseable !== undefined ? 'unreadable' : lock.pid === pid ? 'held' : 'other');

/**
 * Protocol invariants of ref moves, compared from the shim's observations:
 * - oracle, each run: every move of `refs/devryan/state` happens while
 *   owner.lock exists and names the moving process, from before the update
 *   to after it (a lock released while the update still runs is a finding);
 * - the number of successful state moves, and every tree the state ref ever
 *   pointed to, in order, compared object by object (a step a later commit
 *   repairs still shows);
 * - lease refs: how many are created and deleted, and in which lock state;
 *   how many times a lease ref is advanced (left out of concurrent scenarios,
 *   where it varies with timing in today's ledger).
 * Counts of the JavaScript ledger's own file operations are not compared
 * (auditNotes).
 */
export function compareRefMoves({ movesA, movesB, a, b, identities, maskers, differences, objectPairs, concurrent = false, seeded = false }) {
  for (const [name, moves] of [['A', movesA], ['B', movesB]]) {
    for (const [root, { state }] of Object.entries(moves)) {
      const bad = state.filter((move) => move.code === 0 && (lockState(move.lockBefore, move.pid) !== 'held' || lockState(move.lockAfter, move.pid) !== 'held'));
      if (bad.length) differences.add('lock', `run ${name} ledger ${root.slice(0, 12)}…`, `${bad.length} of ${state.length} moves of refs/devryan/state not under owner.lock held by the moving process (before/after: ${[...new Set(bad.map((move) => `${lockState(move.lockBefore, move.pid)}/${lockState(move.lockAfter, move.pid)}`))].join(', ')})`);
      // The lock file's bytes, each on its own against the documented format.
      const masker = maskers?.[name === 'A' ? 'a' : 'b'];
      const problems = [...new Set(state.flatMap((move) => [...lockProblems(move.lockBefore, move.pid, masker), ...lockProblems(move.lockAfter, move.pid, masker)]))];
      if (problems.length) differences.add('lock', `run ${name} ledger ${root.slice(0, 12)}… owner.lock bytes`, problems.slice(0, 4).join('; '));
    }
  }
  // The lock bytes of each state move, A against B, field for field.
  for (const root of new Set([...Object.keys(movesA), ...Object.keys(movesB)])) {
    if (!maskers) break;
    const shapes = (moves, masker) => (moves[root]?.state ?? []).filter((move) => move.code === 0).map((move) => `${lockShape(move.lockBefore, masker)} | ${lockShape(move.lockAfter, masker)}`);
    const found = firstDifference(shapes(movesA, maskers.a), shapes(movesB, maskers.b), 'owner.lock at each state move');
    if (found) differences.add('lock', `ledger ${root.slice(0, 12)}… owner.lock bytes`, found);
  }
  for (const root of new Set([...Object.keys(movesA), ...Object.keys(movesB)])) {
    const where = `ledger ${root.slice(0, 12)}…`;
    const stateA = (movesA[root]?.state ?? []).filter((move) => move.code === 0), stateB = (movesB[root]?.state ?? []).filter((move) => move.code === 0);
    if (stateA.length !== stateB.length) differences.add('history', `${where} refs/devryan/state`, { a: `${stateA.length} moves`, b: `${stateB.length} moves` });
    const ledgerA = a.ledgers[root], ledgerB = b.ledgers[root];
    if (ledgerA && ledgerB) {
      const reachedA = new Set(), reachedB = new Set();
      const whereGit = (detail) => `${where}: ${detail}`;
      for (let index = 0; index < Math.min(stateA.length, stateB.length); index += 1) {
        const idA = stateA[index].deleting ? null : stateA[index].values[0], idB = stateB[index].deleting ? null : stateB[index].values[0];
        if (!idA || !idB) { if (Boolean(idA) !== Boolean(idB)) differences.add('history', `${where} refs/devryan/state@{${index}}`, { a: idA ?? 'deleted', b: idB ?? 'deleted' }); continue; }
        if (!ledgerA.objects.has(idA) || !ledgerB.objects.has(idB)) {
          if (ledgerA.objects.has(idA) !== ledgerB.objects.has(idB)) differences.add('history', `${where} refs/devryan/state@{${index}}`, `tree pruned in run ${ledgerA.objects.has(idA) ? 'B' : 'A'} only`);
          continue;
        }
        compareObject({ idA, idB, path: `refs/devryan/state@{${index}}`, ledgerA, ledgerB, identities, maskers, differences, objectPairs, reachedA, reachedB, where: whereGit, seeded });
      }
    }
    const leases = (moves) => {
      const counts = {};
      for (const move of moves[root]?.leases ?? []) {
        if (move.code !== 0) continue;
        const zero = /^0+$/.test(move.values[1] ?? '');
        const kind = move.deleting ? 'delete' : zero ? 'create' : 'advance';
        if (kind === 'advance' && concurrent) continue;
        const key = `${kind} lock ${lockState(move.lockBefore, move.pid)}`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
      return Object.fromEntries(Object.entries(counts).sort(([x], [y]) => x.localeCompare(y)));
    };
    const found = firstDifference(leases(movesA), leases(movesB), 'lease refs');
    if (found) differences.add('history', `${where} lease refs`, found);
    // M7: in concurrent scenarios a lease's snapshot ref is advanced outside the
    // owner lock a varying number of times (today's ledger): characterised, not compared.
    if (concurrent) {
      const advances = (moves) => (moves[root]?.leases ?? []).filter((move) => move.code === 0 && !move.deleting && !/^0+$/.test(move.values[1] ?? '')).length;
      differences.note(`${where} lease-ref advances outside owner.lock (characterisation)`, { a: advances(movesA), b: advances(movesB) });
    }
  }
}

/**
 * Which records each move of the state ref changed, in order: the order in
 * which a run's concurrent calls committed, from its own Git history (the
 * shim's moves and the trees they name). Names are written in run B's terms
 * where `identities` knows them, other identifiers and digests masked.
 */
export async function commitSignature({ moves, storageDir, map = (text) => text, runGit }) {
  const signature = [];
  for (const [root, { state }] of Object.entries(moves).sort(([x], [y]) => x.localeCompare(y))) {
    for (const move of state.filter((entry) => entry.code === 0 && !entry.deleting)) {
      const [next, previous] = move.values;
      const zero = !previous || /^0+$/.test(previous);
      const listed = zero ? await runGit(['--git-dir', path.join(storageDir, root, 'git'), 'ls-tree', '-r', '--name-only', next])
        : await runGit(['--git-dir', path.join(storageDir, root, 'git'), 'diff-tree', '-r', '--name-only', '--no-commit-id', previous, next]);
      // The records that say whose work a commit was: sessions, calls and
      // prompts (keyed by the scenario's own IDs) and leases (by tokens the
      // results taught). Other names follow random identifiers and are left out.
      const names = listed.stdout.toString().split('\n').filter((name) => /^(?:sessions|calls|prompts|leases)\//.test(name)).map((name) => map(name)).sort();
      signature.push(`${root.slice(0, 8)} ${names.join(',')}`);
    }
  }
  return signature;
}

/**
 * The JavaScript preload's own audit (ledger-preload.cjs), when both runs had
 * it: how often each point was reached, per lock state. JavaScript-only (a
 * ledger that batches writes or skips a temporary reaches them differently),
 * so reported as notes, never as differences.
 */
export function auditNotes({ auditA, auditB, differences }) {
  const parse = (text) => text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const census = (events) => {
    const counts = {};
    for (const event of events) {
      const ref = event.ref ? ` ${event.ref.replace(/[0-9a-f-]{36}$/, '<lease>')}` : '';
      const key = `${event.point}${ref}${event.lock === undefined ? '' : ` lock:${event.lock.startsWith('other:') ? 'other' : event.lock}`}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(counts).sort(([x], [y]) => x.localeCompare(y)));
  };
  const a = census(parse(auditA)), b = census(parse(auditB));
  const found = firstDifference(a, b, 'points');
  if (found) differences.note('JavaScript audit points (not compared)', found);
  return { census: a };
}

/**
 * Stored stamps the harness's observations cannot account for, in each run,
 * by where they were stored: counted and compared. A location where run B
 * stores more of them than run A is a finding; one where run A has them is
 * listed in the notes with its count (the waiver is explicit, never silent).
 */
export function compareUnaccounted({ maskers, differences }) {
  const count = (list) => { const counts = {}; for (const { where } of list) counts[where] = (counts[where] ?? 0) + 1; return counts; };
  const a = count(maskers.a.unaccounted), b = count(maskers.b.unaccounted);
  for (const where of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if ((b[where] ?? 0) > (a[where] ?? 0)) differences.add('stamp', where, `${b[where]} stored stamps match no observation of the harness in run B, ${a[where] ?? 0} in run A`);
  }
  if (maskers.a.unaccounted.length || maskers.b.unaccounted.length) differences.note('stamps no observation accounts for (counted waiver)', { a: a, b: b });
  return { a: maskers.a.unaccounted.length, b: maskers.b.unaccounted.length };
}
