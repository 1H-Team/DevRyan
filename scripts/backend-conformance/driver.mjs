// The scenario driver (BH2; design file 31 §5.3, §5.4, §5.6): runs one
// scenario against one arm and records every step. It judges nothing: a
// recording is the input of the comparer (BH3) and the closure check (BH4),
// and with no comparer every recorded row is inconclusive, "awaiting
// comparison" (rowsFromRecording); no path here makes a row passed.
//
// One exchange, as §5.3 has it, for every arm alike:
//   1. hold a descriptor on every regular file of the data root (the inode rule);
//   2. note t0, send, read the response to its end, note t1;
//   3. freeze the arm's process group (SIGSTOP), take S1 (a consistent walk and the
//      files the arm holds open), continue it (SIGCONT, on every path);
//   4. ask the arm for its quiescence claim on the exchange; the claim must name the
//      exchange and say quiescent;
//   5. freeze again, take S2 and the files the arm still holds open (any is a false
//      claim), continue it; release the descriptors (replaced and removed files).
// The claim is never taken on trust: before the next step (and once more after the
// arm stopped at the end) the driver opens an idle connection to the arm's listen port,
// asks the claim again and takes a snapshot, which must equal S2; a change is a late
// effect of the exchange that claimed quiescence. What that window cannot separate:
// work the arm defers until it receives the next *request* (or runs on a timer that
// fires after the snapshot) lands inside the next step, together with that step's own
// effects; the driver cannot tell the two apart, so every step's record says which
// step would absorb such work (`lateUntil`) and only the comparer (this step's S2
// against the reference's) can find it.
//
// The tracked roots are the data root and the arm's HOME (a directory of the run):
// both are held, frozen, walked and compared. Every arm group (and any descendant
// that leaves it) is handed to the keeper and recorded in the run before the arm can
// be frozen (arm-groups.mjs), so a harness killed by SIGKILL leaves nothing stopped.
//
// Restarts and kills (§5.4) verify that nothing of the old process survives: once the
// arm's process has exited, its process group must hold no live process. Every wait
// has a deadline that names what did not answer. The driver's own teardown (every
// group it started SIGCONTed and SIGKILLed, every connection closed, every held
// descriptor released) runs at process exit and from interruptTeardown(), which the
// run root calls on SIGINT, SIGTERM and SIGHUP before it removes the scratch.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { forgetRecord, keepRecord, killRecorded, processFacts, recordFor } from './arm-groups.mjs';
import { openExchange, sseItems } from './http-exchange.mjs';
import { HARNESS_HEADERS, PRINCIPALS, createSuppliedValues, envelopeFor, validateSteps } from './scenario.mjs';
import {
  DeadlineError, copyTree, escapedDescendants, groupGone, groupMembers, liveOnly, holdDescriptors, openFilesUnder, releaseAllHeld, restoreTree, signalGroup,
  snapshotTree, treeChanges, treeFingerprint, whileFrozen,
} from './tree.mjs';

export const DRIVER_LIMITS = Object.freeze({ exchangeMs: 120_000, quiescentMs: 120_000, freezeMs: 60_000, goneMs: 60_000, barrierMs: 120_000, streamEndMs: 120_000, streamMs: 600_000, keeperMs: 60_000, connectMs: 60_000, headMs: 120_000 });

/** The named checks a recording can report; every problem names one. */
export const CHECKS = Object.freeze({
  deadline: 'a wait passed its deadline (the problem names what did not answer)',
  'arm-start': 'the arm did not start (a step after a failed start is not run)',
  keeper: 'the arm\'s process group could not be handed to the keeper or recorded in the run (a harness killed now would leave it)',
  'group-escaped': 'a descendant of the arm left its process group (the problem names its pid and command): it escapes the freeze and the survivor check, and it is killed when the arm stops',
  concurrency: 'a concurrent step\'s members did not overlap on the wire (one was sent after another\'s answer began)',
  'step-error': 'the harness could not perform the step as written (an external change, a walk, a kill that was not SIGKILL); the problem names the error',
  'stream-truncated': 'the arm ended a stream before the scenario did (before a barrier was reached, or before the client closed it)',
  'arm-died': 'the arm\'s process exited when the driver had not stopped it',
  'response-incomplete': 'the response was not read to its end',
  correlation: 'the reference\'s tap has no record of the exchange the driver made',
  'claim-seq': 'the quiescence answer names another exchange',
  quiescence: 'the arm did not claim quiescence',
  'late-effect': 'a tracked root changed after the arm claimed quiescence and before the next step (the claim asked again, an idle listen connection opened), or the claim was withdrawn; work deferred until the next request lands in that request\'s step (see lateUntil)',
  'final-tree': 'a tracked root changed between the last step and the arm\'s exit',
  'open-files': 'the arm holds a file of a tracked root open after it claimed quiescence',
  'held-descriptors': 'the driver still holds descriptors after a step',
  'snapshot-unstable': 'two walks of the tracked roots disagreed while nothing could write',
  freeze: 'the arm\'s process group could not be frozen or continued',
  'stream-trailing': 'items arrived after the stream\'s last barrier and before the client closed it (recorded; the barrier must be at the stream\'s end)',
  'stream-unclosed': 'a stream was still open when the scenario ended',
  'stop-escalated': 'the arm did not stop when asked; the driver signalled it',
  'group-survived': 'a process of the arm\'s group was alive after the arm exited',
  envelope: 'a field of the scenario\'s envelope (principal, assignment, peer, authorizationActive, originalUrl) is not what the reference\'s group saw, or the reference did not confirm it',
  'edge-expectation': 'the step says edge (or group), and the reference\'s tap says otherwise',
  'tap-marks': 'the tap marked the exchange (tail, blind, crossed, aborted, an incomplete request body) or wrote a late, unattributed or problem record',
  'body-has-stack': 'the group\'s body prints a stack (unrecordable: its text depends on the composition)',
  'not-linearisable': 'the reference\'s concurrent result is in no admissible serialisation',
  restore: 'restoring a tree for the admissible serialisations did not give the tree back',
  'principal-unavailable': 'the arm cannot be given the step\'s principal',
});
/** Checks that, on a candidate arm, are the candidate's fault (its row fails); the rest leave the row inconclusive. */
export const CANDIDATE_FAULTS = Object.freeze(new Set(['arm-start', 'arm-died', 'response-incomplete', 'claim-seq', 'quiescence', 'late-effect', 'final-tree', 'open-files', 'stream-trailing', 'stream-truncated', 'stop-escalated', 'group-survived', 'group-escaped']));
/** Checks that make a reference row unrecordable rather than inconclusive. */
export const UNRECORDABLE = Object.freeze(new Set(['body-has-stack', 'not-linearisable']));
export const AWAITING = 'comparison';

// ------------------------------------------------------------------ teardown
const live = { groups: new Map(), exchanges: new Set(), escaped: new Map() };
const quietly = (action) => { try { action(); } catch { /* gone */ } };
/** Synchronously continues and kills every group the driver started (and every escaped descendant it saw), closes its connections and releases held descriptors. */
export function teardownNow() {
  for (const pgid of live.groups.keys()) { quietly(() => signalGroup(pgid, 'SIGCONT')); quietly(() => signalGroup(pgid, 'SIGKILL')); }
  for (const record of live.escaped.values()) quietly(() => killRecorded(record, { deadlineMs: 2_000 }));
  live.escaped.clear();
  for (const open of live.exchanges) quietly(() => open.close());
  live.exchanges.clear();
  releaseAllHeld();
}
process.on('exit', teardownNow);
/** The interrupt teardown (the run root's onInterrupt): kills every group and waits, bounded, until each is gone. */
export async function interruptTeardown() {
  const groups = [...live.groups.keys()];
  teardownNow();
  await Promise.all(groups.map((pgid) => groupGone(pgid, { deadlineMs: DRIVER_LIMITS.goneMs }).catch(() => {})));
  for (const pgid of groups) live.groups.delete(pgid);
}
/** Process groups the driver has started and not yet seen gone (for tests and teardown). */
export const liveGroups = () => [...live.groups.keys()];

// ------------------------------------------------------------------ helpers
const permutations = (list) => (list.length <= 1 ? [list] : list.flatMap((item, index) => permutations([...list.slice(0, index), ...list.slice(index + 1)]).map((rest) => [item, ...rest])));
const b64 = (buffer) => (buffer ? Buffer.from(buffer).toString('base64') : null);
const problem = (result, check, text) => {
  if (!Object.hasOwn(CHECKS, check)) throw new Error(`driver: unknown check ${check}`);
  result.problems.push({ check, text });
};
const errorText = (error) => (error instanceof DeadlineError ? error.message : String(error?.message ?? error));
/** The arm died under the driver during this step: said once per step. */
function noteDeath(ctx, result, what) {
  ctx.dead = true;
  if (!result.problems.some((entry) => entry.check === 'arm-died')) problem(result, 'arm-died', what);
}
const liveMembers = (pgid) => liveOnly(groupMembers(pgid));
/** The arm has died under the driver: flagged by its exit, or its group has no live member left. */
const armGone = (ctx) => ctx.dead || !ctx.proc || liveMembers(ctx.proc.pgid).length === 0;
/** `promise`, or `fallback` once `ms` passed (the timer is cleared when the promise settles first). */
const withDeadline = (promise, ms, fallback) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => resolve(fallback), ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});

function newContext({ scenario, arm, run, label, limits, hooks }) {
  return { scenario, arm, run, label, limits, hooks, trace: [], seq: 0, proc: null, processes: [], dead: false, stopping: false, last: null, streams: new Map(), processSeqs: [], starts: 0, held: new Set(), escaped: new Map(), keys: new Map() };
}
const trace = (ctx, event) => { ctx.trace.push(event); };

async function startArm(ctx, result) {
  trace(ctx, 'start');
  ctx.starts += 1;
  let proc;
  try { proc = await ctx.arm.start({ dataRoot: ctx.dataRoot, home: ctx.home, stubs: ctx.stubUrls }); } catch (error) {
    problem(result, 'arm-start', errorText(error));
    ctx.dead = true;
    return false;
  }
  live.groups.set(proc.pgid, ctx.label);
  ctx.proc = proc;
  ctx.processes.push({ pid: proc.pid, pgid: proc.pgid, listen: proc.listen });
  // Before the arm can be frozen: its group recorded in the run and held by the keeper (arm-groups.mjs).
  trace(ctx, 'keep');
  try { ctx.keys.set(proc.pgid, await keepRecord(ctx.run, recordFor({ kind: 'arm', pid: proc.pid, pgid: proc.pgid, marker: ctx.dataRoot, label: ctx.label }), { deadlineMs: ctx.limits.keeperMs })); } catch (error) { problem(result, 'keeper', errorText(error)); }
  ctx.armValues.port(`listen.${ctx.starts}`, proc.listen);
  ctx.dead = false;
  ctx.stopping = false;
  ctx.processSeqs = [];
  ctx.tapSeen = 0;
  await ctx.hooks.afterStart?.({ ctx, proc });
  const current = proc;
  ctx.arm.exited.then(() => { if (ctx.proc === current && !ctx.stopping) ctx.dead = true; });
  return true;
}

/** Stops (or kills) the arm and verifies that nothing of its process group survives. */
async function stopArm(ctx, result, { kill = false } = {}) {
  if (!ctx.proc) return;
  const { pgid } = ctx.proc;
  if (ctx.arm.capabilities.tap && !ctx.dead) tapNews(ctx, result);
  if (!ctx.dead) await checkEscapes(ctx, result, kill ? 'before the kill' : 'before the stop');
  ctx.stopping = true;
  if (kill || ctx.dead) {
    trace(ctx, 'kill');
    quietly(() => signalGroup(pgid, 'SIGCONT'));
    quietly(() => signalGroup(pgid, 'SIGKILL'));
    await ctx.arm.exited;
  } else {
    trace(ctx, 'stop');
    const exit = await ctx.arm.stop();
    if (exit.escalated) problem(result, 'stop-escalated', `the arm did not stop when asked; it was stopped by ${exit.escalated}`);
  }
  // Once the arm has exited after a stop it was asked for, its group must hold no live process
  // (after a kill the whole group was signalled at once, so the members are waited for below).
  const survivors = kill || ctx.dead ? [] : liveMembers(pgid);
  if (survivors.length) {
    problem(result, 'group-survived', `process group ${pgid} still had ${survivors.map((member) => `pid ${member.pid}`).join(', ')} after the arm exited; they were killed`);
    quietly(() => signalGroup(pgid, 'SIGCONT'));
    quietly(() => signalGroup(pgid, 'SIGKILL'));
  }
  try { await groupGone(pgid, { deadlineMs: ctx.limits.goneMs }); live.groups.delete(pgid); if (ctx.keys.has(pgid)) { forgetRecord(ctx.keys.get(pgid)); ctx.keys.delete(pgid); } } catch (error) { problem(result, 'deadline', errorText(error)); }
  killEscaped(ctx, result);
  trace(ctx, 'gone');
  ctx.proc = null;
}

/** Descendants of the arm outside its group (each reported once, kept by the keeper and killed when the arm stops). */
async function checkEscapes(ctx, result, what, table = undefined) {
  if (!ctx.proc) return;
  const found = escapedDescendants(ctx.proc.pgid, table).filter((row) => !ctx.escaped.has(row.pid));
  if (found.length === 0) return;
  const facts = processFacts(found.map((row) => row.pid));
  for (const row of found) {
    const command = facts.get(row.pid)?.command ?? '(gone)';
    problem(result, 'group-escaped', `${what}: pid ${row.pid} (${command.slice(0, 200)}), a descendant of the arm, is in process group ${row.pgid}, not the arm's ${ctx.proc.pgid}; it was killed when the arm stopped`);
    let record;
    try { record = recordFor({ kind: 'escaped', pid: row.pid, pgid: row.pgid === row.pid ? row.pid : null, marker: command, label: ctx.label }); } catch { continue; }
    ctx.escaped.set(row.pid, record);
    live.escaped.set(row.pid, record);
    try { ctx.keys.set(`escaped:${row.pid}`, await keepRecord(ctx.run, record, { deadlineMs: ctx.limits.keeperMs })); } catch (error) { problem(result, 'keeper', errorText(error)); }
  }
}
function killEscaped(ctx, result) {
  for (const [pid, record] of ctx.escaped) {
    if (killRecorded(record, { deadlineMs: ctx.limits.goneMs }) === 'survived') problem(result, 'deadline', `the escaped process ${pid} still ran ${ctx.limits.goneMs} ms after it was killed`);
    live.escaped.delete(pid);
    const key = ctx.keys.get(`escaped:${pid}`);
    if (key) { forgetRecord(key); ctx.keys.delete(`escaped:${pid}`); }
  }
  ctx.escaped.clear();
}

/** Descriptors held on the data root for one exchange (§5.3 step 1), counted per scenario run. */
function hold(ctx) {
  const held = holdDescriptors([ctx.dataRoot, ctx.home]);
  ctx.held.add(held);
  return { get size() { return held.size; }, release: () => { const released = held.release(); ctx.held.delete(held); return released; } };
}
/** A snapshot with the arm frozen: the walk, its stability, and the files the arm holds open. */
async function frozenSnapshot(ctx, result, what) {
  if (ctx.dead || !ctx.proc) { if (ctx.dead && !ctx.stopping) noteDeath(ctx, result, `${what}: the arm is gone`); return null; }
  const { pgid } = ctx.proc;
  trace(ctx, 'freeze');
  let walkFailed = null;
  try {
    const tree = await whileFrozen(pgid, async (members) => {
      await ctx.hooks.afterFreeze?.({ ctx, what, pgid });
      trace(ctx, what);
      if (members.length === 0) return null; // nothing left to freeze: the arm died (below)
      await checkEscapes(ctx, result, what, members.table);
      try { return trackedSnapshot(ctx, result, what, members.map((member) => member.pid)); } catch (error) { walkFailed = error; return null; }
    }, { deadlineMs: ctx.limits.freezeMs });
    if (walkFailed) problem(result, 'step-error', `${what}: the walk of the tracked roots failed: ${errorText(walkFailed)}`);
    else if (!tree) noteDeath(ctx, result, `${what}: the arm's process group has no live process left`);
    return tree;
  } catch (error) {
    // A group that is gone has died under the driver: that is the arm's exit, not a failed freeze.
    if (armGone(ctx)) noteDeath(ctx, result, `${what}: the arm's process group is gone`); else problem(result, 'freeze', `${what}: ${errorText(error)}`);
    return null;
  } finally { trace(ctx, 'thaw'); }
}
/** The walk of both tracked roots and the files `pids` hold open under them. */
function trackedSnapshot(ctx, result, what, pids) {
  const tree = snapshotTree(ctx.dataRoot, { others: { home: ctx.home } });
  if (!tree.stable) problem(result, 'snapshot-unstable', `${what}: the two walks of the tracked roots disagree${pids.length ? '' : ' with the arm gone'}`);
  markEdge(ctx, tree);
  const roots = [['', fs.realpathSync(ctx.dataRoot)], ['home:', fs.realpathSync(ctx.home)]];
  const label = (file) => { for (const [prefix, root] of roots) if (file === root || file.startsWith(`${root}${path.sep}`)) return `${prefix}${path.relative(root, file) || '.'}`; return file; };
  return { ...tree, openByArm: openFilesUnder(pids, [ctx.dataRoot, ctx.home]).map(({ pid, file }) => ({ pid, file: label(file) })) };
}
/** Marks the entries the arm's edge writes (they are not the group's). */
function markEdge(ctx, tree) { const edge = new Set(ctx.arm.capabilities.edgeFiles ?? []); for (const entry of tree.entries) if (edge.has(entry.path)) entry.edge = true; }
/** The fingerprint of the group's part of a tree (the edge's files left out). */
const groupFingerprint = (tree) => treeFingerprint({ entries: tree.entries.filter((entry) => !entry.edge), order: Object.fromEntries(Object.entries(tree.order).map(([dir, names]) => [dir, dir === '.' ? names.filter((name) => !tree.entries.some((entry) => entry.edge && entry.path === name)) : names])), roots: tree.roots });
/** A snapshot of trees no process can change (the arm gone); a walk that fails is a problem of the step. */
function restingSnapshot(ctx, result, what) {
  trace(ctx, what);
  try { return trackedSnapshot(ctx, result, what, []); } catch (error) { problem(result, 'step-error', `${what}: the walk of the tracked roots failed: ${errorText(error)}`); return null; }
}

/** The request on the wire for a step's spec: the principal's own headers added (as the client would send them). */
function launch(ctx, spec, hooks = {}) {
  const principal = ctx.scenario.principals[spec.principal] ?? PRINCIPALS[spec.principal];
  const seq = ++ctx.seq;
  const request = { method: spec.method, target: spec.target, headers: [...spec.headers, ...principal.headers], body: spec.body?.bytes ?? null };
  const envelope = ctx.arm.capabilities.envelope ? envelopeFor(principal, { originalUrl: spec.target, seq }) : null;
  const wire = ctx.arm.prepare(request, { seq, envelope });
  const open = openExchange(ctx.proc.listen, wire, { deadlineMs: hooks.deadlineMs ?? ctx.limits.exchangeMs, ...hooks });
  live.exchanges.add(open);
  open.done.then(() => live.exchanges.delete(open));
  return { open, seq, envelope, uses: ctx.values.usedIn(Buffer.concat([Buffer.from(spec.target), request.body ?? Buffer.alloc(0)])) };
}
/** Why a spec is not sent to this arm, or null. */
function notSent(ctx, spec) {
  // An edge exchange is never a candidate's, whatever its principal.
  if (spec.edge && ctx.arm.role === 'candidate') return { check: null, text: 'an edge exchange: recorded on the reference only, never sent to a candidate (design §2.1)' };
  if (!ctx.arm.capabilities.principals.has(spec.principal)) return { check: 'principal-unavailable', text: `the ${ctx.arm.role} arm cannot be given principal ${spec.principal}${PRINCIPALS[spec.principal]?.reference === null ? ' (managed principals need the Supabase-backed runtime: design §6, pilot scope)' : ''}` };
  return null;
}
const responseRecord = (response) => ({
  localPort: response.localPort, t0: response.t0, t1: response.t1, sentOrder: response.sentOrder, firstByteOrder: response.firstByteOrder, error: response.error, request: response.request,
  status: response.status, reason: response.reason, httpVersion: response.httpVersion, headers: response.headers, head: response.head, interim: response.interim, trailers: response.trailers,
  body: b64(response.body), complete: response.complete, bytesAfterResponse: response.bytesAfterResponse,
});
function responseChecks(result, response, what) {
  if (response.deadline) problem(result, 'deadline', `${what}: ${response.error}`);
  else if (response.error) problem(result, 'response-incomplete', `${what}: ${response.error}`);
  else if (!response.complete) problem(result, 'response-incomplete', `${what}: the connection closed before the response was complete`);
}

/** The arm's claim on one exchange, checked: it must name the exchange and say quiescent. */
async function claim(ctx, result, armSeq, what) {
  if (ctx.dead || armSeq === null) return null;
  trace(ctx, `quiescent:${armSeq}`);
  let answer;
  try { answer = await ctx.arm.quiescent(armSeq, ctx.limits.quiescentMs); } catch (error) {
    if (error instanceof DeadlineError) problem(result, 'deadline', `${what}: ${errorText(error)}`);
    else if (await exitedSoon(ctx)) noteDeath(ctx, result, `${what}: the arm exited before it answered its quiescence claim (${errorText(error)})`);
    else problem(result, 'quiescence', `${what}: the quiescence call failed with the arm alive: ${errorText(error)}`);
    return null;
  }
  if (answer.seq !== armSeq) problem(result, 'claim-seq', `${what}: asked about exchange ${armSeq}, the answer names ${JSON.stringify(answer.seq)}`);
  if (answer.quiescent !== true) problem(result, 'quiescence', `${what}: not quiescent; pending ${JSON.stringify(answer.pending ?? []).slice(0, 400)}`);
  return answer;
}

/**
 * After a control call failed with no answer at all (a refused or reset
 * connection): whether the arm's process has exited. The process's exit is
 * waited for (bounded by goneMs, which an exiting process never needs), so a
 * process that is dying but still listed is not taken for a live one.
 */
async function exitedSoon(ctx) {
  if (ctx.dead || !ctx.proc) return true;
  const exited = await withDeadline(Promise.resolve(ctx.arm.exited).then(() => true), ctx.limits.goneMs, false);
  return exited || armGone(ctx);
}

/** What the reference's tap says about one exchange: its record, and the checks it implies. */
function tapChecks(ctx, result, armSeq, spec, recordsNow) {
  if (!ctx.arm.capabilities.tap || armSeq === null) return null;
  const record = recordsNow.find((entry) => entry.type === 'exchange' && entry.seq === armSeq);
  if (!record) { problem(result, 'correlation', `the tap wrote no exchange record for exchange ${armSeq}`); return null; }
  const isGroup = record.kind === 'group';
  if (record.kind === 'tail') problem(result, 'tap-marks', `exchange ${armSeq} was answered by the tail stand-in`);
  if (spec.edge === isGroup && record.kind !== 'tail') problem(result, 'edge-expectation', `the step says ${spec.edge ? 'edge' : 'group'}; the tap says ${record.kind}`);
  if (isGroup) {
    if (record.blind?.length) problem(result, 'tap-marks', `exchange ${armSeq} has blind marks ${JSON.stringify(record.blind)}`);
    if (record.crossed?.length) problem(result, 'tap-marks', `exchange ${armSeq} is crossed ${JSON.stringify(record.crossed)}`);
    if (record.aborted) problem(result, 'tap-marks', `exchange ${armSeq} was aborted`);
    if (record.request?.bodyComplete === false) {
      // The group answered before the body arrived and nothing had read it (no parser, no consumer): the body
      // could not reach the group, and the bytes are known (the driver sent them). A fact of the exchange, not a blind spot.
      const unread = !record.aborted && record.response && record.entry?.bodyParsedByEdge === false && record.entry?.bodyConsumedBeforeEntry === false;
      if (unread) result.requestBodyUnread = { seq: armSeq, sentBytes: spec.body?.bytes.length ?? 0, seenByTap: Buffer.from(record.request.body ?? '', 'base64').length };
      else problem(result, 'tap-marks', `exchange ${armSeq}: the request body was not complete`);
    }
    if (record.response?.bodyHasStack) problem(result, 'body-has-stack', `exchange ${armSeq}: the group's body prints a stack`);
    envelopeChecks(result, armSeq, PRINCIPALS[spec.principal]?.envelope, spec, record.entry);
  }
  return record;
}
/**
 * Every field of the envelope against what the reference's group saw at its
 * entry (the tap's entry and the host's reading of the request's context): a
 * field that differs, or that the record does not carry, is an `envelope`
 * problem. The envelope is harness input; this is what makes it the
 * reference's (design §6).
 */
export const ENVELOPE_FIELDS = Object.freeze(['principal', 'assignment', 'peer', 'authorizationActive', 'originalUrl']);
function envelopeChecks(result, armSeq, expected, spec, entry) {
  if (!expected) return;
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const context = entry?.context ?? null;
  const seen = {
    principal: entry ? entry.principal ?? null : undefined,
    assignment: context && Object.hasOwn(context, 'assignment') ? context.assignment : undefined,
    peer: context && Object.hasOwn(context, 'peer') ? context.peer : undefined,
    authorizationActive: context && typeof context.authorizationActive === 'boolean' ? context.authorizationActive : undefined,
    originalUrl: entry ? entry.originalUrl : undefined,
  };
  const wanted = { ...expected, originalUrl: spec.target };
  for (const field of ENVELOPE_FIELDS) {
    if (seen[field] === undefined) problem(result, 'envelope', `exchange ${armSeq}: the reference does not confirm the envelope's ${field} (its record carries no ${field})`);
    else if (!same(seen[field], wanted[field])) problem(result, 'envelope', `exchange ${armSeq}: the group saw ${field} ${JSON.stringify(seen[field]).slice(0, 300)}, the envelope says ${JSON.stringify(wanted[field]).slice(0, 300)}`);
  }
  if (context && context.storePrincipalIsRequestPrincipal !== true) problem(result, 'envelope', `exchange ${armSeq}: the request-context store does not hold the request's principal`);
}

/** Tap records that must never pass silently (late, unattributed, problem, a blind mark after the exchange), new since the last look. */
function tapNews(ctx, result) {
  if (!ctx.arm.capabilities.tap || !ctx.proc) return;
  const records = ctx.arm.records();
  const fresh = records.slice(ctx.tapSeen ?? 0);
  ctx.tapSeen = records.length;
  for (const record of fresh) {
    if (['late', 'unattributed', 'problem'].includes(record.type)) problem(result, 'tap-marks', `a ${record.type} record: ${JSON.stringify(record).slice(0, 300)}`);
    if (record.type === 'blind') problem(result, 'tap-marks', `a blind mark after exchange ${record.seq}: ${record.kind} ${record.site}`);
  }
}

// ------------------------------------------------------------------ the next-step check
/** Asks the previous claim again and takes a snapshot that must equal the last one. */
/** An idle connection to the arm's listen port, held open until `close()`: work deferred to the next connection runs now. */
async function idleConnection(ctx) {
  const socket = net.connect({ host: '127.0.0.1', port: ctx.proc.listen });
  socket.on('error', () => {});
  const connected = await withDeadline(new Promise((resolve) => { socket.once('connect', () => resolve(true)); socket.once('error', () => resolve(false)); }), ctx.limits.connectMs, null);
  return { connected, close: () => socket.destroy() };
}
/**
 * The next-step check: an idle connection to the listen port, the previous
 * claim asked again, then a snapshot that must equal the last one. `current`
 * is the step about to run (an arm that died since is its problem).
 */
async function recheck(ctx, current) {
  const last = ctx.last;
  if (!last || ctx.dead || !ctx.proc) return;
  trace(ctx, 'recheck');
  trace(ctx, 'connect');
  const idle = await idleConnection(ctx);
  try {
    if (idle.connected === null) problem(last.result, 'deadline', `the idle connection to the arm's listen port ${ctx.proc.listen} within ${ctx.limits.connectMs} ms`);
    if (last.armSeq !== null) {
      let answer = null;
      try { answer = await ctx.arm.quiescent(last.armSeq, ctx.limits.quiescentMs); } catch (error) {
        if (error instanceof DeadlineError) problem(last.result, 'deadline', `the second quiescence answer for exchange ${last.armSeq}: ${errorText(error)}`);
        else if (await exitedSoon(ctx)) { noteDeath(ctx, current, `the arm exited after step ${last.result.id} (the second quiescence call: ${errorText(error)})`); return; } else problem(last.result, 'quiescence', `the second quiescence call for exchange ${last.armSeq} failed with the arm alive: ${errorText(error)}`);
      }
      if (answer && answer.seq !== last.armSeq) problem(last.result, 'claim-seq', `asked again about exchange ${last.armSeq}, the answer names ${JSON.stringify(answer.seq)}`);
      else if (answer && answer.quiescent !== true) problem(last.result, 'late-effect', `asked again, the arm withdrew its quiescence claim on exchange ${last.armSeq}: ${JSON.stringify(answer).slice(0, 300)}`);
    }
    const snapshot = await frozenSnapshot(ctx, ctx.dead ? current : last.result, 'recheck');
    if (ctx.dead) { noteDeath(ctx, current, `the arm exited after step ${last.result.id}`); return; }
    if (!snapshot || !last.snapshot) return;
    const changes = treeChanges(last.snapshot, snapshot);
    if (changes.length) {
      problem(last.result, 'late-effect', `a tracked root changed after the quiescence claim: ${changes.join(', ')}`);
      last.result.lateTree = snapshot;
    }
    if (snapshot.openByArm.length) problem(last.result, 'open-files', `at the next step the arm still holds ${snapshot.openByArm.map((entry) => entry.file).join(', ')}`);
    ctx.last = { ...last, snapshot };
  } finally { idle.close(); }
}

// ------------------------------------------------------------------ steps
/** One exchange by §5.3. Returns the exchange's record (also pushed onto result.exchanges). */
async function singleExchange(ctx, result, spec, { member = null } = {}) {
  const skip = notSent(ctx, spec);
  if (skip) {
    const record = { member, notSent: skip.text };
    if (skip.check) problem(result, skip.check, skip.text);
    result.exchanges.push(record);
    return record;
  }
  trace(ctx, 'hold');
  const held = hold(ctx);
  try {
    const { open, seq, envelope, uses } = launch(ctx, spec);
    try { await open.connected; } catch { open.close(); }
    trace(ctx, 'send');
    open.send();
    const response = await open.done;
    trace(ctx, 'response');
    const record = { member, seq, envelope, uses, response: responseRecord(response) };
    result.exchanges.push(record);
    responseChecks(result, response, `${spec.method} ${spec.target}`);
    if (armGone(ctx)) { noteDeath(ctx, result, `the arm exited during ${spec.method} ${spec.target}`); return record; }
    record.s1 = await frozenSnapshot(ctx, result, 'S1');
    const armSeq = ctx.arm.seqFor(response, seq);
    record.armSeq = armSeq;
    if (armSeq === null) problem(result, 'correlation', `no tap record names the connection from local port ${response.localPort}`);
    else ctx.processSeqs.push(armSeq);
    record.claim = await claim(ctx, result, armSeq, `${spec.method} ${spec.target}`);
    record.s2 = await frozenSnapshot(ctx, result, 'S2');
    if (record.s2?.openByArm.length) problem(result, 'open-files', `after its quiescence claim the arm holds ${record.s2.openByArm.map((entry) => entry.file).join(', ')}`);
    record.tap = tapChecks(ctx, result, armSeq, spec, ctx.arm.records());
    if (record.s2) ctx.last = { result, snapshot: record.s2, armSeq };
    return record;
  } finally {
    trace(ctx, 'release');
    const released = held.release();
    const record = result.exchanges.at(-1);
    if (record && !record.notSent) Object.assign(record, released);
  }
}

/** Copies both tracked roots into a new directory of the run; returns where. */
function copyRoots(ctx, name) {
  const into = ctx.run.makeDirectory(`${ctx.label}/trees/${name}`);
  copyTree(ctx.dataRoot, path.join(into, 'data'));
  copyTree(ctx.home, path.join(into, 'home'));
  return into;
}
function restoreRoots(ctx, from) { restoreTree(path.join(from, 'data'), ctx.dataRoot); restoreTree(path.join(from, 'home'), ctx.home); }

async function concurrentStep(ctx, result, entry) {
  const members = entry.members.filter((member) => !notSent(ctx, member.request));
  for (const member of entry.members) { const skip = notSent(ctx, member.request); if (skip) { result.exchanges.push({ member: member.member, notSent: skip.text }); if (skip.check) problem(result, skip.check, skip.text); } }
  // A lone member is not sent either: a concurrent step is about the members together (said, never silent).
  if (members.length < 2) { for (const member of members) result.exchanges.push({ member: member.member, notSent: `the other members of concurrent step ${entry.id} cannot be sent to this arm, so this one is not sent alone` }); return; }
  const admissible = ctx.arm.capabilities.admissible;
  const before = admissible ? copyRoots(ctx, `${entry.id}-before`) : null;
  trace(ctx, 'hold');
  const held = hold(ctx);
  const launched = members.map((member) => ({ member, ...launch(ctx, member.request) }));
  try {
    await Promise.all(launched.map(({ open }) => open.connected.catch(() => {})));
    trace(ctx, 'send');
    for (const { open } of launched) open.send();
    const responses = await Promise.all(launched.map(({ open }) => open.done));
    trace(ctx, 'response');
    const records = launched.map(({ member, seq, envelope, uses }, index) => ({ member: member.member, seq, envelope, uses, response: responseRecord(responses[index]) }));
    result.exchanges.push(...records);
    responses.forEach((response, index) => responseChecks(result, response, `member ${launched[index].member.member}`));
    // The members overlapped on the wire: every request was handed to its socket before any answer began.
    const lastSent = Math.max(...responses.map((response) => response.sentOrder ?? Infinity));
    const firstAnswer = Math.min(...responses.map((response) => response.firstByteOrder ?? Infinity));
    result.overlap = { lastSent, firstAnswer };
    if (!(lastSent < firstAnswer)) problem(result, 'concurrency', `the members did not overlap: the last request was sent (wire event ${lastSent}) after the first answer began (wire event ${firstAnswer})`);
    if (armGone(ctx)) { noteDeath(ctx, result, 'the arm exited during a concurrent step'); return; }
    result.s1 = await frozenSnapshot(ctx, result, 'S1');
    for (const [index, record] of records.entries()) {
      record.armSeq = ctx.arm.seqFor(responses[index], record.seq);
      if (record.armSeq === null) problem(result, 'correlation', `no tap record names member ${record.member}'s connection`);
      else ctx.processSeqs.push(record.armSeq);
    }
    for (const record of records) record.claim = await claim(ctx, result, record.armSeq, `member ${record.member}`);
    result.s2 = await frozenSnapshot(ctx, result, 'S2');
    if (result.s2?.openByArm.length) problem(result, 'open-files', `after its quiescence claims the arm holds ${result.s2.openByArm.map((item) => item.file).join(', ')}`);
    const recordsNow = ctx.arm.records();
    records.forEach((record, index) => { record.tap = tapChecks(ctx, result, record.armSeq, members[index].request, recordsNow); });
    if (result.s2) ctx.last = { result, snapshot: result.s2, armSeq: records.at(-1).armSeq };
  } finally {
    trace(ctx, 'release');
    const released = held.release();
    result.replaced = released.replaced;
    result.removed = released.removed;
  }
  if (admissible && result.s2) await admissibleSet(ctx, result, entry, members, before);
}

/** §5.6: the reference once per order of the members, each from the tree before the step; its own result must be one of them. */
async function admissibleSet(ctx, result, entry, members, before) {
  const after = copyRoots(ctx, `${entry.id}-after`);
  const concurrentState = result.s2;
  const outcome = (records, tree) => JSON.stringify({ members: Object.fromEntries(records.map((record) => [record.member, { status: record.response.status, body: record.response.body }]).sort(([a], [b]) => a.localeCompare(b))), tree: groupFingerprint(tree) });
  const own = outcome(result.exchanges.filter((record) => !record.notSent), concurrentState);
  result.admissible = [];
  for (const order of permutations(members)) {
    trace(ctx, `order:${order.map((member) => member.member).join(',')}`);
    const serial = { order: order.map((member) => member.member), exchanges: [], problems: [] };
    await stopArm(ctx, serial);
    restoreRoots(ctx, before);
    if (!(await startArm(ctx, serial))) { result.admissible.push(serial); result.problems.push(...serial.problems); return; }
    for (const member of order) await singleExchange(ctx, serial, member.request, { member: member.member });
    serial.tree = serial.exchanges.at(-1)?.s2 ?? null;
    serial.outcome = serial.tree ? outcome(serial.exchanges, serial.tree) : null;
    result.admissible.push(serial);
    result.problems.push(...serial.problems.map((entryProblem) => ({ ...entryProblem, text: `order ${serial.order.join(',')}: ${entryProblem.text}` })));
  }
  await stopArm(ctx, result);
  restoreRoots(ctx, after);
  if (!(await startArm(ctx, result))) return;
  const back = await frozenSnapshot(ctx, result, 'restored');
  if (back && groupFingerprint(back) !== groupFingerprint(concurrentState)) problem(result, 'restore', 'the tree restored after the serialisations is not the concurrent step\'s S2');
  ctx.last = { result, snapshot: back, armSeq: null };
  if (!result.admissible.some((serial) => serial.outcome === own)) problem(result, 'not-linearisable', `the concurrent result is none of the ${result.admissible.length} serialisations`);
}

async function killAfterStep(ctx, result, entry) {
  const skip = notSent(ctx, entry.request);
  if (skip) { result.exchanges.push({ notSent: skip.text }); if (skip.check) problem(result, skip.check, skip.text); return; }
  const { pgid } = ctx.proc;
  let killed = false;
  const kill = () => { if (killed) return; killed = true; ctx.stopping = true; trace(ctx, 'kill'); quietly(() => signalGroup(pgid, 'SIGKILL')); };
  trace(ctx, 'hold');
  const held = hold(ctx);
  let record;
  try {
    const { open, seq, envelope, uses } = launch(ctx, entry.request, { onSent: () => { if (entry.point === 'request-sent') kill(); }, onHead: () => { if (entry.point === 'response-head') kill(); } });
    try { await open.connected; } catch { open.close(); }
    trace(ctx, 'send');
    open.send();
    const response = await open.done;
    trace(ctx, 'response');
    record = { seq, envelope, uses, point: entry.point, response: responseRecord(response) };
    result.exchanges.push(record);
    if (entry.point === 'response-end') { responseChecks(result, response, `${entry.request.method} ${entry.request.target}`); kill(); }
    kill();
    // The arm must have died by the kill (SIGKILL), not by a stop it could act on.
    const exit = await ctx.arm.exited;
    record.exit = { code: exit?.code ?? null, signal: exit?.signal ?? null };
    if (record.exit.signal !== 'SIGKILL') problem(result, 'step-error', `the kill-after step's arm exited with ${record.exit.signal ?? `code ${record.exit.code}`}, not by SIGKILL`);
    record.killedBeforeResponse = ctx.trace.lastIndexOf('kill') < ctx.trace.lastIndexOf('response');
    record.armSeq = ctx.arm.seqFor(response, seq);
    record.tap = ctx.arm.capabilities.tap && record.armSeq !== null ? ctx.arm.records().find((item) => item.type === 'exchange' && item.seq === record.armSeq) ?? null : null;
    result.nondeterministic = entry.point === 'response-end' ? null : `a kill at ${entry.point} races the arm: where it lands is the scheduler's (classified by a second reference, BH4)`;
    await stopArm(ctx, result, { kill: true });
    record.s1 = restingSnapshot(ctx, result, 'S1');
  } finally {
    trace(ctx, 'release');
    const released = held.release();
    if (record) Object.assign(record, released);
  }
  if (!(await startArm(ctx, result))) return;
  result.afterRestart = await frozenSnapshot(ctx, result, 'started');
  ctx.last = { result, snapshot: result.afterRestart, armSeq: null };
}

async function externalStep(ctx, result, { change }) {
  const target = path.join(ctx.dataRoot, ...change.path.split('/'));
  trace(ctx, `external:${change.op}`);
  // A change the tree no longer allows (a file the arm removed, a directory in the way) is the step's problem; the run goes on.
  try {
    if (change.op === 'write') { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, change.data, change.mode === undefined ? {} : { mode: change.mode }); if (change.mode !== undefined) fs.chmodSync(target, change.mode); }
    if (change.op === 'delete') fs.rmSync(target, { recursive: true });
    if (change.op === 'rename') fs.renameSync(target, path.join(ctx.dataRoot, ...change.to.split('/')));
    if (change.op === 'mkdir') fs.mkdirSync(target, { mode: change.mode ?? 0o755 });
    if (change.op === 'symlink') fs.symlinkSync(change.target, target);
    if (change.op === 'chmod') fs.chmodSync(target, change.mode);
  } catch (error) { problem(result, 'step-error', `the external ${change.op} of ${change.path}: ${errorText(error)}`); }
  result.tree = await frozenSnapshot(ctx, result, 'after');
  ctx.last = { result, snapshot: result.tree, armSeq: null };
}

const itemsOf = (stream) => sseItems(Buffer.concat(stream.bytes));
async function streamOpenStep(ctx, result, entry) {
  const stream = { name: entry.stream, bytes: [], barrier: 0, waiters: [], closed: false, head: null };
  const skip = notSent(ctx, entry.request);
  if (skip) { result.exchanges.push({ notSent: skip.text }); if (skip.check) problem(result, skip.check, skip.text); stream.closed = true; ctx.streams.set(entry.stream, stream); return; }
  let headArrived;
  const head = new Promise((resolve) => { headArrived = resolve; });
  const wake = () => { for (const waiter of [...stream.waiters]) waiter(); };
  const { open, seq, envelope, uses } = launch(ctx, entry.request, { deadlineMs: ctx.limits.streamMs, onHead: (value) => { stream.head = value; headArrived(); }, onBody: (bytes) => { stream.bytes.push(Buffer.from(bytes)); wake(); } });
  Object.assign(stream, { open, seq, envelope, uses, step: entry.id, result });
  ctx.streams.set(entry.stream, stream);
  open.done.then(() => { stream.ended = true; headArrived(); wake(); });
  try { await open.connected; } catch { open.close(); }
  trace(ctx, 'send');
  open.send();
  // The head has its own limit: a short barrier deadline (a test's item that never comes) must not bound a head that does come.
  const arrived = await withDeadline(head.then(() => true), ctx.limits.headMs, false);
  if (!arrived) problem(result, 'deadline', `stream ${entry.stream}: no response head within ${ctx.limits.headMs} ms`);
  result.exchanges.push({ seq, envelope, uses, stream: entry.stream, head: stream.head ? { status: stream.head.status, headers: stream.head.headers } : null });
}
async function waitForItems(ctx, stream, count) {
  for (;;) {
    if (itemsOf(stream).items.length >= count || stream.ended) return itemsOf(stream).items.length >= count;
    const ok = await withDeadline(new Promise((resolve) => { stream.waiters.push(() => resolve(true)); }), ctx.limits.barrierMs, false);
    stream.waiters.length = 0;
    if (!ok) return false;
  }
}
async function streamBarrierStep(ctx, result, entry) {
  const stream = ctx.streams.get(entry.stream);
  if (!stream?.open) return;
  trace(ctx, `barrier:${entry.items}`);
  if (!(await waitForItems(ctx, stream, entry.items))) {
    if (stream.ended) problem(result, 'stream-truncated', `stream ${entry.stream} ended after ${itemsOf(stream).items.length} items, before barrier ${entry.items}`);
    else problem(result, 'deadline', `stream ${entry.stream}: ${entry.items} items did not arrive within ${ctx.limits.barrierMs} ms (${itemsOf(stream).items.length} did)`);
  }
  const { items } = itemsOf(stream);
  result.items = items.slice(stream.barrier, entry.items);
  result.receivedAtBarrier = items.length;
  stream.barrier = entry.items;
  result.tree = await frozenSnapshot(ctx, result, 'barrier');
}
async function streamCloseStep(ctx, result, entry) {
  const stream = ctx.streams.get(entry.stream);
  if (!stream?.open) { if (stream) stream.closed = true; return; }
  let response;
  if (entry.by === 'client') {
    const { items, rest } = itemsOf(stream);
    const trailing = items.slice(stream.barrier);
    result.trailing = trailing;
    result.partial = rest;
    if (trailing.length || rest.length) problem(result, 'stream-trailing', `stream ${entry.stream}: ${trailing.length} items and ${rest.length} bytes arrived after barrier ${stream.barrier}`);
    // The client closes a stream that is still open; one the arm already ended (cut off or finished) is reported.
    const endedFirst = stream.ended;
    trace(ctx, 'close');
    stream.open.close();
    response = await stream.open.done;
    stream.closed = true;
    result.endedBeforeClose = endedFirst;
    if (endedFirst) problem(result, 'stream-truncated', `stream ${entry.stream} was ${response.complete ? 'ended' : 'cut off'} by the arm before the client closed it${response.error ? ` (${response.error})` : ''}`);
  } else {
    trace(ctx, 'await-end');
    const ended = await withDeadline(stream.open.done, ctx.limits.streamEndMs, null);
    if (!ended) { problem(result, 'deadline', `stream ${entry.stream} did not end within ${ctx.limits.streamEndMs} ms`); return; }
    response = ended;
    stream.closed = true;
    const { items, rest } = itemsOf(stream);
    result.itemsToEnd = items.slice(stream.barrier);
    result.partial = rest;
    responseChecks(result, response, `stream ${entry.stream}`);
  }
  result.exchanges.push({ seq: stream.seq, stream: entry.stream, response: responseRecord(response) });
  const armSeq = ctx.arm.seqFor(response, stream.seq);
  if (armSeq !== null) ctx.processSeqs.push(armSeq);
  const answer = await claim(ctx, result, armSeq, `stream ${entry.stream}`);
  result.claim = answer;
  result.tree = await frozenSnapshot(ctx, result, 'S2');
  if (result.tree) ctx.last = { result, snapshot: result.tree, armSeq };
}

async function quiesceStep(ctx, result) {
  for (const seq of [...new Set(ctx.processSeqs)]) await claim(ctx, result, seq, `exchange ${seq}`);
  result.tree = await frozenSnapshot(ctx, result, 'quiescent');
  if (result.tree) ctx.last = { result, snapshot: result.tree, armSeq: ctx.processSeqs.at(-1) ?? null };
}

// ------------------------------------------------------------------ a scenario
/**
 * Runs `scenario` against `arm` inside `run` (run-scratch.mjs), under
 * `<label>/` of the run. Returns the recording: the supplied values, every
 * step's record and problems, the processes, the trace. The arm is stopped at
 * the end whatever happened.
 */
export async function runScenario({ scenario, arm, run, label, limits = DRIVER_LIMITS, hooks = {} }) {
  const ctx = newContext({ scenario, arm, run, label, limits: { ...DRIVER_LIMITS, ...limits }, hooks });
  const recording = { scenario: scenario.id, group: scenario.group, arm: { role: arm.role, label }, startedAt: Date.now(), steps: [], problems: [], trace: ctx.trace };
  ctx.values = createSuppliedValues(`scenario ${scenario.id}`);
  ctx.armValues = createSuppliedValues(`arm ${label}`);
  ctx.dataRoot = run.makeDirectory(`${label}/data`);
  ctx.home = run.makeDirectory(`${label}/home`);
  ctx.armValues.path('data-root', ctx.dataRoot);
  ctx.armValues.path('home', ctx.home);
  ctx.stubUrls = {};
  // The fixture registers what it writes (an arm may echo it), so it runs before the registry is closed.
  await scenario.fixture(ctx.dataRoot, ctx.values);
  // The principals' own request headers are supplied values too (an arm may echo a forwarded address).
  for (const [name, principal] of Object.entries(scenario.principals)) for (const [header, value] of principal.headers) ctx.values.text(`principal.${name}.${header.toLowerCase()}`, value);
  const steps = validateSteps(scenario, scenario.steps(ctx.values));
  ctx.values.close();
  recording.lateEffects = 'checked from each step\'s last snapshot until the next step (the claim asked again, an idle listen connection, a frozen snapshot); work an arm defers until it receives the next request, or runs on a later timer, lands in the step named by lateUntil and is found only by the comparer (this step\'s snapshots against the reference\'s)';
  const setup = { id: '(start)', kind: 'start', problems: [], exchanges: [] };
  recording.setup = setup;
  try {
    const started = await startArm(ctx, setup);
    if (started) {
      recording.start = await frozenSnapshot(ctx, setup, 'start');
      ctx.last = { result: setup, snapshot: recording.start, armSeq: null };
    }
    // Every step gets a record (and so a row), also when the arm never started or died before it.
    for (const [index, entry] of steps.entries()) {
      const result = { id: entry.id, kind: entry.kind, problems: [], exchanges: [], startedAt: Date.now(), lateUntil: steps[index + 1]?.id ?? '(the arm\'s exit)' };
      recording.steps.push(result);
      trace(ctx, `step:${entry.id}`);
      if (!started) { problem(result, 'arm-start', 'not run: the arm did not start'); continue; }
      await ctx.hooks.beforeStep?.({ ctx, step: entry });
      if (ctx.dead && entry.kind !== 'restart') { noteDeath(ctx, result, 'the arm was not running at this step'); continue; }
      try {
        await recheck(ctx, result);
        if (ctx.dead && entry.kind !== 'restart') continue;
        await runStep(ctx, result, entry);
      } catch (error) {
        // A step the harness could not perform is recorded as such; the later steps still run and get rows.
        problem(result, 'step-error', `the step threw: ${errorText(error)}`);
      }
      if (ctx.dead && ctx.proc && result.problems.some((item) => item.check === 'arm-died')) await afterDeath(ctx, result);
      tapNews(ctx, result);
      if (ctx.held.size !== 0) problem(result, 'held-descriptors', `${ctx.held.size} sets of descriptors still held after the step`);
      result.endedAt = Date.now();
    }
    // The last claim, checked once more, and the tree once the arm has gone.
    await recheck(ctx);
  } finally {
    await finishRecording(ctx, recording);
  }
  return recording;
}

/**
 * The arm died during `result`'s step: once its process is gone, the tree it
 * left is that step's (`afterDeath`), and what a later look finds is compared
 * with it, not with an earlier step's snapshot.
 */
async function afterDeath(ctx, result) {
  await withDeadline(Promise.resolve(ctx.arm.exited).then(() => true), ctx.limits.goneMs, false);
  result.afterDeath = restingSnapshot(ctx, result, 'died');
  if (result.afterDeath) ctx.last = { result, snapshot: result.afterDeath, armSeq: null };
}

async function runStep(ctx, result, entry) {
  if (entry.kind === 'exchange') await singleExchange(ctx, result, entry.request);
  else if (entry.kind === 'concurrent') await concurrentStep(ctx, result, entry);
  else if (entry.kind === 'kill-after') await killAfterStep(ctx, result, entry);
  else if (entry.kind === 'restart') {
    await stopArm(ctx, result, { kill: ctx.dead });
    if (await startArm(ctx, result)) { result.tree = await frozenSnapshot(ctx, result, 'started'); ctx.last = { result, snapshot: result.tree, armSeq: null }; }
  } else if (entry.kind === 'external') await externalStep(ctx, result, entry);
  else if (entry.kind === 'snapshot') { result.tree = await frozenSnapshot(ctx, result, 'snapshot'); if (result.tree) ctx.last = { result, snapshot: result.tree, armSeq: null }; }
  else if (entry.kind === 'quiesce') await quiesceStep(ctx, result);
  else if (entry.kind === 'stream-open') await streamOpenStep(ctx, result, entry);
  else if (entry.kind === 'stream-barrier') await streamBarrierStep(ctx, result, entry);
  else if (entry.kind === 'stream-close') await streamCloseStep(ctx, result, entry);
}

async function finishRecording(ctx, recording) {
  const last = ctx.last?.result ?? recording.setup;
  for (const [name, stream] of ctx.streams) if (!stream.closed) { problem(stream.result ?? last, 'stream-unclosed', `stream ${name} was still open at the end`); stream.open?.close(); }
  if (ctx.proc) {
    const before = ctx.last?.snapshot ?? null;
    await stopArm(ctx, last, { kill: ctx.dead });
    const after = restingSnapshot(ctx, last, 'exit');
    recording.exitTree = after;
    if (before && after) { const changes = treeChanges(before, after); if (changes.length) problem(last, 'final-tree', `the data root changed between the last step and the arm's exit: ${changes.join(', ')}`); }
  }
  if (ctx.held.size !== 0) { problem(last, 'held-descriptors', `${ctx.held.size} sets of descriptors still held at the end`); for (const held of ctx.held) held.release(); ctx.held.clear(); }
  recording.values = { scenario: ctx.values?.list() ?? [], arm: ctx.armValues?.list() ?? [] };
  recording.processes = ctx.processes;
  recording.tapFiles = ctx.arm.tapFiles();
  recording.endedAt = Date.now();
  return recording;
}

// ------------------------------------------------------------------ rows
const NOT_RECORDED = (record) => record.notSent !== undefined;
/**
 * The rows of a recording: one per step, `<scenario id>/<step id>`. With no
 * comparer nothing is judged: a step recorded without a problem is
 * inconclusive and awaiting comparison; a step with problems is inconclusive
 * (unrecordable for the checks that make it so), or failed when the arm is a
 * candidate and the check is its fault. No row is ever passed here.
 */
export function rowsFromRecording(recording) {
  const rows = [];
  const steps = [...recording.steps];
  if (recording.setup?.problems.length) steps.unshift({ ...recording.setup, id: 'start' });
  for (const result of steps) {
    const id = `${recording.scenario}/${result.id}`;
    const checks = [...new Set(result.problems.map((entry) => entry.check))];
    const notSent = result.exchanges.length > 0 && result.exchanges.every(NOT_RECORDED);
    let outcome = 'inconclusive';
    let reason;
    let awaiting = null;
    if (checks.length) {
      if (recording.arm.role === 'candidate' && checks.some((check) => CANDIDATE_FAULTS.has(check))) outcome = 'failed';
      else if (checks.some((check) => UNRECORDABLE.has(check))) outcome = 'unrecordable';
      reason = result.problems.map((entry) => `${entry.check}: ${entry.text}`).join(' | ');
    } else if (notSent) {
      reason = `not sent: ${result.exchanges.map((record) => record.notSent).join(' | ')}`;
    } else {
      awaiting = AWAITING;
      reason = `recorded on the ${recording.arm.role} arm; awaiting comparison (no comparer exists yet)`;
    }
    // A kill at request-sent or response-head races the arm: the row says so (BH4 classes it against a second reference).
    if (result.nondeterministic) reason = `${reason} (nondeterministic: ${result.nondeterministic})`;
    rows.push({ id, outcome, reason, awaiting, checks, differences: [], nondeterministic: result.nondeterministic ?? null });
  }
  for (const row of rows) if (row.outcome === 'passed') throw new Error(`driver: row ${row.id} came out passed; a recording is never a pass`);
  return rows;
}

/** The recording as JSON for the run's scratch (Buffers as base64). */
export const recordingJson = (recording) => `${JSON.stringify(recording, (_key, value) => (value && value.type === 'Buffer' && Array.isArray(value.data) ? Buffer.from(value.data).toString('base64') : value), 1)}\n`;

export { HARNESS_HEADERS };
