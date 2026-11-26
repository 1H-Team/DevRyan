// Self-test of the comparer (design file 30 §4.4, §5, package O0d): hand-made
// pairs for every rule, every oracle and every global assertion, each one way
// that must pass and one that must fail with exactly that name; the two named
// relaxations (the independence table and OD2's read mode) both ways; and
// planted copies of the comparer itself, each of which some vector here must
// notice (so no check can be taken out without a test failing). Pure: no bun,
// no recording, no product code run (the reference codec and transition check
// are imported, as the comparer imports them).
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCodecContext, emitSlots, snapshot } from '../client-conformance/codec.mjs';
import { encodeLedgerSnapshot } from '../../packages/orchestration-runtime/codec.js';
import * as comparer from './compare.mjs';
import { createScratch } from './record.mjs';
import { judgeComparison } from './replay.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(HERE, '../..');
const T = 1_700_000_000_000;
const TASK = 'dvr_task_0123456789abcdef0123456789abcdef';
const LEASE = 'dvr_lease_fedcba9876543210fedcba9876543210';
const SHARD_EMPTY = '{"version":1,"shard":"00","tasks":[],"resultEnvelopes":[]}\n';
// The planted comparers' copies live in one run root (the OS temp dir's, removed on pass, failure and interruption).
const scratch = createScratch('scheduler-conformance-compare-test');
let plantsJudged = false;
after(() => { scratch.finish(plantsJudged ? 'passed' : 'failed'); });

// ------------------------------------------------------------------ traces by hand

const tree = (value) => emitSlots([snapshot(value, createCodecContext())])[0];
const sha = async (text) => `sha256:${(await import('node:crypto')).createHash('sha256').update(text).digest('hex')}`;
const queued = () => ({
  taskId: TASK, idempotencyKey: 'one', rootSessionId: 'ses_root', dispatchGroupId: null, dispatchCallId: null, dispatchWaveId: null, parentTaskId: null, childSessionId: null, transportRecovery: null,
  directory: '/workspace', sequence: 1, mode: 'orchestrator', readOnly: false, providerId: 'github-copilot', modelId: 'gpt-4.1', agent: 'explorer', variant: null, label: 'one', prompt: 'Perform one.',
  attempt: 1, priorTaskId: null, executionKind: 'start', createdAt: T, timeoutAt: null, recoveryLineageId: null, owner: 'devryan', status: 'queued', leaseToken: null, startedAt: null, finishedAt: null,
  childPromptedAt: null, firstAssistantPartAt: null, waitingReason: null, failureReason: null, partial: false, recoverablePreview: '', canonicalRefs: [],
});
const starting = (overrides = {}) => ({ ...queued(), status: 'starting', leaseToken: LEASE, startedAt: T, ...overrides });
const ledger = (...tasks) => ({ version: 1, tasks, resultEnvelopes: [] });
class ManagedOrchestrationError extends Error { constructor(message, code) { super(message); this.name = 'ManagedOrchestrationError'; this.code = code; } }

/** One event in the comparer's form; `values` are plain JS values turned into codec trees. */
const ev = (c, dir, kind, head = {}, values = {}, ledgerDigest = null) => ({ c, dir, kind, head: { dir, kind, ...head }, values: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, tree(value)])), ledger: ledgerDigest });
const port = (n, name, args) => ev(1, 'out', 'port', { port: n, name }, { args });
const answer = (n, outcome, value) => (outcome === 'promise' ? ev(1, 'in', 'answer', { port: n, outcome }) : ev(1, 'in', 'answer', { port: n, outcome }, { value }));
const save = async (n, state) => {
  let digest = null;
  try { digest = await sha(encodeLedgerSnapshot(state)); } catch { /* a state the reference codec refuses has no digest: the vector is about another check */ }
  return { ...port(n, 'persistence.save', [state, {}]), ledger: digest };
};

/**
 * The reference: construction, initialize (load, empty save), a submit (queued save, publish, starting save,
 * publish, lease timer, executor.start), its settlement. Inputs are unmarked (a step per arrived input).
 */
async function reference({ options = {} } = {}) {
  return [
    ev(1, 'in', 'call', { call: 0, member: 'createManagedTaskScheduler' }, { args: [{ executor: { start() {} }, ...options }] }),
    ev(1, 'in', 'call', { call: 1, member: 'submit' }, { args: [{ idempotencyKey: 'one' }] }),
    ev(1, 'out', 'return', { call: 1, promise: true }),
    ev(1, 'in', 'clock', { source: 'option' }, { value: T }),
    ev(1, 'in', 'draw', { site: 'createTaskId', source: 'option' }, { value: TASK }),
    await save(1, ledger(queued())), answer(1, 'promise'),
    answer(1, 'resolve', undefined),
    port(2, 'publishEvent', [{ type: 'devryan:managed-task', task: { taskId: TASK, status: 'queued' } }]), answer(2, 'return', undefined),
    ev(1, 'in', 'draw', { site: 'createLeaseToken', source: 'option' }, { value: LEASE }),
    ev(1, 'in', 'clock', { source: 'option' }, { value: T }),
    await save(3, ledger(starting())), answer(3, 'promise'),
    answer(3, 'resolve', undefined),
    port(4, 'publishEvent', [{ type: 'devryan:managed-task', task: { taskId: TASK, status: 'starting' } }]), answer(4, 'return', undefined),
    ev(1, 'in', 'clock', { source: 'option' }, { value: T }),
    ev(1, 'out', 'timer.set', { timer: 1, handle: 'object' }, { delay: 60_000 }),
    port(5, 'executor.start', [starting(), { control: true }]), answer(5, 'promise'),
    ev(1, 'out', 'settle', { call: 1, outcome: 'resolve' }, { value: starting() }),
  ];
}
const at = (events, predicate) => events.findIndex(predicate);
const isPort = (name) => (event) => event.kind === 'port' && event.head.name === name;
const clone = (events) => events.map((event) => ({ ...event, head: { ...event.head }, values: { ...event.values }, p: undefined }));
const run = (ref, cand, options = {}) => comparer.compareCase({ reference: clone(ref), candidate: clone(cand), ...options, ...(options.observed ? { observed: { ...options.observed, events: clone(options.observed.events) } } : {}) });
const failRules = (outcome) => outcome.findings.filter((finding) => finding.kind === 'fail').map((finding) => finding.rule);
/** A fail vector: the named rule fails (and, for a rule of §4.4, is the first difference's own name). */
function assertFails(outcome, rule, { first = false } = {}) {
  assert.ok(failRules(outcome).includes(rule), `want ${rule}, found ${JSON.stringify(outcome.findings.map((finding) => [finding.rule, finding.kind, finding.detail]))}`);
  if (first) assert.equal(outcome.findings.find((finding) => finding.kind === 'fail').rule, rule, JSON.stringify(outcome.findings[0]));
  assert.equal(outcome.verdict, 'fail');
}
const assertPasses = (outcome) => assert.equal(outcome.verdict, 'pass', JSON.stringify(outcome.findings.map((finding) => [finding.rule, finding.kind, finding.detail])));
const swap = (events, a, b) => { const out = [...events]; [out[a], out[b]] = [out[b], out[a]]; return out; };
const ARRIVED = (event) => event.dir === 'in' && (['call', 'control', 'callback', 'fire', 'abort', 'step'].includes(event.kind) || (event.kind === 'answer' && ['resolve', 'reject'].includes(event.head.outcome)));
/**
 * The candidate's run past the first difference as the replayer hands it to the comparer (replay.mjs ObserveHost):
 * its events, each arrived input mapped to the reference's arrived input of the same rank (`recOf`), every input
 * delivered unless `complete` is false.
 */
function observedRun(ref, events, { complete = true, through = complete ? ref.length - 1 : -1 } = {}) {
  const inputs = ref.map((event, index) => (ARRIVED(event) ? index : -1)).filter((index) => index >= 0);
  const recOf = [];
  let rank = 0;
  for (const [index, event] of events.entries()) if (ARRIVED(event)) recOf[index] = inputs[rank++];
  return { events: clone(events), recOf, through, complete, stopped: complete ? null : 'planted stop' };
}
const replaceAt = (events, index, ...items) => [...events.slice(0, index), ...items, ...events.slice(index + 1)];
const insertAt = (events, index, ...items) => [...events.slice(0, index), ...items, ...events.slice(index)];

// ------------------------------------------------------------------ the vectors

/**
 * Every rule, oracle and global assertion: `pass` and `fail` builders (each returns `[reference, candidate,
 * options?]`), and `first` when a rule of §4.4 must be the first difference's own name.
 */
const VECTORS = {
  'event-sequence': {
    first: true,
    pass: async () => { const ref = await reference(); return [ref, ref]; },
    fail: async () => { const ref = await reference(); return [ref, swap(ref, 10, 11)]; }, // a lease draw and a clock read in the other order
  },
  'port-arguments': {
    first: true,
    pass: async () => { const ref = await reference(); return [ref, ref]; },
    fail: async () => { const ref = await reference(); const i = at(ref, isPort('executor.start')); return [ref, replaceAt(ref, i, port(5, 'executor.start', [starting({ label: 'other' }), { control: true }]))]; },
  },
  'saved-state': {
    first: true,
    pass: async () => { const ref = await reference(); return [ref, ref]; },
    // A save more than the recording: a second write of the queued state.
    fail: async () => { const ref = await reference(); const i = at(ref, isPort('publishEvent')); return [ref, insertAt(ref, i, await save(2, ledger(queued())), answer(2, 'promise'))]; },
  },
  'saved-state bytes': {
    rule: 'saved-state',
    pass: async () => { const ref = await reference(); return [ref, ref]; },
    // The candidate's state codec-equal to the recording's trees, but the recording's digest is another's bytes.
    fail: async () => { const ref = await reference(); const i = at(ref, isPort('persistence.save')); const bad = [...ref]; bad[i] = { ...bad[i], ledger: await sha('{}\n') }; return [bad, ref]; },
  },
  'shard-writes': {
    first: true,
    pass: async () => { const ref = [...(await reference()), port(6, 'persistence.removeNativeJobProofShard', ['0a']), answer(6, 'promise')]; return [ref, ref]; },
    fail: async () => { const ref = [...(await reference()), port(6, 'persistence.removeNativeJobProofShard', ['0a']), answer(6, 'promise')]; return [ref, replaceAt(ref, ref.length - 2, port(6, 'persistence.removeNativeJobProofShard', ['0b']))]; },
  },
  times: {
    first: true,
    pass: async () => { const ref = await reference(); return [ref, ref]; },
    fail: async () => { const ref = await reference(); const i = at(ref, (event) => isPort('persistence.save')(event) && event.head.port === 3); return [ref, replaceAt(ref, i, await save(3, ledger(starting({ startedAt: T + 7 }))))]; },
  },
  'times (on the candidate alone)': {
    rule: 'times',
    // A time derived from a handed-out now plus a named constant (the starting lease) passes; the same trace with a
    // time that is no such value fails even where it equals the recording (the rule is on the candidate's outputs).
    pass: async () => { const ref = await reference(); const i = at(ref, (event) => isPort('publishEvent')(event) && event.head.port === 4); const with60 = replaceAt(ref, i, port(4, 'publishEvent', [{ type: 'devryan:managed-task', task: { taskId: TASK, status: 'starting', timeoutAt: T + 60_000 } }])); return [with60, with60]; },
    fail: async () => { const ref = await reference(); const i = at(ref, (event) => isPort('publishEvent')(event) && event.head.port === 4); const bad = replaceAt(ref, i, port(4, 'publishEvent', [{ type: 'devryan:managed-task', task: { taskId: TASK, status: 'starting', timeoutAt: T + 60_001 } }])); return [bad, bad]; },
  },
  'times (on the candidate alone, near a now)': {
    rule: 'times',
    // startedAt 7 ms after a handed-out now, equal in both traces: no now, no now plus a named constant (no window).
    pass: async () => { const ref = await reference(); return [ref, ref]; },
    fail: async () => { const ref = await reference(); const i = at(ref, (event) => isPort('persistence.save')(event) && event.head.port === 3); const bad = replaceAt(ref, i, await save(3, ledger(starting({ startedAt: T + 7 })))); return [bad, bad]; },
  },
  'identifiers (on the candidate alone, from nowhere)': {
    rule: 'identifiers',
    // A lease token no draw made and no input carried, equal in both traces.
    pass: async () => { const ref = await reference(); return [ref, ref]; },
    fail: async () => { const ref = await reference(); const i = at(ref, (event) => isPort('persistence.save')(event) && event.head.port === 3); const bad = replaceAt(ref, i, await save(3, ledger(starting({ leaseToken: 'dvr_lease_00000000000000000000000000000000' })))); return [bad, bad]; },
  },
  'times (a timer delay)': {
    rule: 'times',
    pass: async () => { const ref = await reference(); return [ref, ref]; },
    fail: async () => { const ref = await reference(); const i = at(ref, (event) => event.kind === 'timer.set'); const bad = replaceAt(ref, i, ev(1, 'out', 'timer.set', { timer: 1, handle: 'object' }, { delay: 60_001 })); return [bad, bad]; },
  },
  identifiers: {
    first: true,
    pass: async () => { const ref = await reference(); return [ref, ref]; },
    fail: async () => { const ref = await reference(); const i = at(ref, (event) => isPort('persistence.save')(event) && event.head.port === 3); return [ref, replaceAt(ref, i, await save(3, ledger(starting({ leaseToken: 'dvr_lease_00000000000000000000000000000000' }))))]; },
  },
  'identifiers (another site\'s draw)': {
    rule: 'identifiers',
    pass: async () => { const ref = await reference(); return [ref, ref]; },
    fail: async () => { const ref = await reference(); const i = at(ref, (event) => isPort('persistence.save')(event) && event.head.port === 3); const bad = replaceAt(ref, i, await save(3, ledger(starting({ leaseToken: TASK })))); return [bad, bad]; },
  },
  errors: {
    first: true,
    pass: async () => { const ref = [...(await reference()), ev(1, 'in', 'call', { call: 2, member: 'cancelTask' }, { args: ['x'] }), ev(1, 'out', 'throw', { call: 2 }, { error: new ManagedOrchestrationError('managed task x was not found', 'task_not_found') })]; return [ref, ref]; },
    fail: async () => { const ref = [...(await reference()), ev(1, 'in', 'call', { call: 2, member: 'cancelTask' }, { args: ['x'] }), ev(1, 'out', 'throw', { call: 2 }, { error: new ManagedOrchestrationError('managed task x was not found', 'task_not_found') })]; return [ref, replaceAt(ref, ref.length - 1, ev(1, 'out', 'throw', { call: 2 }, { error: new ManagedOrchestrationError('managed task x was not found', 'task_missing') }))]; },
  },
  'mutation-timing': {
    first: true,
    pass: async () => { const ref = [...(await reference()), port(6, 'onMutationTiming', [{ waitMs: 0, holdMs: 0, failed: false }]), answer(6, 'return', undefined)]; return [ref, ref]; },
    fail: async () => { const ref = [...(await reference()), port(6, 'onMutationTiming', [{ waitMs: 0, holdMs: 0, failed: false }]), answer(6, 'return', undefined)]; return [ref, replaceAt(ref, ref.length - 2, port(6, 'onMutationTiming', [{ waitMs: 0, holdMs: 0, failed: true }]))]; },
  },
  logs: {
    first: true,
    pass: async () => { const ref = [...(await reference()), port(6, 'logger.warn', ['[ManagedOrchestration] Failed to publish task event', { taskId: TASK, error: 'x' }]), answer(6, 'return', undefined)]; return [ref, ref]; },
    fail: async () => { const ref = [...(await reference()), port(6, 'logger.warn', ['[ManagedOrchestration] Failed to publish task event', { taskId: TASK, error: 'x' }]), answer(6, 'return', undefined)]; return [ref, replaceAt(ref, ref.length - 2, port(6, 'logger.warn', ['[ManagedOrchestration] Failed to publish a task event', { taskId: TASK, error: 'x' }]))]; },
  },
  'returned-values': {
    first: true,
    pass: async () => { const ref = await reference(); return [ref, ref]; },
    fail: async () => { const ref = await reference(); return [ref, replaceAt(ref, ref.length - 1, ev(1, 'out', 'settle', { call: 1, outcome: 'resolve' }, { value: { ...starting(), planted: true } }))]; },
  },
  'returned-values (undefined is not null)': {
    rule: 'returned-values',
    pass: async () => { const ref = await reference(); return [ref, ref]; },
    fail: async () => { const ref = [...(await reference()), ev(1, 'in', 'call', { call: 2, member: 'getTask' }, { args: ['x'] }), ev(1, 'out', 'return', { call: 2 }, { value: null })]; return [ref, replaceAt(ref, ref.length - 1, ev(1, 'out', 'return', { call: 2 }, { value: undefined }))]; },
  },
  inputs: {
    first: true,
    pass: async () => { const ref = await reference(); return [ref, ref]; },
    fail: async () => { const ref = await reference(); const i = at(ref, (event) => event.kind === 'answer' && event.head.outcome === 'resolve'); return [ref, replaceAt(ref, i, answer(1, 'resolve', 'other'))]; },
  },
  'codec-round-trip': {
    pass: async () => { const ref = await reference(); return [ref, ref]; },
    fail: async () => { const ref = await reference(); const i = at(ref, isPort('persistence.save')); const bad = replaceAt(ref, i, { ...port(1, 'persistence.save', [{ version: 1, tasks: [{ taskId: 7 }], resultEnvelopes: [] }, {}]), ledger: null }); return [bad, bad]; },
  },
  transitions: {
    pass: async () => { const ref = await reference(); return [ref, ref]; },
    fail: async () => { const ref = await reference(); const i = at(ref, (event) => isPort('persistence.save')(event) && event.head.port === 3); const bad = replaceAt(ref, i, await save(3, ledger(starting({ prompt: 'Perform another.' })))); return [bad, bad]; },
  },
  'timer-census': {
    pass: async () => { const ref = [...(await reference()), ev(1, 'in', 'call', { call: 2, member: 'shutdown' }, { args: [] }), ev(1, 'out', 'return', { call: 2, promise: true }), ev(1, 'out', 'timer.clear', { timer: 1 }), ev(1, 'out', 'settle', { call: 2, outcome: 'resolve' }, { value: undefined })]; return [ref, ref]; },
    // A shutdown that settles with the lease timer still live.
    fail: async () => { const ref = [...(await reference()), ev(1, 'in', 'call', { call: 2, member: 'shutdown' }, { args: [] }), ev(1, 'out', 'return', { call: 2, promise: true }), ev(1, 'out', 'settle', { call: 2, outcome: 'resolve' }, { value: undefined })]; return [ref, ref]; },
  },
  'timer-census (left live at the first difference)': {
    rule: 'timer-census',
    pass: async () => { const ref = [...(await reference()), ev(1, 'in', 'call', { call: 2, member: 'shutdown' }, { args: [] }), ev(1, 'out', 'return', { call: 2, promise: true }), ev(1, 'out', 'timer.clear', { timer: 1 }), ev(1, 'out', 'settle', { call: 2, outcome: 'resolve' }, { value: undefined })]; return [ref, ref]; },
    fail: async () => { const ref = [...(await reference()), ev(1, 'in', 'call', { call: 2, member: 'shutdown' }, { args: [] }), ev(1, 'out', 'return', { call: 2, promise: true }), ev(1, 'out', 'timer.clear', { timer: 1 }), ev(1, 'out', 'settle', { call: 2, outcome: 'resolve' }, { value: undefined })]; return [ref, ref.filter((event) => event.kind !== 'timer.clear'), { complete: false }]; },
  },
  launch_delayed: {
    pass: async () => { const ref = await reference(); return [ref, ref]; },
    // A timer set before the launch that the reference did not set (the candidate's trace cut there).
    fail: async () => { const ref = await reference(); const i = at(ref, isPort('executor.start')); return [ref, insertAt(ref.slice(0, i), i, ev(1, 'out', 'timer.set', { timer: 2, handle: 'object' }, { delay: 0 })), { complete: false }]; },
  },
  'launch_delayed (missing)': {
    rule: 'launch_delayed',
    pass: async () => { const ref = await reference(); return [ref, ref]; },
    fail: async () => { const ref = await reference(); const i = at(ref, isPort('executor.start')); return [ref, [...ref.slice(0, i), ref[ref.length - 1]]]; },
  },
  launch_advanced: {
    pass: async () => { const ref = await reference(); return [ref, ref]; },
    // The launch before the second publication and the lease timer: earlier than the reference (and not by the table: it passes a timer set).
    fail: async () => { const ref = await reference(); const i = at(ref, isPort('executor.start')); const before = at(ref, (event) => event.kind === 'timer.set') - 1; return [ref, [...ref.slice(0, before), ref[i], ref[i + 1], ...ref.slice(before, i), ...ref.slice(i + 2)], { complete: false }]; },
  },
  durability: {
    pass: async () => { const ref = await reference(); return [ref, ref]; },
    // The launch before the starting save resolved: the candidate's resolve comes after it.
    fail: async () => { const ref = await reference(); const resolve3 = at(ref, (event) => event.kind === 'answer' && event.head.port === 3 && event.head.outcome === 'resolve'); const start = at(ref, isPort('executor.start')); const moved = [...ref.slice(0, resolve3), ...ref.slice(resolve3 + 1, start + 2), ref[resolve3], ...ref.slice(start + 2)]; return [moved, moved]; },
  },
  'durability (a waiter before its save)': {
    rule: 'durability',
    pass: async () => { const ref = await reference(); return [ref, ref]; },
    fail: async () => { const ref = [...(await reference()), ev(1, 'in', 'call', { call: 2, member: 'waitForTask' }, { args: [TASK] }), ev(1, 'out', 'return', { call: 2, promise: true }), ev(1, 'out', 'settle', { call: 2, outcome: 'resolve' }, { value: starting({ status: 'completed', finishedAt: T }) })]; return [ref, ref]; },
  },
  'waiting-capacity': {
    // Written only by the admitLaunch hook: with the hook given it is information, without it a failure.
    pass: async () => { const ref = await reference({ options: { admitLaunch() {} } }); const i = at(ref, (event) => isPort('persistence.save')(event) && event.head.port === 1); const held = replaceAt(ref, i, await save(1, ledger({ ...queued(), waitingReason: { kind: 'capacity', activeCount: 0, limit: 1, since: T } }))); return [held, held]; },
    fail: async () => { const ref = await reference(); const i = at(ref, (event) => isPort('persistence.save')(event) && event.head.port === 1); const held = replaceAt(ref, i, await save(1, ledger({ ...queued(), waitingReason: { kind: 'capacity', activeCount: 0, limit: 1, since: T } }))); return [held, held]; },
  },
  'waiting-prerequisites': {
    pass: async () => { const ref = await reference(); const i = at(ref, (event) => isPort('persistence.save')(event) && event.head.port === 1); const held = replaceAt(ref, i, await save(1, ledger({ ...queued(), waitingReason: { kind: 'prerequisites', activeCount: 0, limit: null, since: T } }))); return [held, held]; },
    fail: async () => { const ref = await reference(); const i = at(ref, (event) => isPort('persistence.save')(event) && event.head.port === 1); const held = replaceAt(ref, i, await save(1, ledger({ ...queued(), waitingReason: { kind: 'prerequisites', activeCount: 0, limit: null, since: T } }))); return [ref, held]; },
  },
  'admit-launch': {
    pass: async () => { const ref = await reference({ options: { admitLaunch() {} } }); const i = at(ref, isPort('executor.start')); const asked = insertAt(ref, i, port(6, 'admitLaunch', [{ taskId: TASK }]), answer(6, 'return', { admit: true })); return [asked, asked]; },
    fail: async () => { const ref = await reference(); const i = at(ref, isPort('executor.start')); const asked = insertAt(ref, i, port(6, 'admitLaunch', [{ taskId: TASK }]), answer(6, 'return', { admit: true })); return [asked, asked]; },
  },
  'active-count': {
    pass: async () => { const ref = await reference(); return [ref, ref]; },
    // The candidate's queued save already holds the task starting: one active task at the end of the submit's step where the reference has none.
    fail: async () => { const ref = [...(await reference()), ev(1, 'in', 'call', { call: 2, member: 'getSnapshot' }, { args: [] })]; const i = at(ref, (event) => isPort('persistence.save')(event) && event.head.port === 1); const cand = replaceAt(ref, i, await save(1, ledger(starting()))); return [ref, cand]; },
  },
  // ---------------------------------------------------------------- fix round 1
  // S2: the replay stopped inside a port call (the call compared, its answer never asked for): the value rule names it.
  'port-arguments (the replay stopped inside the port call)': {
    rule: 'port-arguments', first: true,
    pass: async () => { const ref = await reference(); return [ref, ref]; },
    fail: async () => { const ref = await reference(); const i = at(ref, isPort('executor.start')); return [ref, [...ref.slice(0, i), port(5, 'executor.start', [starting({ label: 'other' }), { control: true }])], { complete: false }]; },
  },
  'times (the replay stopped inside the save)': {
    rule: 'times', first: true,
    pass: async () => { const ref = await reference(); return [ref, ref]; },
    fail: async () => { const ref = await reference(); const i = at(ref, (event) => isPort('persistence.save')(event) && event.head.port === 3); return [ref, [...ref.slice(0, i), await save(3, ledger(starting({ startedAt: T + 7 })))], { complete: false }]; },
  },
  'identifiers (the replay stopped inside the save)': {
    rule: 'identifiers', first: true,
    pass: async () => { const ref = await reference(); return [ref, ref]; },
    fail: async () => { const ref = await reference(); const i = at(ref, (event) => isPort('persistence.save')(event) && event.head.port === 3); return [ref, [...ref.slice(0, i), await save(3, ledger(starting({ leaseToken: 'dvr_lease_00000000000000000000000000000000' })))], { complete: false }]; },
  },
  // S1: launches judged past the first difference, from the candidate's observed run (the compared events cut before the launch).
  'launch_delayed (observed: a longer distance)': {
    rule: 'launch_delayed',
    pass: async () => { const ref = await reference(); const i = at(ref, isPort('executor.start')); return [ref, ref.slice(0, i), { complete: false, observed: observedRun(ref, ref) }]; },
    // Three events more between the input and the launch (a publication and a clock read), same step and time.
    fail: async () => { const ref = await reference(); const i = at(ref, isPort('executor.start')); return [ref, ref.slice(0, i), { complete: false, observed: observedRun(ref, insertAt(ref, i, port(6, 'publishEvent', [{ type: 'other' }]), answer(6, 'return', undefined), ev(1, 'in', 'clock', { source: 'option' }, { value: T }))) }]; },
  },
  'launch_delayed (observed: a timer more, the distance unchanged)': {
    rule: 'launch_delayed',
    pass: async () => { const ref = await reference(); const i = at(ref, isPort('executor.start')); return [ref, ref.slice(0, i), { complete: false, observed: observedRun(ref, ref) }]; },
    // The second publication and its answer replaced by two timers of 0 ms: as many events, two timers more.
    fail: async () => { const ref = await reference(); const i = at(ref, isPort('executor.start')); const publish = at(ref, (event) => isPort('publishEvent')(event) && event.head.port === 4); const timer = (n) => ev(1, 'out', 'timer.set', { timer: n, handle: 'object' }, { delay: 0 }); return [ref, ref.slice(0, i), { complete: false, observed: observedRun(ref, [...ref.slice(0, publish), timer(2), timer(3), ...ref.slice(publish + 2)]) }]; },
  },
  'launch_delayed (observed: never made)': {
    rule: 'launch_delayed',
    pass: async () => { const ref = await reference(); const i = at(ref, isPort('executor.start')); return [ref, ref.slice(0, i), { complete: false, observed: observedRun(ref, ref) }]; },
    fail: async () => { const ref = await reference(); const i = at(ref, isPort('executor.start')); return [ref, ref.slice(0, i), { complete: false, observed: observedRun(ref, [...ref.slice(0, i), ...ref.slice(i + 2)]) }]; },
  },
  // S3: a launch the reference does not make is a defect, never an owner's timing decision.
  launch_duplicated: {
    pass: async () => { const ref = await reference(); return [ref, ref]; },
    fail: async () => { const ref = await reference(); return [ref, [...ref.slice(0, -1), port(6, 'executor.start', [starting(), { control: true }]), answer(6, 'promise'), ref[ref.length - 1]]]; },
  },
  launch_extra: {
    pass: async () => { const ref = await reference(); return [ref, ref]; },
    fail: async () => { const ref = await reference(); return [ref, [...ref.slice(0, -1), port(6, 'executor.resume', [starting(), { control: true }]), answer(6, 'promise'), ref[ref.length - 1]]]; },
  },
  // S6: checks no vector reached before.
  'codec-round-trip (a shard text)': {
    rule: 'codec-round-trip',
    pass: async () => { const ref = [...(await reference()), port(6, 'persistence.putNativeJobProofShard', ['00', SHARD_EMPTY]), answer(6, 'promise')]; return [ref, ref]; },
    fail: async () => { const ref = [...(await reference()), port(6, 'persistence.putNativeJobProofShard', ['00', '{"version":1}']), answer(6, 'promise')]; return [ref, ref]; },
  },
  'transitions (a same-status update)': {
    rule: 'transitions',
    pass: async () => { const ref = [...(await reference()), await save(6, ledger(starting({ childSessionId: 'ses_child' }))), answer(6, 'promise')]; return [ref, ref]; },
    // starting -> starting with an immutable field changed: refused whatever the status does.
    fail: async () => { const ref = [...(await reference()), await save(6, ledger(starting({ prompt: 'Perform another.' }))), answer(6, 'promise')]; return [ref, ref]; },
  },
  'durability (another lease token)': {
    rule: 'durability',
    pass: async () => { const ref = await reference(); return [ref, ref]; },
    fail: async () => { const ref = await reference(); const i = at(ref, isPort('executor.start')); const bad = replaceAt(ref, i, port(5, 'executor.start', [starting({ leaseToken: `dvr_lease_${'1'.repeat(32)}` }), { control: true }])); return [bad, bad]; },
  },
  'waiting-capacity (system pressure)': {
    rule: 'waiting-capacity',
    pass: async () => { const ref = await reference(); return [ref, ref]; },
    fail: async () => { const ref = await reference(); const i = at(ref, (event) => isPort('persistence.save')(event) && event.head.port === 1); const held = replaceAt(ref, i, await save(1, ledger({ ...queued(), waitingReason: { kind: 'system_pressure', activeCount: 0, limit: 1, since: T } }))); return [held, held]; },
  },
  'timer-census (a rejected shutdown)': {
    rule: 'timer-census',
    pass: async () => { const ref = [...(await reference()), ev(1, 'in', 'call', { call: 2, member: 'shutdown' }, { args: [] }), ev(1, 'out', 'return', { call: 2, promise: true }), ev(1, 'out', 'timer.clear', { timer: 1 }), ev(1, 'out', 'settle', { call: 2, outcome: 'reject' }, { value: new ManagedOrchestrationError('shutdown failed', 'harness') })]; return [ref, ref]; },
    fail: async () => { const ref = [...(await reference()), ev(1, 'in', 'call', { call: 2, member: 'shutdown' }, { args: [] }), ev(1, 'out', 'return', { call: 2, promise: true }), ev(1, 'out', 'settle', { call: 2, outcome: 'reject' }, { value: new ManagedOrchestrationError('shutdown failed', 'harness') })]; return [ref, ref]; },
  },
};

test('every rule, oracle and global assertion of the comparer has a vector that passes and one that fails with its name', async () => {
  const names = new Set([...Object.keys(comparer.RULES).filter((rule) => rule !== 'option-reads'), ...Object.keys(comparer.ORACLES).filter((rule) => rule !== 'launch-latency'), ...Object.keys(comparer.LATENCY_FINDINGS)]);
  const covered = new Set();
  for (const [name, vector] of Object.entries(VECTORS)) {
    const rule = vector.rule ?? name;
    covered.add(rule);
    const [passRef, passCand, passOptions] = await vector.pass();
    assertPasses(run(passRef, passCand, passOptions));
    const [failRef, failCand, failOptions] = await vector.fail();
    assertFails(run(failRef, failCand, failOptions), rule, { first: vector.first === true });
  }
  assert.deepEqual([...names].filter((rule) => !covered.has(rule)), [], 'a rule, oracle or assertion with no vector');
});

test('the independence table: only the design\'s two pairs, each cited, every use reported, and nothing wider', async () => {
  // It ships empty (running code does not confirm the design's entries, docs/TESTING.md); the design's two are kept, cited.
  assert.deepEqual(comparer.INDEPENDENCE, []);
  assert.deepEqual(comparer.DESIGN_INDEPENDENCE.map((entry) => entry.lanes.join('|')), ['publish|executor', 'publish|timer.set']);
  for (const entry of comparer.DESIGN_INDEPENDENCE) assert.match(entry.cite, /scheduler\.js:\d+/);
  const design = { mode: { independence: comparer.DESIGN_INDEPENDENCE } };
  const renumbered = (event, number) => ({ ...event, head: { ...event.head, port: number } });
  const original = await reference();
  const publish = at(original, (event) => isPort('publishEvent')(event) && event.head.port === 4);
  // A reference whose second publication sits right before the lease timer set and the launch (the clock read first).
  const ref = [...original.slice(0, publish), original[publish + 2], original[publish], original[publish + 1], ...original.slice(publish + 3)];
  const timerSet = at(ref, (event) => event.kind === 'timer.set');
  const start = at(ref, isPort('executor.start'));
  // publish vs timer.set: the timer set before the publication passes, with one use reported and its citation.
  const timerFirst = [...ref.slice(0, timerSet - 2), ref[timerSet], ref[timerSet - 2], ref[timerSet - 1], ...ref.slice(timerSet + 1)];
  assertFails(run(ref, timerFirst), 'event-sequence', { first: true });
  const relaxed = run(ref, timerFirst, design);
  assertPasses(relaxed);
  assert.deepEqual(relaxed.info.filter((item) => item.rule === 'independence').map((item) => item.lanes), [['timer.set', 'publish']]);
  assert.match(relaxed.info.find((item) => item.rule === 'independence').cite, /publicationTail/);
  // Strict without the table: the same pair is an event-sequence difference.
  assertFails(run(ref, timerFirst, { mode: { independence: [] } }), 'event-sequence', { first: true });
  // publish vs executor: the launch right behind the publication passes it; port numbers follow the candidate's calls.
  const adjacent = [...ref.slice(0, timerSet - 2), ref[timerSet], ref[timerSet - 2], ref[timerSet - 1], ...ref.slice(timerSet + 1)];
  const second = at(adjacent, (event) => isPort('publishEvent')(event) && event.head.port === 4);
  const launchFirst = [...adjacent.slice(0, second), renumbered(adjacent[second + 2], 4), renumbered(adjacent[second + 3], 4), renumbered(adjacent[second], 5), renumbered(adjacent[second + 1], 5), ...adjacent.slice(second + 4)];
  const swapped = run(adjacent, launchFirst, design);
  assertPasses(swapped);
  assert.deepEqual(swapped.info.filter((item) => item.rule === 'independence').map((item) => item.lanes), [['executor', 'publish']]);
  assertFails(run(adjacent, launchFirst, { mode: { independence: [] } }), 'event-sequence', { first: true });
  // The launch may not pass the timer set (executor vs timer.set is not in the table).
  const pastTimer = [...ref.slice(0, timerSet - 2), renumbered(ref[start], 4), renumbered(ref[start + 1], 4), renumbered(ref[timerSet - 2], 5), renumbered(ref[timerSet - 1], 5), ref[timerSet], ...ref.slice(start + 2)];
  assertFails(run(ref, pastTimer, design), 'event-sequence', { first: true });
  // A save and a launch are never independent.
  const save3 = at(ref, (event) => isPort('persistence.save')(event) && event.head.port === 3);
  const launchBeforeSave = [...ref.slice(0, save3), renumbered(ref[start], 3), renumbered(ref[start + 1], 3), ...ref.slice(save3, start).map((event) => (event.head.port === 3 ? renumbered(event, 4) : event.head.port === 4 ? renumbered(event, 5) : event)), ...ref.slice(start + 2)];
  assertFails(run(ref, launchBeforeSave, design), 'saved-state', { first: true });
  // Order within a lane is exact: two publications in the other order differ.
  const two = [...ref, port(6, 'publishEvent', [{ type: 'other' }]), answer(6, 'return', undefined)];
  const firstPublish = at(two, isPort('publishEvent'));
  const twoSwapped = [...two.slice(0, firstPublish), renumbered(two[two.length - 2], 2), renumbered(two[two.length - 1], 2), ...two.slice(firstPublish + 2, two.length - 2), renumbered(two[firstPublish], 6), renumbered(two[firstPublish + 1], 6)];
  assertFails(run(two, twoSwapped, design), 'port-arguments', { first: true });
});

test('the read mode (OD2): off by default; free reads by key and value, option-varies and an unread key inconclusive', async () => {
  const read = (key, value) => ev(1, 'in', 'read', { object: 'options', key }, { value });
  const ref = await reference();
  const withReads = insertAt(ref, 3, read('abortTimeoutMs', undefined), read('maxTerminalRecords', 0));
  const moved = insertAt(ref, 6, read('maxTerminalRecords', 0), read('abortTimeoutMs', undefined), read('abortTimeoutMs', undefined));
  // Exact (the JavaScript closure's): count and position are compared.
  assertFails(run(withReads, moved), 'event-sequence', { first: true });
  const free = run(withReads, moved, { mode: { reads: 'free' } });
  assertPasses(free);
  assert.ok(free.info.some((item) => item.rule === 'read-mode'));
  // Free, but the candidate's read got another value: a failure.
  assertFails(run(withReads, insertAt(ref, 3, read('maxTerminalRecords', 1)), { mode: { reads: 'free' } }), 'option-reads');
  // The recording reads one key with two values: inconclusive, never a pass.
  const varies = insertAt(ref, 3, read('maxTerminalRecords', 0), read('maxTerminalRecords', 1));
  const outcome = run(varies, varies, { mode: { reads: 'free' } });
  assert.equal(outcome.verdict, 'inconclusive');
  assert.ok(outcome.findings.some((finding) => finding.rule === 'option-varies'));
  // The candidate reads a key the recording never read: inconclusive.
  const unread = run(withReads, insertAt(ref, 3, read('somethingElse', 1)), { mode: { reads: 'free' } });
  assert.equal(unread.verdict, 'inconclusive', JSON.stringify(unread.findings));
});

test('the delay table and the identifier sites are the design\'s, and a time names the now and the constant it matched', async () => {
  for (const [name, value] of Object.entries({ 'starting lease': 60_000, 'admission retry default': 5_000, 'reconciliation retry': 1_000, 'persistence stall': 300_000, 'run cleanup 2': 30_000, 'auto-resume startup grace': 15_000, 'auto-resume probe stagger': 60_000 })) assert.equal(comparer.DELAYS[name], value, name);
  assert.deepEqual(comparer.ID_SITES.leaseToken, ['createLeaseToken']);
  const ref = await reference();
  const i = at(ref, (event) => isPort('persistence.save')(event) && event.head.port === 3);
  const outcome = run(ref, replaceAt(ref, i, await save(3, ledger(starting({ startedAt: T + 7 })))));
  const first = outcome.findings.find((finding) => finding.rule === 'times');
  assert.match(first.detail, /startedAt/);
  assert.match(first.detail, /the recording's .* = now #\d+/);
});

test('every launch is judged wherever the first difference is: past it from the observed run, else listed unjudged', async () => {
  const ref = await reference();
  const i = at(ref, isPort('executor.start'));
  // The observed run stopped before the launch's input: not judged, and said so (information, never a pass by default).
  const stopped = run(ref, ref.slice(0, i), { complete: false, observed: observedRun(ref, ref.slice(0, 5), { complete: false, through: 4 }) });
  assertPasses(stopped);
  assert.match(stopped.info.find((item) => item.rule === 'launch-unjudged')?.detail ?? '', /executor\.start of .* at event \d+/);
  // No observed run at all: the same.
  assert.ok(run(ref, ref.slice(0, i), { complete: false }).info.some((item) => item.rule === 'launch-unjudged'));
  // A launch the reference makes only after a restart (the crashed instance never launched its admitted task, the
  // fresh one does): the candidate's launch in the crashed instance is earlier (launch_advanced), not extra.
  const crashed = [...ref.slice(0, i), ev(2, 'in', 'call', { call: 0, member: 'createManagedTaskScheduler' }, { args: [{ executor: { start() {} } }] }), ev(2, 'out', 'port', { port: 1, name: 'executor.start' }, { args: [starting(), { control: true }] }), ev(2, 'in', 'answer', { port: 1, outcome: 'promise' })];
  const advanced = run(crashed, [...ref.slice(0, i), ref[i]], { complete: false });
  assert.ok(failRules(advanced).includes('launch_advanced') && !failRules(advanced).includes('launch_extra'), JSON.stringify(advanced.findings.map((finding) => [finding.rule, finding.detail])));
});

test('the replay\'s verdict: a comparer that throws fails the case, an inconclusive finding is never a pass, and the two independence counts must agree', () => {
  const reproduced = { outcome: 'reproduced', produced: 3 };
  const pass = () => ({ verdict: 'pass', findings: [], info: [] });
  assert.equal(judgeComparison(reproduced, { run: pass }).compare.verdict, 'pass');
  // A crash of the comparer, on a reproduced and on a partial case.
  for (const result of [reproduced, { outcome: 'partial', produced: 2 }]) {
    const crashed = judgeComparison(result, { run: () => { throw new Error('planted comparer crash'); } });
    assert.deepEqual([crashed.outcome, crashed.check, crashed.rule, crashed.compare.verdict], ['different', 'compare', 'compare', 'fail']);
    assert.match(crashed.detail, /the comparer failed: .*planted comparer crash/);
  }
  // An inconclusive finding turns a reproduced case inconclusive.
  const unsure = judgeComparison(reproduced, { run: () => ({ verdict: 'inconclusive', findings: [{ rule: 'option-varies', kind: 'inconclusive', detail: 'planted' }], info: [] }) });
  assert.deepEqual([unsure.outcome, unsure.check, unsure.compare.verdict], ['inconclusive', 'option-varies', 'inconclusive']);
  // The replay moved a unit by the table the comparer did not find (and the other way round): different.
  const moved = judgeComparison(reproduced, { run: pass, uses: 1 });
  assert.deepEqual([moved.outcome, moved.rule], ['different', 'independence']);
  const found = judgeComparison(reproduced, { run: () => ({ verdict: 'pass', findings: [], info: [{ rule: 'independence', kind: 'info', at: 3, lanes: ['publish', 'timer.set'], cite: 'x' }] }), uses: 0 });
  assert.deepEqual([found.outcome, found.rule], ['different', 'independence']);
  // A case already different stays different, with the comparer's rule named.
  const different = judgeComparison({ outcome: 'different', check: 'order' }, { run: () => ({ verdict: 'fail', findings: [{ rule: 'launch_delayed', kind: 'fail', detail: 'planted' }], info: [] }) });
  assert.deepEqual([different.outcome, different.check, different.rule], ['different', 'order', 'launch_delayed']);
});

// ------------------------------------------------------------------ planted comparers

/** Planted bugs in a copy of the comparer: each must make some vector above answer wrongly. */
const COMPARER_PLANTS = [
  { name: 'start-time-masked', purpose: 'startedAt left out of the times rule (design M12, a mask)', anchor: "        if (!key || !TIME_KEY.test(key)) continue;\n        checked += 1;", with: "        if (!key || !TIME_KEY.test(key) || key === 'startedAt' || key === 'timeoutAt') continue;\n        checked += 1;" },
  { name: 'independence-widened', purpose: 'independence widened to saves against the executor lane (design M12)', anchor: "  if (event.kind === 'timer.set') return 'timer.set';\n  return null;", with: "  if (event.kind === 'timer.set') return 'timer.set';\n  if (event.kind === 'port' && nameOf(event) === 'persistence.save') return 'publish';\n  return null;" },
  { name: 'undefined-as-null', purpose: 'undefined compared equal to null (design M12)', anchor: '        if (shapeText(r.values[key]) !== shapeText(p.values[key])) return { kind: \'value\', at: offset, field: key };', with: '        if (shapeText(r.values[key]).replaceAll(\'{"$dr":"undefined"}\', \'null\') !== shapeText(p.values[key]).replaceAll(\'{"$dr":"undefined"}\', \'null\')) return { kind: \'value\', at: offset, field: key };' },
  { name: 'save-bytes-skipped', purpose: 'the saved bytes against the recording\'s digest not checked', anchor: "    if (event.kind !== 'port' || nameOf(event) !== 'persistence.save' || event.ledger === null) continue;", with: '    continue;' },
  { name: 'census-shutdown-skipped', purpose: 'a settled shutdown with live timers not reported', anchor: '      if (left.length) findings.push(', with: '      if (false) findings.push(' },
  { name: 'latency-advanced-unreported', purpose: 'an earlier launch not reported', anchor: "    else if (order < 0) findings.push(", with: '    else if (false) findings.push(' },
  { name: 'durability-waiters-skipped', purpose: 'waiter resolutions not checked against resolved saves', anchor: "    if (event.kind === 'settle' && event.head.outcome === 'resolve' && WAITERS.has(", with: "    if (false && event.kind === 'settle' && event.head.outcome === 'resolve' && WAITERS.has(" },
  { name: 'capacity-always-allowed', purpose: 'a capacity hold allowed without the admitLaunch hook', anchor: '        const hooked = hasAdmitHook(context.options.get(save.c));', with: '        const hooked = true;' },
  { name: 'observed-run-ignored', purpose: 'the candidate\'s run past the first difference not read (launches judged only in the cut trace)', anchor: '  const seen = observed ? { ...observed, context: analyse(preparePlain(observed.events)) } : null;', with: '  const seen = null;' },
  { name: 'duplicate-as-advanced', purpose: 'a second launch of a task reported as an owner\'s timing decision, not a defect', anchor: "    else if (got.n > 1 && recorded.has(`${got.c}:${got.taskId}:${got.port}:${got.n - 1}`)) findings.push({ rule: 'launch_duplicated',", with: "    else if (got.n > 1 && recorded.has(`${got.c}:${got.taskId}:${got.port}:${got.n - 1}`)) findings.push({ rule: 'launch_advanced'," },
  { name: 'cut-named-by-order', purpose: 'a port call the replay stopped inside named by the order rule (the value rule not reached)', anchor: '      if (complete || cu !== lastUnit || cu.end - cu.start > length) return { kind: \'head\', at: 0 };', with: "      return { kind: 'head', at: 0 };" },
  { name: 'transitions-skipped', purpose: 'the reference transition check not called', anchor: '      try { assertManagedTaskTransition(previous, aligned); } catch (error) {', with: '      try { void aligned; } catch (error) {' },
  { name: 'option-varies-ignored', purpose: 'a key read with two values accepted in read mode free', anchor: "    if (recorded.varies.size) {", with: '    if (false) {' },
];

/** A copy of the comparer with one plant, beside copies of what it imports, the packages reached through a link. */
function plantedComparer(plant) {
  const root = mkdtempSync(path.join(scratch.dir, 'compare-plant-'));
  const harness = path.join(root, 'scripts/scheduler-conformance');
  mkdirSync(harness, { recursive: true });
  for (const file of ['compare.mjs', 'replay-values.mjs', 'trace.mjs']) cpSync(path.join(HERE, file), path.join(harness, file));
  cpSync(path.join(REPOSITORY, 'scripts/client-conformance'), path.join(root, 'scripts/client-conformance'), { recursive: true });
  symlinkSync(path.join(REPOSITORY, 'packages'), path.join(root, 'packages'));
  const file = path.join(harness, 'compare.mjs');
  const text = readFileSync(file, 'utf8');
  assert.equal(text.split(plant.anchor).length - 1, 1, `${plant.name}: its anchor occurs once`);
  writeFileSync(file, text.replace(plant.anchor, () => plant.with));
  return pathToFileURL(file).href;
}

test('every planted comparer bug makes some vector answer wrongly (no check can be taken out unnoticed)', async () => {
  const independence = async (module) => {
    // A launch and a save adjacent in the reference (nothing between them), in the other order in the candidate:
    // a save is never independent of a launch, so this must stay different.
    const ref = await reference();
    const start = at(ref, isPort('executor.start'));
    const renumbered = (event, number) => ({ ...event, head: { ...event.head, port: number } });
    const extra = await save(6, ledger(starting()));
    const withSave = [...ref.slice(0, start + 2), extra, answer(6, 'promise'), ...ref.slice(start + 2)];
    const cand = [...ref.slice(0, start), renumbered(extra, 5), renumbered(answer(6, 'promise'), 5), renumbered(ref[start], 6), renumbered(ref[start + 1], 6), ...ref.slice(start + 2)];
    return module.compareCase({ reference: clone(withSave), candidate: clone(cand), mode: { independence: module.DESIGN_INDEPENDENCE } }).verdict === 'fail';
  };
  const answersRight = async (module) => {
    for (const [name, vector] of Object.entries(VECTORS)) {
      const rule = vector.rule ?? name;
      const [passRef, passCand, passOptions] = await vector.pass();
      if (module.compareCase({ reference: clone(passRef), candidate: clone(passCand), ...passOptions }).verdict !== 'pass') return `${name} (pass)`;
      const [failRef, failCand, failOptions] = await vector.fail();
      const outcome = module.compareCase({ reference: clone(failRef), candidate: clone(failCand), ...failOptions });
      if (!outcome.findings.some((finding) => finding.kind === 'fail' && finding.rule === rule)) return `${name} (fail)`;
    }
    const ref = await reference();
    const read = (key, value) => ev(1, 'in', 'read', { object: 'options', key }, { value });
    const varies = insertAt(ref, 3, read('maxTerminalRecords', 0), read('maxTerminalRecords', 1));
    if (module.compareCase({ reference: clone(varies), candidate: clone(varies), mode: { reads: 'free' } }).verdict !== 'inconclusive') return 'option-varies';
    if (!(await independence(module))) return 'independence (save against launch)';
    return null;
  };
  assert.equal(await answersRight(comparer), null, 'the unchanged comparer answers every vector right');
  for (const plant of COMPARER_PLANTS) {
    const module = await import(plantedComparer(plant));
    assert.notEqual(await answersRight(module), null, `${plant.name} (${plant.purpose}) is noticed by no vector`);
  }
  plantsJudged = true;
});
