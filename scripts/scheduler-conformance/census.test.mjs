// Self-test of the scheduler census (design file 30 §4.6, package O0e and its
// fix round 1), in the scripts suite: one recording of the toy (one bun run),
// hand-made cases for every launch situation and gap with their near misses,
// the scheduler's own contract and waivers against the scheduler, fixed
// inputs for every named check, and planted copies of the census, each of
// which must fail its own named check. Nothing here depends on time.
//
//   node --import=./scripts/test-isolation-preload.mjs --test scripts/scheduler-conformance/census.test.mjs
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import * as census from './census.mjs';
import { createScratch, HARNESS_DIR, recordFiles, REPOSITORY_ROOT } from './record.mjs';
import { buildManifest } from './recording-manifest.mjs';
import { caseEvents, casePlacement, EXIT, readContainer } from './trace.mjs';

const TOY_DIR = path.join(HARNESS_DIR, 'toy');
const TOY_FILE = `./${path.relative(REPOSITORY_ROOT, path.join(TOY_DIR, 'toy-scheduler.toy.mjs'))}`;
const scratch = createScratch('scheduler-conformance-census-self-test');
let failed = false;
after(() => { scratch.finish(failed ? 'failed' : 'passed'); });
const guarded = (name, body) => test(name, async () => { try { await body(); } catch (error) { failed = true; throw error; } });

// One recording of the toy, started now.
const toyRecording = recordFiles({ files: [TOY_FILE], cwd: REPOSITORY_ROOT, runs: 1, plainRun: false, parallel: 1, workDir: path.join(scratch.dir, 'toy'), env: { DEVRYAN_SCHEDULER_CONFORMANCE_TARGET: path.join(TOY_DIR, 'target.json') } });
toyRecording.catch(() => {});

const toyContract = census.loadContract(path.join(TOY_DIR, 'census.json'));
const toyWaivers = census.loadWaivers(path.join(TOY_DIR, 'census-waivers.json'));
const toyBaseline = toyWaivers.waivers.map((waiver) => waiver.key);
const realContract = census.loadContract(census.CONTRACT_FILE);
const realWaivers = census.loadWaivers(census.WAIVER_FILE);
let realSurfaceMemo = null;
const realSurface = async () => (realSurfaceMemo ??= await census.productSurface(realContract.contract));

/**
 * Every item of the toy's census, `kind:name=cases/judged/call-only/past-busy/uncompared`: a change of any count
 * fails `toy-fingerprint`. The toy and its tests are fixed (its golden recording pins them), so a new count is a
 * change of the census; update this list with the reason when the census is meant to count differently.
 */
const TOY_FINGERPRINT = [
  'member:abortPort=1/1/0/0/0', 'member:arm=0/0/0/0/0', 'member:authorize=1/1/0/0/0', 'member:copy=2/2/0/0/0', 'member:echo=12/8/0/4/0',
  'member:fail=1/1/0/0/0', 'member:flags=1/1/0/0/0', 'member:gate=1/0/0/1/0', 'member:getTask=0/0/0/0/0', 'member:initialize=1/1/0/0/0',
  'member:later=5/2/2/1/0', 'member:laterAt=3/1/0/2/0', 'member:memo=1/1/0/0/0', 'member:open=1/0/0/1/0', 'member:ownWork=6/1/0/5/0',
  'member:pause=1/1/0/0/0', 'member:queueOwn=6/6/0/0/0', 'member:settleAfter=4/1/3/0/0', 'member:stop=1/1/0/0/0', 'member:submit=6/0/6/0/0',
  'member:twoTimers=1/1/0/0/0', 'member:waitForAbort=1/1/0/0/0', 'member:waitForSignals=1/0/1/0/0', 'control:markAccepted=5/5/0/0/0',
  'port:executor.start=6/6/0/0/0', 'port:executor.abort=1/1/0/0/0', 'port:executor.watch=1/1/0/0/0', 'port:persistence.load=1/1/0/0/0',
  'port:persistence.save=6/6/0/0/0', 'port:publishEvent=7/7/0/0/0', 'port:onMutationTiming=1/1/0/0/0', 'port:persistence.putShard=0/0/0/0/0',
  'option:cancelTimeout=3/3/0/0/0', 'option:createLeaseToken=1/1/0/0/0', 'option:createTaskId=1/1/0/0/0', 'option:executor=35/35/0/0/0',
  'option:expireUnacknowledged=1/1/0/0/0', 'option:now=1/1/0/0/0', 'option:onMutationTiming=2/2/0/0/0', 'option:persistence=32/32/0/0/0',
  'option:publishEvent=32/32/0/0/0', 'option:scheduleTimeout=3/3/0/0/0', 'input:in call=35/35/0/0/0', 'input:in control=5/5/0/0/0',
  'input:in callback=4/4/0/0/0', 'input:in fire=7/3/0/4/0', 'input:in abort=2/2/0/0/0', 'input:in answer=9/9/0/0/0', 'input:in read=35/35/0/0/0',
  'input:in clock=8/8/0/0/0', 'input:in draw=7/7/0/0/0', 'input:in env=6/6/0/0/0', 'input:in step=0/0/0/0/0', 'input:out port=9/9/0/0/0',
  'input:out abort=1/1/0/0/0', 'input:out timer.set=8/6/0/2/0', 'input:out timer.clear=2/2/0/0/0', 'input:out return=35/35/0/0/0',
  'input:out throw=1/1/0/0/0', 'input:out settle=20/13/0/7/0', 'place:rest=35/35/0/0/0', 'place:during=6/6/0/0/0', 'place:group=0/0/0/0/0',
  'place:return=8/8/0/0/0', 'place:with=23/23/0/0/0', 'place:settle=6/3/0/3/0',
];

/** What a closure that passed would say of a case: reproduced when every input is placed, partial up to its first busy input. */
function passingResults(read) {
  const results = new Map();
  for (const record of read.cases) {
    if (record.outcome !== 'recorded') { results.set(record.id, { outcome: record.outcome === 'empty' ? 'empty' : 'unrecordable', verdict: null }); continue; }
    const { limit, events } = casePlacement(record);
    results.set(record.id, limit === 0 ? { outcome: 'crossed', verdict: null } : { outcome: limit === events ? 'reproduced' : 'partial', verdict: 'pass' });
  }
  return results;
}

let toy = null;
async function toyCorpus() {
  if (toy) return toy;
  const recorded = await toyRecording;
  const containers = recorded.recordings[0].containers;
  assert.equal(containers.length, 1, 'the toy recorded one container');
  const { name, text } = containers[0];
  const read = readContainer(text);
  assert.ok(read.cases.length > 20, 'the toy recorded its cases');
  toy = {
    name, text, read, results: passingResults(read), expected: [{ source: 'toy', testFile: read.header.testFile }],
    manifests: new Map([['toy', JSON.stringify(buildManifest('toy', [{ name, text }]))]]), surface: await census.productSurface(toyContract.contract),
  };
  return toy;
}

/** The census of the toy with its own contract, waivers and baseline (everything overridable). */
const toyCensus = (module, corpus, options = {}) => module.runCensus({
  contract: toyContract.contract, waivers: toyWaivers.waivers, baseline: toyBaseline, containers: [{ source: 'toy', name: corpus.name, text: corpus.text, read: corpus.read }],
  results: corpus.results, expected: corpus.expected, manifests: corpus.manifests, surface: corpus.surface, ...options,
});
const item = (report, kind, name) => report.items.find((entry) => entry.kind === kind && entry.name === name);
const checks = (report) => report.failures.map((failure) => failure.check);
const has = (report, check, name) => report.failures.some((failure) => failure.check === check && (name === undefined || failure.name === name));
const problem = (report, check) => report.problems.some((entry) => entry.check === check);
const counts = (entry) => entry && { cases: entry.cases, judged: entry.judged, callOnly: entry.callOnly, pastBusy: entry.pastBusy, uncompared: entry.uncompared };

// ------------------------------------------------------------------ hand-made cases

/**
 * A case built by hand: `build(e, v)` adds events (`e(dir, kind, fields, c)`,
 * construction 1 by default; every arrived input is placed `rest` unless it
 * says otherwise) and values (`v(tree)` gives a slot). Returns a read container.
 */
function handCase(name, build, { notes = [], outcome = 'recorded' } = {}) {
  const table = new Map();
  const events = [];
  const v = (tree) => { const slot = `=${(table.size + 1).toString(16).padStart(16, '0')}`; table.set(slot, tree); return slot; };
  const e = (dir, kind, fields = {}, c = 1) => { events.push({ c, event: { seq: 0, at: events.length + 1, dir, kind, ...fields } }); };
  const construct = (c = 1) => { e('in', 'call', { call: 0, member: 'createManagedTaskScheduler', args: v([{}]), place: 'rest' }, c); e('out', 'return', { call: 0, value: v({ $dr: 'port', name: `scheduler#${c}` }) }, c); };
  construct();
  build({ e, v, construct });
  const constructions = [...new Set(events.map((entry) => entry.c))].map((n) => ({ n, defaulted: [], events: events.filter((entry) => entry.c === n).map((entry, index) => ({ ...entry.event, seq: index + 1 })) }));
  const record = { id: `hand ${name}`, kind: 'test', file: 'hand', line: 1, describe: [], name, status: 'passed', outcome, flags: [], notes, events: events.length, constructions };
  return { header: { testFile: `hand/${name}` }, cases: [record], resolve: (slot) => table.get(slot) };
}
const error = (code, message) => ({ $dr: 'class', name: code ? 'ManagedOrchestrationError' : 'Error', value: code ? { name: 'ManagedOrchestrationError', code } : {}, error: { name: code ? 'ManagedOrchestrationError' : 'Error', message } });
// Port and call helpers over `e` and `v`: a port call with a pending promise, its settlement, a member or control call returning a promise.
const helpers = ({ e, v }) => {
  let ports = 0;
  let calls = 0;
  return {
    port: (name, args = [], { answer = 'promise', value } = {}, c = 1) => { ports += 1; e('out', 'port', { port: ports, name, args: v(args) }, c); if (answer === 'promise') e('in', 'answer', { port: ports, outcome: 'promise' }, c); else if (answer) e('in', 'answer', { port: ports, outcome: answer, value: v(value) }, c); return ports; },
    resolve: (port, value = null, outcome = 'resolve', c = 1) => e('in', 'answer', { port, outcome, value: v(value), place: 'rest' }, c),
    call: (member, { place = 'rest', value, promise = true } = {}, c = 1) => { calls += 1; e('in', 'call', { call: calls, member, args: v([]), place }, c); if (promise) e('out', 'return', { call: calls, promise: true }, c); else e('out', 'return', { call: calls, value: v(value) }, c); return calls; },
    control: (method, of, { place = 'rest', value, promise = true } = {}, c = 1) => { calls += 1; e('in', 'control', { call: calls, of, method, args: v([]), place }, c); if (promise) e('out', 'return', { call: calls, promise: true }, c); else e('out', 'return', { call: calls, value: v(value) }, c); return calls; },
    settle: (call, outcome, value = null, c = 1) => e('out', 'settle', { call, outcome, value: v(value) }, c),
    read: (key, value, c = 1) => e('in', 'read', { object: 'options', key, value: v(value) }, c),
    fire: (timer, c = 1) => e('in', 'fire', { call: 0, timer, place: 'rest' }, c),
  };
};

/** One hand-made case per launch situation and gap, each of which must show exactly its own item among those. */
const HAND = {
  'simultaneous-submits': (x) => { const h = helpers(x); h.call('submit'); h.call('submit'); },
  'submit-while-launch-pending': (x) => { const h = helpers(x); h.port('executor.start', [{ taskId: 't1' }]); h.call('submit'); },
  'fan-out-8': (x) => { const h = helpers(x); for (let n = 0; n < 8; n += 1) h.port('executor.start', [{ taskId: `t${n}` }], { answer: 'return', value: null }); },
  'launch-behind-held-save': (x) => { const h = helpers(x); const save = h.port('persistence.save', [{ tasks: [] }]); h.call('submit'); h.resolve(save); h.port('executor.start', [{ taskId: 't1' }], { answer: 'return', value: null }); },
  'save-rejected-then-launch': (x) => { const h = helpers(x); const save = h.port('persistence.save', [{ tasks: [] }]); h.resolve(save, error(null, 'disk full'), 'reject'); h.port('executor.start', [{ taskId: 't1' }], { answer: 'return', value: null }); },
  'restart-recovery': (x) => { const h = helpers(x); const load = h.port('persistence.load'); h.resolve(load, { tasks: [{ taskId: 't1', status: 'running' }] }); h.port('executor.reconcile', [{ taskId: 't1' }]); },
  'launch-after-recovery': (x) => { const h = helpers(x); const load = h.port('persistence.load'); h.resolve(load, { tasks: [{ taskId: 't1', status: 'starting' }] }); h.port('executor.observe', [{ taskId: 't1' }]); h.port('executor.start', [{ taskId: 't2' }], { answer: 'return', value: null }); },
  'runtime-restart-deferred-launch': (x) => { const h = helpers(x); const call = h.call('withRuntimeRestart'); h.port('executor.resume', [{ taskId: 't1' }], { answer: 'return', value: null }); h.settle(call, 'resolve'); },
  'prerequisites-hold': (x) => { const h = helpers(x); h.port('persistence.save', [{ tasks: [{ taskId: 't1', status: 'queued', waitingReason: { kind: 'prerequisites' } }] }]); },
  'auto-resume-attempt': (x) => { const h = helpers(x); h.port('autoResume.attempt', [{}]); },
  'handoff-refusal': (x) => { const h = helpers(x); const call = h.call('submit'); h.settle(call, 'reject', error('handoff_in_progress', 'handoff')); },
  'cancel-during-launch': (x) => { const h = helpers(x); h.port('executor.retryInPlace', [{ taskId: 't1' }]); h.call('cancelTask'); },
  'reconcile-retry-pending': (x) => { const h = helpers(x); for (let n = 0; n < 2; n += 1) { const port = h.port('executor.reconcile', [{ taskId: 't1' }]); h.resolve(port, { state: 'transient' }); } },
  'handoff-abort-timeout': ({ e, v, ...x }) => { const h = helpers({ e, v, ...x }); const call = h.call('confirmAgentHandoff'); e('out', 'abort', { signal: 1, reason: v(error(null, 'Managed task abort exceeded 5000ms')) }); h.settle(call, 'reject', error('handoff_abort_unconfirmed', 'x')); },
  'restart-starting-with-deadline': (x) => { const h = helpers(x); const load = h.port('persistence.load'); h.resolve(load, { tasks: [{ taskId: 't1', status: 'starting', timeoutAt: 5 }] }); },
  'getTask-missing': (x) => { const h = helpers(x); h.call('getTask', { promise: false, value: null }); },
  'initialize-after-shutdown': (x) => { const h = helpers(x); const call = h.call('initialize'); h.settle(call, 'reject', error('scheduler_shut_down', 'shut down')); },
  'publish-failure': (x) => { const h = helpers(x); h.port('publishEvent', [{}], { answer: 'throw', value: error(null, 'publish failed') }); },
  'failed-mutation-timing': (x) => { const h = helpers(x); h.port('onMutationTiming', [{ waitMs: 0, holdMs: 0, failed: true }], { answer: 'return', value: null }); },
  'fake-timers-case': (x) => { const h = helpers(x); h.call('getTask', { promise: false, value: 'x' }); },
  'publication-beside-launch': (x) => { const h = helpers(x); h.port('executor.start', [{ taskId: 't1' }]); h.port('publishEvent', [{}], { answer: 'return', value: null }); },
  'restart-with-operator-stop': (x) => { const h = helpers(x); const load = h.port('persistence.load'); h.resolve(load, { tasks: [{ taskId: 't1', status: 'running', operatorStop: { state: 'pending' } }] }); },
  'restart-during-runtime-restart': (x) => { const h = helpers(x); h.call('withRuntimeRestart'); x.construct(2); },
};
/**
 * Further hand cases, each with the launch situations and gaps it must show (most none: the near miss of one
 * predicate): the other direction of a publication beside a launch, and the near miss of every predicate whose
 * weakened form a plant tries.
 */
const NEAR = [
  { name: 'sequential submits', shows: [], build: (x) => { const h = helpers(x); const one = h.call('submit'); h.settle(one, 'resolve'); h.call('submit'); } },
  { name: 'cancel after launch', shows: [], build: (x) => { const h = helpers(x); const port = h.port('executor.start', [{ taskId: 't1' }]); h.resolve(port); h.call('cancelTask'); } },
  { name: 'seven launches', shows: [], build: (x) => { const h = helpers(x); for (let n = 0; n < 7; n += 1) h.port('executor.start', [{ taskId: `t${n}` }], { answer: 'return', value: null }); } },
  { name: 'submit refused for another reason', shows: [], build: (x) => { const h = helpers(x); const call = h.call('submit'); h.settle(call, 'reject', error('task_invalid', 'invalid')); } },
  { name: 'restart with only queued tasks', shows: [], build: (x) => { const h = helpers(x); const load = h.port('persistence.load'); h.resolve(load, { tasks: [{ taskId: 't1', status: 'queued' }, { taskId: 't2', status: 'completed' }] }); h.port('executor.reconcile', [{ taskId: 't1' }]); } },
  { name: 'publication before launch', shows: ['publication-beside-launch'], build: (x) => { const h = helpers(x); h.port('publishEvent', [{}], { answer: 'return', value: null }); h.port('executor.start', [{ taskId: 't1' }]); } },
  { name: 'transient reconciles around a fire', shows: [], build: (x) => { const h = helpers(x); const one = h.port('executor.reconcile', [{ taskId: 't1' }]); h.resolve(one, { state: 'transient' }); h.fire(1); const two = h.port('executor.reconcile', [{ taskId: 't1' }]); h.resolve(two, { state: 'transient' }); } },
  { name: 'runtime restart unsettled, no later construction', shows: [], build: (x) => { const h = helpers(x); h.call('withRuntimeRestart'); h.call('getTask', { promise: false, value: { taskId: 't1' } }); } },
  { name: 'launch in a later construction', shows: ['restart-recovery'], build: (x) => { const h = helpers(x); const load = h.port('persistence.load'); h.resolve(load, { tasks: [{ taskId: 't1', status: 'running' }] }); h.port('executor.reconcile', [{ taskId: 't1' }]); x.construct(2); h.port('executor.start', [{ taskId: 't2' }], { answer: 'return', value: null }, 2); } },
  { name: 'mutation timing that did not fail', shows: [], build: (x) => { const h = helpers(x); h.port('onMutationTiming', [{ waitMs: 0, holdMs: 0, failed: false }], { answer: 'return', value: null }); } },
];
const handCases = () => Object.entries(HAND).map(([name, build]) => handCase(name, build, { notes: name === 'fake-timers-case' ? ['fake-timers'] : [] }));
/** The census of hand cases with the real contract and nothing else (no verdicts, no corpus, no surface). */
const handCensus = (module, ...reads) => module.runCensus({ contract: realContract.contract, containers: reads.map((read) => ({ source: 'hand', read })), results: null, expected: null, surface: null, baseline: null });
/** The launch and gap items one hand case shows, by the census of `module`, with the real contract. */
const handItems = (module, read) => handCensus(module, read).items.filter((entry) => (entry.kind === 'launch' || entry.kind === 'gap') && entry.cases > 0).map((entry) => `${entry.name}${entry.judged ? '' : ' (not judged)'}`);
/** A hand case's results as a passing closure would give them, overridable per case. */
const handResults = (read, outcome) => new Map(read.cases.map((record) => [record.id, outcome ?? passingResults(read).get(record.id)]));

/** A copy of a container's text without its last case, well formed (its value table and end line rewritten). */
function withoutLastCase(text) {
  const lines = text.slice(0, -1).split('\n');
  const values = JSON.parse(lines[1]).values;
  const kept = lines.slice(2, -2);
  const order = [];
  const seen = new Set();
  const visit = (entry) => {
    if (typeof entry === 'string' && /^=[0-9a-f]{16}$/.test(entry)) { const hash = entry.slice(1); if (!seen.has(hash)) { seen.add(hash); order.push(hash); } return; }
    if (Array.isArray(entry)) { for (const part of entry) visit(part); return; }
    if (entry && typeof entry === 'object') for (const key of Object.keys(entry)) visit(entry[key]);
  };
  let events = 0;
  for (const line of kept) { const record = JSON.parse(line).case; events += record.events; visit(record.constructions); }
  const table = {};
  for (const hash of order) table[hash] = values[hash];
  return `${[lines[0], JSON.stringify({ values: table }), ...kept, JSON.stringify({ end: { cases: kept.length, events } })].join('\n')}\n`;
}

// ------------------------------------------------------------------ the named checks

/** Each check takes a census module and answers null when it holds, or what is wrong. */
const CHECKS = {
  'toy-whole': async (module) => {
    const report = toyCensus(module, await toyCorpus());
    return report.code === EXIT.pass && report.failures.length === 0 && report.problems.length === 0 ? null : `exit ${report.code}: ${JSON.stringify([...report.failures, ...report.problems].slice(0, 3))}`;
  },
  // Every count of every item of the toy, pinned.
  'toy-fingerprint': async (module) => {
    const report = toyCensus(module, await toyCorpus());
    const found = report.items.map((entry) => `${entry.kind}:${entry.name}=${entry.cases}/${entry.judged}/${entry.callOnly}/${entry.pastBusy}/${entry.uncompared}`);
    const changed = found.filter((line) => !TOY_FINGERPRINT.includes(line));
    return changed.length || found.length !== TOY_FINGERPRINT.length ? `the toy's counts changed: ${changed.slice(0, 4).join(', ')} (${found.length} items, pinned ${TOY_FINGERPRINT.length})` : null;
  },
  // Every member's and control method's counts against an independent count of the toy's raw events: judged by a result inside the prefix.
  'member-count': async (module) => {
    const corpus = await toyCorpus();
    const report = toyCensus(module, corpus);
    for (const [kind, names, field] of [['member', toyContract.contract.members, 'member'], ['control', toyContract.contract.control, 'method']]) {
      for (const name of names) {
        const want = { cases: 0, judged: 0, callOnly: 0, rest: 0 };
        for (const record of corpus.read.cases.filter((entry) => entry.outcome === 'recorded')) {
          const list = caseEvents(record);
          const { limit } = casePlacement(record, list);
          const answered = new Map();
          list.forEach((event, index) => { const key = `${event.c}:${event.call}`; if (event.dir === 'out' && ((event.kind === 'return' && !event.promise) || event.kind === 'throw' || event.kind === 'settle') && !answered.has(key)) answered.set(key, index); });
          const calls = list.flatMap((event, index) => (event.dir === 'in' && event.kind === (kind === 'member' ? 'call' : 'control') && (kind === 'control' || event.call > 0) && event[field] === name ? [{ index, result: answered.get(`${event.c}:${event.call}`) ?? Infinity }] : []));
          if (!calls.length) continue;
          want.cases += 1;
          if (limit > 0 && calls.some((call) => call.result < limit)) want.judged += 1;
          else if (limit > 0 && calls.some((call) => call.index < limit)) want.callOnly += 1;
          else want.rest += 1;
        }
        const got = item(report, kind, name);
        if (!got || got.cases !== want.cases || got.judged !== want.judged || got.callOnly !== want.callOnly || got.pastBusy + got.uncompared !== want.rest) return `${kind} ${name}: census ${JSON.stringify(counts(got))}, events ${JSON.stringify(want)}`;
      }
    }
    return null;
  },
  // Every option's counts against an independent count of the toy's reads: given when the test gave it (not supplied, neither undefined nor null).
  'option-count': async (module) => {
    const corpus = await toyCorpus();
    const report = toyCensus(module, corpus);
    for (const name of toyContract.contract.options) {
      let cases = 0;
      for (const record of corpus.read.cases.filter((entry) => entry.outcome === 'recorded')) {
        const given = caseEvents(record).some((event) => {
          if (event.dir !== 'in' || event.kind !== 'read' || event.object !== 'options' || event.op !== undefined || event.key !== name || event.supplied) return false;
          const tree = corpus.read.resolve(event.value);
          return tree !== null && !(tree && typeof tree === 'object' && tree.$dr === 'undefined');
        });
        if (given) cases += 1;
      }
      const got = item(report, 'option', name);
      if (got?.cases !== cases) return `option ${name}: the census counts ${got?.cases} cases, the reads ${cases}`;
    }
    return null;
  },
  // A member the toy calls only after its case's first busy input is recorded, never judged; so is a launch situation past it.
  'busy-point': async (module) => {
    const report = toyCensus(module, await toyCorpus(), { waivers: [] });
    const gate = item(report, 'member', 'gate');
    if (!(gate?.cases > 0 && gate.judged === 0 && gate.callOnly === 0 && gate.pastBusy === gate.cases)) return `gate: ${JSON.stringify(counts(gate))}`;
    if (!has(report, 'census-member', 'member:gate')) return 'gate, recorded only past a busy input and not waived, does not fail census-member';
    return null;
  },
  'busy-point-launch': async (module) => {
    const read = handCase('busy launch', (x) => { const h = helpers(x); h.call('submit'); h.call('submit', { place: 'busy' }); });
    const situation = item(handCensus(module, read), 'launch', 'simultaneous-submits');
    return situation.cases === 1 && situation.judged === 0 && situation.recorded === 1 ? null : `a launch situation completed by a busy input: ${JSON.stringify(counts(situation))}`;
  },
  // S1: a member and a control method are judged by the answer the scheduler gave them inside the prefix, not by their call.
  'judged-by-result': async (module) => {
    const late = handCase('result past busy', (x) => { const h = helpers(x); const call = h.call('confirmAgentHandoff'); const control = h.control('markAccepted', 1); h.call('getTask', { place: 'busy', promise: false, value: null }); h.settle(call, 'reject', error('handoff_abort_unconfirmed', 'x')); h.settle(control, 'resolve', true); });
    const early = handCase('result in prefix', (x) => { const h = helpers(x); const call = h.call('confirmAgentHandoff'); const control = h.control('markAccepted', 1); h.settle(call, 'resolve', null); h.settle(control, 'resolve', true); h.call('getTask', { place: 'busy', promise: false, value: null }); });
    const never = handCase('result never', (x) => { const h = helpers(x); h.call('confirmAgentHandoff'); });
    const want = (report, kind, name, judged, callOnly) => { const got = item(report, kind, name); return got.judged === judged && got.callOnly === callOnly ? null : `${kind} ${name}: ${JSON.stringify(counts(got))}, want judged ${judged}, call-only ${callOnly}`; };
    const on = (read) => module.runCensus({ contract: realContract.contract, containers: [{ source: 'hand', read }], results: handResults(read), expected: null, surface: null, baseline: null });
    return want(on(late), 'member', 'confirmAgentHandoff', 0, 1) ?? want(on(late), 'control', 'markAccepted', 0, 1) ?? want(on(early), 'member', 'confirmAgentHandoff', 1, 0)
      ?? want(on(early), 'control', 'markAccepted', 1, 0) ?? want(on(never), 'member', 'confirmAgentHandoff', 0, 1);
  },
  // A member called by a later construction (after a restart) counts like one called by the first.
  'later-construction': async (module) => {
    const read = handCase('member after restart', (x) => { const h = helpers(x); x.construct(2); h.call('getTask', { promise: false, value: null }, 2); });
    const got = item(handCensus(module, read), 'member', 'getTask');
    return got.cases === 1 && got.judged === 1 ? null : `a member of the second construction: ${JSON.stringify(counts(got))}`;
  },
  'waiver-stale': async (module) => {
    const corpus = await toyCorpus();
    const waivers = [...toyWaivers.waivers, { kind: 'member', name: 'echo', class: 'past-busy', needs: 'placed test', reason: 'planted', key: 'member:echo' }, { kind: 'member', name: 'noSuchMember', class: 'unreached', needs: 'test', reason: 'planted', key: 'member:noSuchMember' }];
    const report = toyCensus(module, corpus, { waivers, baseline: waivers.map((waiver) => waiver.key) });
    if (!has(report, 'waiver-exercised', 'member:echo')) return 'a waiver of a judged member is accepted';
    if (!has(report, 'waiver-unknown', 'member:noSuchMember')) return 'a waiver of no member is accepted';
    return report.code === EXIT.fail ? null : `exit ${report.code}`;
  },
  'waiver-baseline': async (module) => {
    const report = toyCensus(module, await toyCorpus(), { baseline: toyBaseline.filter((key) => key !== 'member:arm') });
    return has(report, 'waiver-new', 'member:arm') && report.code === EXIT.fail ? null : 'a waiver not in the baseline is accepted';
  },
  // S3: a waiver whose class the corpus does not bear out fails, exactly on the whole corpus and where a part refutes it.
  'waiver-class': async (module) => {
    const corpus = await toyCorpus();
    if (has(toyCensus(module, corpus), 'waiver-class')) return `the toy's own waivers fail: ${JSON.stringify(toyCensus(module, corpus).failures.slice(0, 2))}`;
    const restated = (changes) => toyWaivers.waivers.map((waiver) => (changes[waiver.key] ? { ...waiver, ...changes[waiver.key] } : waiver));
    const cases = [
      ['member:arm', { class: 'past-busy', needs: 'placed test' }],
      ['member:gate', { class: 'unreached', needs: 'test' }],
      ['member:submit', { class: 'past-busy', needs: 'placed test' }],
      ['member:gate', { class: 'call-only', needs: 'placed test' }],
    ];
    for (const [key, change] of cases) {
      const report = toyCensus(module, corpus, { waivers: restated({ [key]: change }) });
      if (!has(report, 'waiver-class', key)) return `${key} waived as ${change.class} is accepted on the whole toy`;
    }
    // On a part of the corpus (another file missing), only a refutation fails: an unreached item some case shows, a past-busy one with a call-only case.
    const part = { expected: [...corpus.expected, { source: 'toy', testFile: 'scripts/scheduler-conformance/toy/absent.toy.mjs' }] };
    const refuted = toyCensus(module, corpus, { ...part, waivers: restated({ 'member:gate': { class: 'unreached', needs: 'test' }, 'member:submit': { class: 'past-busy', needs: 'placed test' } }) });
    if (!has(refuted, 'waiver-class', 'member:gate') || !has(refuted, 'waiver-class', 'member:submit')) return `on a part of the corpus a refuted class is accepted: ${JSON.stringify(checks(refuted))}`;
    const unrefuted = toyCensus(module, corpus, { ...part, waivers: restated({ 'member:arm': { class: 'past-busy', needs: 'placed test' } }) });
    return has(unrefuted, 'waiver-class') ? 'on a part of the corpus a class it cannot refute fails' : null;
  },
  // The waiver file: a kind, a name, a class, a need its class allows and a reason, none twice; and its problems fail the census.
  'waiver-file': async (module) => {
    const base = { kind: 'member', name: 'arm', class: 'unreached', needs: 'test', reason: 'r' };
    const bad = [
      ['no reason', [{ ...base, reason: ' ' }]], ['no class', [{ ...base, class: undefined }]], ['an unknown class', [{ ...base, class: 'later' }]],
      ['a need its class does not allow', [{ ...base, needs: 'placed test' }]], ['a port call-only', [{ ...base, kind: 'port', name: 'publishEvent', class: 'call-only', needs: 'placed test' }]],
      ['a waiver twice', [base, base]], ['no kind', [{ ...base, kind: 'thing' }]],
    ];
    for (const [what, waivers] of bad) {
      const { problems } = module.checkWaivers({ version: 1, waivers });
      if (!problems.length) return `a waiver file with ${what} is accepted`;
    }
    if (module.checkWaivers({ version: 1, waivers: [base] }).problems.length) return 'a well-formed waiver is refused';
    const report = toyCensus(module, await toyCorpus(), { waiverProblems: ['planted'] });
    return has(report, 'waiver-invalid') ? null : 'the waiver file\'s problems do not fail the census';
  },
  // The contract file: every list (and data) a list of distinct names.
  'contract-file': async (module) => {
    const base = structuredClone(toyContract.contract);
    for (const [what, change] of [['a member twice', { members: ['submit', 'submit'] }], ['no data list', { data: undefined }], ['a port twice', { ports: ['publishEvent', 'publishEvent'] }], ['no target', { target: undefined }], ['another version', { version: 2 }]]) {
      if (!module.checkContract({ ...base, ...change }).length) return `a contract with ${what} is accepted`;
    }
    return module.checkContract(base).length ? 'the toy\'s contract is refused' : null;
  },
  'empty-corpus': async (module) => {
    const corpus = await toyCorpus();
    const report = module.runCensus({ contract: toyContract.contract, waivers: [], baseline: [], containers: [], results: new Map(), expected: [], surface: corpus.surface });
    if (report.code !== EXIT.inconclusive || !problem(report, 'empty-corpus')) return `an empty corpus exits ${report.code}`;
    // A corpus whose only case built no scheduler is empty too.
    const empty = handCase('no scheduler', () => {}, { outcome: 'empty' });
    const none = module.runCensus({ contract: toyContract.contract, waivers: [], baseline: [], containers: [{ source: 'hand', read: empty }], results: new Map([[empty.cases[0].id, { outcome: 'empty', verdict: null }]]), expected: null, surface: corpus.surface });
    return problem(none, 'empty-corpus') ? null : 'a corpus with cases but none recorded is not empty';
  },
  // A corpus that is not the whole one is inconclusive, and nothing fails for being unexercised (no waivers here).
  'incomplete-corpus': async (module) => {
    const corpus = await toyCorpus();
    for (const [what, expected] of [
      ['a missing file', [...corpus.expected, { source: 'toy', testFile: 'scripts/scheduler-conformance/toy/absent.toy.mjs' }]],
      ['a missing case', [{ ...corpus.expected[0], cases: [...corpus.read.cases.map((record) => record.name), 'a case no container holds'] }]],
      ['no whole corpus named', null],
    ]) {
      const report = toyCensus(module, corpus, { waivers: [], expected });
      if (report.code !== EXIT.inconclusive || !problem(report, 'corpus-incomplete')) return `a corpus with ${what} exits ${report.code}`;
      if (report.failures.length) return `a corpus with ${what} fails ${checks(report).join(', ')}`;
    }
    return null;
  },
  // B2: a source whose containers are not the ones its recording wrote (by its manifest) is inconclusive, never complete.
  manifest: async (module) => {
    const corpus = await toyCorpus();
    const line = corpus.text.split('\n').findIndex((entry) => entry.includes('"place":"rest"'));
    const remarked = corpus.text.split('\n').map((entry, index) => (index === line ? entry.replace('"place":"rest"', '"place":"during"') : entry)).join('\n');
    const variants = [
      ['a case dropped', { containers: [{ source: 'toy', name: corpus.name, text: withoutLastCase(corpus.text) }] }],
      ['the file cut short', { containers: [{ source: 'toy', name: corpus.name, text: corpus.text.slice(0, -200), read: corpus.read }] }],
      ['a file cut short that cannot be read', { containers: [{ source: 'toy', name: corpus.name, text: corpus.text.slice(0, corpus.text.lastIndexOf('\n', corpus.text.length - 2) + 1) }] }],
      ['a case re-marked', { containers: [{ source: 'toy', name: corpus.name, text: remarked, read: corpus.read }] }],
      ['the container missing', { containers: [] }],
      ['a container not in the manifest', { containers: [{ source: 'toy', name: corpus.name, text: corpus.text, read: corpus.read }, { source: 'toy', name: 'other.ndjson', text: corpus.text, read: { ...corpus.read, header: { ...corpus.read.header, testFile: 'other' }, cases: [] } }] }],
      ['no manifest', { manifests: new Map() }],
      ['a manifest of another source', { manifests: new Map([['toy', JSON.stringify(buildManifest('tests', [{ name: corpus.name, text: corpus.text }]))]]) }],
    ];
    for (const [what, options] of variants) {
      const report = toyCensus(module, corpus, options);
      if (report.code === EXIT.pass || !problem(report, 'corpus-manifest')) return `${what}: exit ${report.code}, ${JSON.stringify(report.problems.map((entry) => entry.check))}`;
      if (report.complete) return `${what}: the census calls the corpus complete`;
    }
    return null;
  },
  // OD2: the cases whose compared prefix reads one key with two values, against an independent count over the raw reads; a variation past busy counts only as whole.
  'option-varies': async (module) => {
    const corpus = await toyCorpus();
    const report = toyCensus(module, corpus);
    let cases = 0;
    const keys = {};
    for (const record of corpus.read.cases.filter((entry) => entry.outcome === 'recorded')) {
      const list = caseEvents(record);
      const { limit } = casePlacement(record, list);
      const values = new Map();
      const varying = new Set();
      for (const event of list.slice(0, limit)) {
        if (event.dir !== 'in' || event.kind !== 'read') continue;
        const key = `${event.object}|${event.op ?? 'get'}|${event.key}`;
        const value = `${JSON.stringify(event.found ?? null)}|${event.value}`;
        if (values.has(`${event.c}|${key}`) && values.get(`${event.c}|${key}`) !== value) varying.add(key);
        else values.set(`${event.c}|${key}`, value);
      }
      if (varying.size) cases += 1;
      for (const key of varying) keys[key] = (keys[key] ?? 0) + 1;
    }
    if (cases === 0) return 'the toy no longer has an option-varies case: the check has nothing to count';
    if (report.varies.cases !== cases || JSON.stringify(Object.entries(report.varies.keys).sort()) !== JSON.stringify(Object.entries(keys).sort())) return `census ${report.varies.cases} ${JSON.stringify(report.varies.keys)}, reads ${cases} ${JSON.stringify(keys)}`;
    const past = handCase('varies past busy', (x) => { const h = helpers(x); h.read('onMutationTiming', null); h.call('getTask', { place: 'busy', promise: false, value: null }); h.read('onMutationTiming', { $dr: 'function', name: 'f' }); });
    const pastReport = module.runCensus({ contract: realContract.contract, containers: [{ source: 'hand', read: past }], results: handResults(past), expected: null, surface: null, baseline: null });
    return pastReport.varies.cases === 0 && pastReport.varies.whole === 1 ? null : `a variation only past busy: ${JSON.stringify(pastReport.varies)}`;
  },
  unreplayed: async (module) => {
    const report = toyCensus(module, await toyCorpus(), { results: null });
    return report.code === EXIT.inconclusive && problem(report, 'unreplayed') ? null : `a census with no closure verdicts exits ${report.code}`;
  },
  // A case the closure did not pass judges nothing: found different, or reproduced with a comparer that did not pass.
  'judged-needs-verdict': async (module) => {
    const corpus = await toyCorpus();
    for (const [what, wrong] of [['different', { outcome: 'different', verdict: null }], ['reproduced with a failing comparer', { outcome: 'reproduced', verdict: 'fail' }]]) {
      const results = new Map([...corpus.results].map(([id, result]) => [id, result.verdict === 'pass' ? { ...wrong, outcome: wrong.outcome === 'reproduced' ? result.outcome : wrong.outcome } : result]));
      const report = toyCensus(module, corpus, { results });
      const echo = item(report, 'member', 'echo');
      if (!(echo.judged === 0 && report.cases.judged === 0 && report.code === EXIT.fail)) return `cases the closure found ${what} still judge: echo ${JSON.stringify(counts(echo))}, ${report.cases.judged} cases`;
    }
    return null;
  },
  // A case whose compared prefix is empty (its first input busy) judges nothing, whatever its verdict says.
  'crossed-not-judged': async (module) => {
    const read = handCase('crossed', (x) => { const h = helpers(x); h.call('getTask', { promise: false, value: null }); });
    read.cases[0].constructions[0].events[0].place = 'busy';
    const report = module.runCensus({ contract: realContract.contract, containers: [{ source: 'hand', read }], results: handResults(read, { outcome: 'partial', verdict: 'pass' }), expected: null, surface: null, baseline: null });
    return report.cases.judged === 0 && item(report, 'member', 'getTask').judged === 0 ? null : `a case with an empty prefix judged: ${report.cases.judged} cases`;
  },
  // The verdicts against the cases: one missing, one extra, a case twice, a reproduction of a case with a busy input.
  'census-results': async (module) => {
    const corpus = await toyCorpus();
    const busy = corpus.read.cases.find((record) => record.outcome === 'recorded' && casePlacement(record).limit < record.events);
    const first = corpus.read.cases.find((record) => record.outcome === 'recorded');
    const variants = [
      ['a verdict missing', { results: new Map([...corpus.results].filter(([id]) => id !== first.id)) }, first.id],
      ['a verdict for no case', { results: new Map([...corpus.results, ['no such case', { outcome: 'reproduced', verdict: 'pass' }]]) }, 'no such case'],
      ['a case twice', { containers: [0, 1].map((n) => ({ source: 'toy', name: `${n}-${corpus.name}`, text: corpus.text, read: corpus.read })) }, first.id],
      ['a case with a busy input reproduced', { results: new Map([...corpus.results, [busy.id, { outcome: 'reproduced', verdict: 'pass' }]]) }, busy.id],
    ];
    for (const [what, options, name] of variants) {
      const report = toyCensus(module, corpus, options);
      if (!has(report, 'census-results', name) || report.code !== EXIT.fail) return `${what} is accepted (exit ${report.code})`;
    }
    return null;
  },
  'closure-code': async (module) => {
    const corpus = await toyCorpus();
    const failing = toyCensus(module, corpus, { closureCode: EXIT.fail });
    const unsure = toyCensus(module, corpus, { closureCode: EXIT.inconclusive });
    if (failing.code !== EXIT.fail || !checks(failing).includes('closure')) return `a failed closure gives census exit ${failing.code}`;
    return unsure.code === EXIT.inconclusive && problem(unsure, 'closure-inconclusive') ? null : `an inconclusive closure gives census exit ${unsure.code}`;
  },
  // Each list of the toy's contract against a product surface that gained an item, and a surface the census could not read.
  'contract-drift': async (module) => {
    const corpus = await toyCorpus();
    const { surface } = corpus;
    const variants = [
      ['contract-members', { members: [...surface.members, 'aNewMember'] }],
      ['contract-control', { control: [...surface.control, 'aNewControl'] }],
      ['contract-control', { control: null }],
      ['contract-options', { options: [...surface.options, 'aNewOption'] }],
      ['contract-ports', { ports: { ...surface.ports, members: [...surface.ports.members, { name: 'executor.aNewPort', called: true }] } }],
      ['contract-ports', { ports: { ...surface.ports, functions: [...surface.ports.functions, 'aNewHook'] } }],
      ['contract-ports', { ports: { ...surface.ports, unresolved: ['executor[name] at line 1'] } }],
      ['contract-inputs', { inputs: [...surface.inputs, 'in something'] }],
      ['contract-places', { places: [...surface.places, 'somewhere'] }],
    ];
    for (const [check, change] of variants) if (!checks(toyCensus(module, corpus, { surface: { ...surface, ...change } })).includes(check)) return `a surface with ${JSON.stringify(change).slice(0, 80)} does not fail ${check}`;
    const blind = toyCensus(module, corpus, { surface: null });
    return blind.code !== EXIT.pass && problem(blind, 'no-surface') ? null : `a census given no product surface exits ${blind.code}`;
  },
  // B1: an item of each kind dropped from the scheduler's contract with its waiver fails a named check, on no corpus at all.
  'contract-drop': async (module) => {
    const surface = await realSurface();
    const { contract } = realContract;
    const drops = [
      ['member', 'getRequiredCheckTasks', 'contract-members'], ['control', 'assertPrerequisites', 'contract-control'], ['control', 'readPriorFailureReason', 'contract-control'],
      ['port', 'logger.error', 'contract-ports'], ['port', 'onBarrierChange', 'contract-ports'], ['port', 'executor.resume', 'contract-ports'],
      ['option', 'startingLeaseTimeoutMs', 'contract-options'], ['input', 'in callback', 'contract-inputs'], ['place', 'group', 'contract-places'],
      ['launch', 'handoff-refusal', 'contract-predicates'], ['gap', 'fake-timers-case', 'contract-predicates'],
    ];
    for (const [kind, name, check] of drops) {
      const list = { member: 'members', control: 'control', port: 'ports', option: 'options', input: 'inputs', place: 'places', launch: 'launch', gap: 'gaps' }[kind];
      const report = module.runCensus({ contract: { ...contract, [list]: contract[list].filter((entry) => entry !== name) }, waivers: realWaivers.waivers.filter((waiver) => waiver.key !== `${kind}:${name}`), containers: [], results: new Map(), expected: [], surface });
      if (!has(report, check)) return `${kind} ${name} dropped with its waiver: ${JSON.stringify(checks(report))}, not ${check}`;
    }
    // A port moved to the data list (it is called) fails, and so does a data member moved to the ports.
    const moved = module.runCensus({ contract: { ...contract, ports: contract.ports.filter((entry) => entry !== 'logger.error'), data: [...contract.data, 'logger.error'] }, waivers: realWaivers.waivers.filter((waiver) => waiver.key !== 'port:logger.error'), containers: [], results: new Map(), expected: [], surface });
    if (!has(moved, 'contract-ports', 'logger.error')) return `a called port listed as data is accepted: ${JSON.stringify(checks(moved))}`;
    const unchanged = module.runCensus({ contract, waivers: realWaivers.waivers, containers: [], results: new Map(), expected: [], surface });
    return unchanged.failures.length ? `the unchanged contract fails ${JSON.stringify(checks(unchanged))}` : null;
  },
  // The census's own reading of the product: for both contracts, the surface it derives matches them.
  surface: async (module) => {
    for (const { contract } of [realContract, toyContract]) {
      const report = module.runCensus({ contract, containers: [], results: new Map(), expected: [], surface: await module.productSurface(contract) });
      const drifted = report.failures.filter((failure) => failure.check.startsWith('contract-'));
      if (drifted.length) return `${path.basename(contract.targetFile)}: ${drifted.map((failure) => `${failure.check} ${failure.detail}`).join('; ').slice(0, 300)}`;
    }
    return null;
  },
  // The port scan on fixed sources: members named on an option object, reached by a hook name or an iterated list, function options called
  // directly, through an alias or checked for a function; data members not called; the recorder's own inputs never ports; a computed name it cannot resolve listed.
  'port-scan': async (module) => {
    const source = [
      'const executor = options.executor;',
      'const store = options.store ?? fallback;',
      'const hooks = options.hooks && typeof options.hooks === \'object\' ? options.hooks : null;',
      'const publish = options.publish ?? (() => undefined);',
      'const admit = typeof options.admit === \'function\' ? options.admit : null;',
      'const now = options.now ?? Date.now;',
      'const limit = options.limit ?? 5;',
      '// executor.inComment()',
      'if (typeof executor.start !== \'function\') throw new TypeError(\'executor.start is required\');',
      'const launch = mode ? executor.resume : executor.start;',
      'const ready = [\'load\', \'save\'].every(name => typeof store[name] === \'function\');',
      'const hook = async (name, input) => { const fn = hooks?.[name]; return fn ? fn(input) : null; };',
      'await hook(\'first\', 1); await hook(\'second\', 2);',
      'const grace = hooks?.graceMs ?? 10;',
      'publish(event); options.onTiming?.(x); now(); limit + 1;',
      'await admit(task);',
    ].join('\n');
    const options = ['admit', 'executor', 'hooks', 'limit', 'now', 'onTiming', 'publish', 'store'];
    const found = module.scanPorts(source, { options, inputs: ['now'] });
    const want = { members: [{ name: 'executor.resume', called: false }, { name: 'executor.start', called: true }, { name: 'hooks.first', called: true }, { name: 'hooks.graceMs', called: false }, { name: 'hooks.second', called: true }, { name: 'store.load', called: true }, { name: 'store.save', called: true }], functions: ['admit', 'onTiming', 'publish'], unresolved: [] };
    if (JSON.stringify(found) !== JSON.stringify(want)) return `the scan of a fixed source: ${JSON.stringify(found)}`;
    const blind = module.scanPorts('const executor = options.executor;\nconst key = pick();\nexecutor[key]();', { options: ['executor'] });
    return blind.unresolved.length === 1 ? null : `a computed member name the scan cannot resolve is not listed: ${JSON.stringify(blind)}`;
  },
  'contract-unknown': async (module) => {
    const corpus = await toyCorpus();
    const contract = { ...toyContract.contract, members: toyContract.contract.members.filter((name) => name !== 'echo'), ports: toyContract.contract.ports.filter((name) => name !== 'publishEvent') };
    const report = toyCensus(module, corpus, { contract, surface: null });
    const unknown = report.failures.filter((failure) => failure.check === 'contract-unknown').map((failure) => failure.name).sort();
    return JSON.stringify(unknown) === JSON.stringify(['member:echo', 'port:publishEvent']) ? null : `unknown ${JSON.stringify(unknown)}`;
  },
  'contract-predicates': async (module) => {
    const corpus = await toyCorpus();
    const named = toyCensus(module, corpus, { contract: { ...toyContract.contract, gaps: ['no-such-gap'] } });
    const whole = toyCensus(module, corpus, { contract: { ...toyContract.contract, partial: false } });
    if (!has(named, 'contract-predicates', 'no-such-gap')) return 'a gap the contract names with no predicate is accepted';
    return has(whole, 'contract-predicates', 'fan-out-8') ? null : 'a scheduler contract that leaves a predicate out is accepted';
  },
  // Every launch situation and gap shows on its own hand-made case, judged, and on no other's; every near miss shows what it says.
  predicates: async (module) => {
    for (const read of handCases()) {
      const name = read.cases[0].name;
      const shown = handItems(module, read);
      if (!shown.includes(name)) return `${name}: its hand-made case shows ${JSON.stringify(shown)}`;
      const others = shown.filter((entry) => entry !== name && !(name === 'launch-after-recovery' && entry === 'restart-recovery'));
      if (others.length) return `${name}: its hand-made case also shows ${others.join(', ')}`;
    }
    for (const near of NEAR) {
      const shown = handItems(module, handCase(near.name, near.build));
      if (JSON.stringify(shown) !== JSON.stringify(near.shows)) return `${near.name} shows ${JSON.stringify(shown)}, not ${JSON.stringify(near.shows)}`;
    }
    return null;
  },
  // S4: the last printed line holds every count and the verdict of the whole command, plants included.
  printed: async (module) => {
    const report = toyCensus(module, await toyCorpus());
    const lines = module.censusLines(report, { waivers: toyWaivers.waivers });
    if (!lines.some((line) => line.startsWith('member (')) || !lines.some((line) => line.startsWith('option-varies: '))) return 'the census lines lack the items or the option-varies count';
    if (!/^scheduler census complete: .* call-only, .* exit 0$/.test(lines.at(-1))) return `the last line: ${lines.at(-1)}`;
    const planted = module.censusLines(report, { waivers: toyWaivers.waivers, plants: { copies: 3, replayer: 2, problems: 1 }, code: EXIT.fail }).at(-1);
    return /^scheduler census FAILED: .*; plants: 3 planted copies, 2 planted replayer bugs, 1 problems; exit 1$/.test(planted) ? null : `the last line with plants: ${planted}`;
  },
};

// ------------------------------------------------------------------ planted censuses

/**
 * Each a copy of a harness file (the census unless `file` names another) with one anchored change, and the named check
 * that must fail on it: the builder's sixteen, the review's thirty-four (its last-index plant split in two, one
 * per index an item keeps; two of them, `judged-without-prefix` and `has-read-counted`, change nothing on the
 * scheduler's corpus, since a closure never calls a case with an empty prefix partial and the scheduler's source
 * never probes an option with `in`: a fixed input and the toy pin them), and fix round 1's thirty-seven.
 */
const PLANTS = [
  // O0e.
  { name: 'member-dropped', check: 'member-count', purpose: 'the first member call of each construction not counted', anchor: "for (const call of view.calls) if (call.event.head.call > 0) note('member',", with: "for (const call of view.calls) if (call.event.head.call > 1) note('member'," },
  { name: 'judged-past-busy', check: 'busy-point', purpose: 'an item counted judged although it shows only after the first busy input', anchor: 'if (judged && at < limit) { item.judged += 1;', with: 'if (judged) { item.judged += 1;' },
  { name: 'launch-at-zero', check: 'busy-point-launch', purpose: 'a launch situation counted where the case begins, not where it is completed', anchor: "if (Number.isFinite(index) && index >= 0) note('launch', name, index); }", with: "if (Number.isFinite(index) && index >= 0) note('launch', name, 0); }" },
  { name: 'stale-waiver-accepted', check: 'waiver-stale', purpose: 'a waiver of a judged item accepted', anchor: "    if (item.judged > 0) { fail('waiver-exercised',", with: "    if (false) { fail('waiver-exercised'," },
  { name: 'unknown-waiver-accepted', check: 'waiver-stale', purpose: 'a waiver of nothing the contract lists accepted', anchor: "    if (!item) { fail('waiver-unknown',", with: "    if (!item) { void ('waiver-unknown'," },
  { name: 'new-waiver-accepted', check: 'waiver-baseline', purpose: 'a waiver outside the baseline accepted (the list could grow)', anchor: '    if (baseline && !baseline.includes(waiver.key)) fail(', with: '    if (false) fail(' },
  { name: 'empty-corpus-passes', check: 'empty-corpus', purpose: 'an empty corpus exits 0', anchor: "  if (recordedCases === 0) inconclusive('empty-corpus',", with: "  if (false) inconclusive('empty-corpus'," },
  { name: 'incomplete-as-whole', check: 'incomplete-corpus', purpose: 'a corpus with a missing file judged as the whole one', anchor: '  const complete = missing.length === 0 && damaged.length === 0 && recordedCases > 0;', with: '  const complete = damaged.length === 0 && recordedCases > 0;' },
  { name: 'option-varies-uncounted', check: 'option-varies', purpose: 'an option-varies case not counted', anchor: '        if (table.varies.size) varies.cases += 1;', with: '' },
  { name: 'unreplayed-passes', check: 'unreplayed', purpose: 'a census with no closure verdicts exits 0', anchor: "  if (!results) inconclusive('unreplayed',", with: "  if (false) inconclusive('unreplayed'," },
  { name: 'different-case-judged', check: 'judged-needs-verdict', purpose: 'a case the closure found different counted as judged', anchor: "const replayed = results ? Boolean(result) && ['reproduced', 'partial'].includes(result.outcome) && result.verdict === 'pass' : true;", with: 'const replayed = true;' },
  { name: 'closure-ignored', check: 'closure-code', purpose: 'a failed closure not failing the census', anchor: "  if (closureCode === EXIT.fail) fail('closure',", with: "  if (false) fail('closure'," },
  { name: 'member-drift-ignored', check: 'contract-drift', purpose: 'a member the scheduler gained not failing the contract', anchor: '  if (!sameSet(contract.members, surface.members)) fail(', with: '  if (false) fail(' },
  { name: 'unknown-ignored', check: 'contract-unknown', purpose: 'a member the recordings call and the contract does not list ignored', anchor: '  for (const [key, count] of unknown) fail(', with: '  for (const [key, count] of []) fail(' },
  { name: 'predicate-list-unchecked', check: 'contract-predicates', purpose: 'a contract that names a gap without a predicate accepted', anchor: "    for (const name of difference(named, coded)) fail('contract-predicates',", with: "    for (const name of []) fail('contract-predicates'," },
  { name: 'never-open', check: 'predicates', purpose: 'a call or port never counted as pending (the launch situations that need one never show)', anchor: 'const openAt = (span, index) => span.start < index && index < span.end;', with: 'const openAt = (span, index) => span.start < index && index < span.start;' },
  // The O0e review's.
  { name: 'limit-all-events', check: 'toy-whole', purpose: 'the compared prefix taken as the whole case', anchor: "const limit = record.outcome === 'recorded' ? casePlacement(record).limit : 0;", with: "const limit = record.outcome === 'recorded' ? casePlacement(record).events : 0;" },
  { name: 'judged-without-prefix', check: 'crossed-not-judged', purpose: 'a case with an empty prefix counted as judged (equivalent on a closure\'s verdicts: a crossed case is never reproduced or partial)', anchor: 'const judged = replayed && limit > 0;', with: 'const judged = replayed;' },
  { name: 'verdict-ignored', check: 'judged-needs-verdict', purpose: 'a reproduced case whose comparer verdict is not pass still judges', anchor: "&& result.verdict === 'pass' : true;", with: ' : true;' },
  { name: 'supplied-option-counted', check: 'option-count', purpose: 'an option the recorder supplied counted as given by the test', anchor: '&& !head.supplied && ', with: '&& ' },
  { name: 'absent-option-counted', check: 'option-count', purpose: 'an option read as undefined or null counted as given', anchor: "&& event.p.value !== undefined && event.p.value !== null) note('option'", with: ") note('option'" },
  { name: 'has-read-counted', check: 'option-count', purpose: 'an `in` probe of an option counted as giving it (the scheduler\'s source has none; the toy\'s has)', anchor: "head.object === 'options' && head.op === undefined &&", with: "head.object === 'options' &&" },
  { name: 'argument-ports-counted', check: 'toy-whole', purpose: 'functions handed in member arguments counted as ports', anchor: "&& !/#\\d+\\./.test(head.name) && !/#\\d+$/.test(head.name)) note('port'", with: ") note('port'" },
  { name: 'last-result', check: 'member-count', purpose: 'a member judged by its last answer in the case, not its first', anchor: '    if (at < entry.at) entry.at = at;', with: '    entry.at = at;' },
  { name: 'last-call', check: 'toy-fingerprint', purpose: 'an item placed at its last event in the case, not its first', anchor: '    if (call < entry.call) entry.call = call;', with: '    entry.call = call;' },
  { name: 'waiver-stale-by-cases', check: 'toy-whole', purpose: 'a waiver failed as stale when the item is only recorded past busy', anchor: "if (item.judged > 0) { fail('waiver-exercised'", with: "if (item.cases > 0) { fail('waiver-exercised'" },
  { name: 'missing-verdict-accepted', check: 'census-results', purpose: 'a recorded case with no closure verdict accepted', anchor: "if (results && !result) fail('census-results'", with: "if (false) fail('census-results'" },
  { name: 'extra-verdict-accepted', check: 'census-results', purpose: 'a verdict for a case no container holds accepted', anchor: 'if (results) for (const id of results.keys()) if (!seenIds.has(id)) fail(', with: 'if (false) for (const id of results.keys()) if (!seenIds.has(id)) fail(' },
  { name: 'duplicate-case-accepted', check: 'census-results', purpose: 'a case id twice in the corpus accepted', anchor: "if (seenIds.has(record.id)) fail('census-results'", with: "if (false) fail('census-results'" },
  { name: 'reproduced-with-busy-accepted', check: 'census-results', purpose: 'a verdict of reproduced for a case with a busy input accepted', anchor: "if (result && result.outcome === 'reproduced' && limit < view.events.length) fail(", with: 'if (false) fail(' },
  { name: 'scenario-names-unchecked', check: 'incomplete-corpus', purpose: 'a scenario case missing from the corpus not noticed', anchor: 'for (const name of entry.cases ?? []) if (!names.has(name))', with: 'for (const name of []) if (!names.has(name))' },
  { name: 'waiver-problems-ignored', check: 'waiver-file', purpose: 'a malformed waiver file not failing the census', anchor: "for (const problem of waiverProblems) fail('waiver-invalid'", with: "for (const problem of []) fail('waiver-invalid'" },
  { name: 'reason-optional', check: 'waiver-file', purpose: 'a waiver without a reason accepted', anchor: "if (typeof waiver.reason !== 'string' || !waiver.reason.trim()) {", with: 'if (false) {' },
  { name: 'duplicate-waiver-accepted', check: 'waiver-file', purpose: 'a waiver given twice accepted', anchor: 'if (seen.has(key)) { problems.push(', with: 'if (false) { problems.push(' },
  { name: 'contract-duplicates-accepted', check: 'contract-file', purpose: 'a contract list naming an item twice accepted', anchor: 'if (new Set(names).size !== names.length) problems.push(', with: 'if (false) problems.push(' },
  { name: 'options-drift-ignored', check: 'contract-drift', purpose: 'the contract\'s options not checked against the source', anchor: '  if (!sameSet(contract.options, surface.options)) fail(', with: '  if (false) fail(' },
  { name: 'closure-inconclusive-ignored', check: 'closure-code', purpose: 'an inconclusive closure not making the census inconclusive', anchor: "else if (closureCode !== EXIT.pass) inconclusive('closure-inconclusive'", with: "else if (false) inconclusive('closure-inconclusive'" },
  { name: 'fan-out-7', check: 'predicates', purpose: 'seven launches in a group counted as the eight-launch fan-out', anchor: 'if (count >= 8) return event.index;', with: 'if (count >= 7) return event.index;' },
  { name: 'handoff-any-refusal', check: 'predicates', purpose: 'any refused submit counted as a handoff refusal', anchor: "errorCode(call.value) === 'handoff_in_progress' && ", with: '' },
  { name: 'recovery-any-status', check: 'predicates', purpose: 'a restart with only queued or terminal tasks counted as recovery', anchor: "task.status === 'starting' || task.status === 'running'", with: 'true' },
  { name: 'publication-one-direction', check: 'predicates', purpose: 'a publication before a launch no longer counted', anchor: "|| (a.kind === 'port' && a.head.name === 'publishEvent' && isLaunch(b))", with: '' },
  { name: 'reconcile-retry-after-fire', check: 'predicates', purpose: 'a second transient after the retry fired counted as the retry-pending gap', anchor: "if (event.kind === 'fire') pending.clear();", with: '' },
  { name: 'varies-whole-case', check: 'option-varies', purpose: 'option-varies counted over the whole case, past the busy input', anchor: 'const table = readTable(view.events.slice(0, limit));', with: 'const table = readTable(view.events);' },
  { name: 'empty-by-ids', check: 'empty-corpus', purpose: 'a corpus with cases but none recorded not empty', anchor: "if (recordedCases === 0) inconclusive('empty-corpus'", with: "if (seenIds.size === 0) inconclusive('empty-corpus'" },
  { name: 'no-expected-complete', check: 'incomplete-corpus', purpose: 'a census with no whole corpus named judged complete', anchor: "if (!expected) missing.push('no whole corpus was named');", with: 'if (!expected) void 0;' },
  { name: 'no-surface-ok', check: 'contract-drift', purpose: 'a census given no product surface not inconclusive', anchor: "else inconclusive('no-surface',", with: "else void ('no-surface'," },
  { name: 'restart-rr-same-construction', check: 'predicates', purpose: 'the restart-during-runtime-restart gap counted without a later construction', anchor: "event.c > call.event.c && event.kind === 'call' && event.head.call === 0", with: "event.c >= call.event.c && event.kind === 'call' && event.head.call === 0" },
  { name: 'first-construction-only', check: 'later-construction', purpose: 'members called by a second construction (after a restart) not counted', anchor: "for (const call of view.calls) if (call.event.head.call > 0) note('member',", with: "for (const call of view.calls) if (call.event.head.call > 0 && call.event.c === 1) note('member'," },
  { name: 'launch-after-recovery-any-construction', check: 'predicates', purpose: 'a launch of another construction counted after recovery', anchor: 'const launch = view.events.find((event) => event.index > recovered && event.c === c && isLaunch(event));', with: 'const launch = view.events.find((event) => event.index > recovered && isLaunch(event));' },
  { name: 'failed-timing-any', check: 'predicates', purpose: 'onMutationTiming for any mutation counted as the failed-mutation gap', anchor: '?.failed === true', with: '?.failed !== undefined' },
  { name: 'ports-skip-sync-answer', check: 'predicates', purpose: 'a port counted only when it was answered with a promise', anchor: "else if (event.kind === 'port') ports.set(", with: "else if (event.kind === 'port' && events[index + 1]?.head?.outcome === 'promise') ports.set(" },
  // Fix round 1: B1, the contract against the product.
  { name: 'control-drift-ignored', check: 'contract-drop', purpose: 'a control method dropped from the contract not failing', anchor: '  else if (!sameSet(contract.control, surface.control)) fail(', with: '  else if (false) fail(' },
  { name: 'control-unprobed-ok', check: 'contract-drift', purpose: 'a probe that found no control object not failing', anchor: "  if (!surface.control) fail('contract-control',", with: "  if (!surface.control) void ('contract-control'," },
  { name: 'ports-drift-ignored', check: 'contract-drop', purpose: 'a port dropped from the contract not failing', anchor: "  if (!sameSet(listed, scanned)) fail('contract-ports',", with: "  if (false) fail('contract-ports'," },
  { name: 'called-data-accepted', check: 'contract-drop', purpose: 'a called port listed as data accepted', anchor: '  for (const member of surface.ports.members) if (member.called && contract.data.includes(member.name)) fail(', with: '  for (const member of []) if (member.called && contract.data.includes(member.name)) fail(' },
  { name: 'unresolved-accepted', check: 'contract-drift', purpose: 'a computed member name the scan cannot resolve accepted', anchor: '  for (const site of surface.ports.unresolved) fail(', with: '  for (const site of []) fail(' },
  { name: 'inputs-drift-ignored', check: 'contract-drop', purpose: 'an event kind dropped from the contract not failing', anchor: "  if (!sameSet(contract.inputs, surface.inputs)) fail('contract-inputs',", with: "  if (false) fail('contract-inputs'," },
  { name: 'places-drift-ignored', check: 'contract-drop', purpose: 'a placement mark dropped from the contract not failing', anchor: "  if (!sameSet(contract.places, surface.places)) fail('contract-places',", with: "  if (false) fail('contract-places'," },
  { name: 'hooks-unscanned', check: 'port-scan', purpose: 'members reached through a hook function\'s name not scanned', anchor: 'let keys = hook ? [...code.matchAll(', with: 'let keys = false ? [...code.matchAll(' },
  { name: 'iterated-unscanned', check: 'port-scan', purpose: 'members reached through an iterated list of names not scanned', anchor: 'keys = list ? [...list[1].matchAll(', with: 'keys = false ? [...list[1].matchAll(' },
  { name: 'alias-calls-unseen', check: 'port-scan', purpose: 'a function option called through its alias not a port', anchor: 'return [...aliases].some(([alias, of]) => of === option', with: 'return [].some(([alias, of]) => of === option' },
  { name: 'typeof-check-not-a-call', check: 'port-scan', purpose: 'a member checked to be a function not counted as called (a called port could pass as data)', anchor: "(/typeof\\s$/.test(before) && /^\\s*[!=]==?\\s*'function'/.test(after))", with: 'false' },
  { name: 'recorder-inputs-as-ports', check: 'port-scan', purpose: 'the recorder\'s own inputs (the clock) counted as function options', anchor: '    if (inputs.includes(option) || objects.has(option)) return false;', with: '    if (objects.has(option)) return false;' },
  { name: 'comments-scanned', check: 'port-scan', purpose: 'a member named only in a comment counted as a port', anchor: "export const stripComments = (source) => source.replace(/\\/\\*[\\s\\S]*?\\*\\//g, ' ').split('\\n').map((line) => line.replace(/(^|[^:\\\\'\"`])\\/\\/.*$/, '$1')).join('\\n');", with: 'export const stripComments = (source) => source;' },
  { name: 'kinds-one-direction', check: 'surface', purpose: 'the recorder\'s output kinds read as inputs', anchor: "`${match[1] === 'input' ? 'in' : 'out'} ${match[2]}`", with: '`in ${match[2]}`' },
  { name: 'places-with-busy', check: 'surface', purpose: 'the busy mark counted as a place a prefix can hold', anchor: "places: PLACES.filter((place) => place !== 'busy')", with: 'places: PLACES' },
  { name: 'served-defaults-as-ports', check: 'surface', purpose: 'the target\'s served identifier factories not among the recorder\'s inputs', anchor: ", ...Object.keys(target.defaults ?? {})])].sort();", with: '])].sort();' },
  { name: 'control-probe-blind', check: 'surface', purpose: 'the control probe reads the task, not the control object', anchor: 'start(task, handed) { control ??= handed;', with: 'start(task, handed) { control ??= task;' },
  // Fix round 1: B2, the manifest.
  { name: 'manifest-unchecked', check: 'manifest', purpose: 'the containers never checked against their recording\'s manifest', anchor: 'if (bySource.has(source) || manifests.has(source)) damaged.push(', with: 'if (false) damaged.push(' },
  { name: 'manifest-damage-incomplete-only', check: 'manifest', purpose: 'a damaged source counted as complete', anchor: '  const complete = missing.length === 0 && damaged.length === 0 && recordedCases > 0;', with: '  const complete = missing.length === 0 && recordedCases > 0;' },
  { name: 'digest-unchecked', check: 'manifest', file: 'recording-manifest.mjs', purpose: 'a container whose bytes changed accepted', anchor: '    if (digestOf(held) !== entry.digest) {', with: '    if (false) {' },
  { name: 'missing-container-accepted', check: 'manifest', file: 'recording-manifest.mjs', purpose: 'a container the manifest lists and the directory lacks accepted', anchor: '    if (held === undefined) { problems.push(', with: '    if (held === undefined) { continue; problems.push(' },
  { name: 'unlisted-container-accepted', check: 'manifest', file: 'recording-manifest.mjs', purpose: 'a container the manifest does not list accepted', anchor: '  for (const name of present.keys()) if (!Object.hasOwn(manifest.containers, name))', with: '  for (const name of []) if (!Object.hasOwn(manifest.containers, name))' },
  { name: 'no-manifest-ok', check: 'manifest', file: 'recording-manifest.mjs', purpose: 'a source with no manifest accepted', anchor: '  if (text === null || text === undefined) return [', with: '  if (text === null || text === undefined) return []; if (false) return [' },
  { name: 'any-source-manifest', check: 'manifest', file: 'recording-manifest.mjs', purpose: 'the manifest of another source accepted', anchor: ' || manifest.source !== source ||', with: ' ||' },
  // Fix round 1: S1, judged by the result.
  { name: 'judged-by-call', check: 'judged-by-result', purpose: 'a member judged by its call inside the prefix, its result past it', anchor: 'if (judged && at < limit) { item.judged += 1;', with: 'if (judged && call < limit) { item.judged += 1;' },
  { name: 'control-by-call', check: 'judged-by-result', purpose: 'a control method judged by its call', anchor: "for (const call of view.controls) note('control', call.method, call.end, call.start);", with: "for (const call of view.controls) note('control', call.method, call.start, call.start);" },
  { name: 'controls-unanswered', check: 'member-count', purpose: 'the answer to a control call never matched to it', anchor: "    else if (event.kind === 'control') calls.set(", with: '    else if (false) calls.set(' },
  { name: 'call-only-as-past-busy', check: 'judged-by-result', purpose: 'a call-only case counted as past busy', anchor: '} else if (judged && call < limit) item.callOnly += 1;', with: '} else if (false) item.callOnly += 1;' },
  // Fix round 1: S3, the waiver's class.
  { name: 'class-unchecked', check: 'waiver-class', purpose: 'a waiver\'s class never checked against the corpus', anchor: "if (complete ? classOf(item) !== waiver.class : refutes(waiver.class, item)) fail('waiver-class',", with: "if (false) fail('waiver-class'," },
  { name: 'class-whole-only', check: 'waiver-class', purpose: 'a class refuted by a part of the corpus accepted there', anchor: "const refutes = (stated, item) => (stated === 'unreached' ? item.cases > 0 :", with: "const refutes = (stated, item) => (stated === 'unreached' ? false :" },
  { name: 'call-only-not-a-class', check: 'waiver-class', purpose: 'call-only items classed as past busy', anchor: "item.callOnly > 0 ? 'call-only' : ", with: '' },
  { name: 'class-optional', check: 'waiver-file', purpose: 'a waiver without a class accepted', anchor: '    if (!Object.hasOwn(WAIVER_CLASSES, waiver.class)) {', with: '    if (!kind) { waivers.push({ ...waiver, key }); continue; } if (false) {' },
  { name: 'needs-unchecked', check: 'waiver-file', purpose: 'a need its class does not allow accepted', anchor: '    if (!kind.needs.includes(waiver.needs)) {', with: '    if (false) {' },
  { name: 'call-only-any-kind', check: 'waiver-file', purpose: 'a port waived as call-only accepted', anchor: "    if (waiver.class === 'call-only' && !ANSWERED.has(waiver.kind)) {", with: '    if (false) {' },
  { name: 'data-list-optional', check: 'contract-file', purpose: 'a contract without its data list accepted', anchor: "  for (const list of [...Object.values(LISTS), 'data']) {", with: '  for (const list of Object.values(LISTS)) {' },
  // Fix round 1: S4, the last line.
  { name: 'plants-left-out', check: 'printed', purpose: 'the last line without the plants\' counts', anchor: "  const planted = !plants ? '' :", with: "  const planted = true ? '' :" },
  { name: 'census-verdict-only', check: 'printed', purpose: 'the last line\'s verdict the census\'s alone, the plants\' failure left out', anchor: '  const verdict = code === EXIT.pass ?', with: '  const verdict = report.code === EXIT.pass ?' },
];

/** The harness files a planted census imports or reads, copied beside it; the packages and the shared codec through links. */
const MIRRORED = ['census.mjs', 'compare.mjs', 'recorder.mjs', 'recording-manifest.mjs', 'replay-values.mjs', 'trace.mjs'];
function plantedCensus(plant) {
  const root = mkdtempSync(path.join(scratch.dir, 'census-plant-'));
  const harness = path.join(root, 'scripts/scheduler-conformance');
  mkdirSync(harness, { recursive: true });
  for (const file of MIRRORED) cpSync(path.join(HARNESS_DIR, file), path.join(harness, file));
  symlinkSync(path.join(REPOSITORY_ROOT, 'scripts/client-conformance'), path.join(root, 'scripts/client-conformance'));
  symlinkSync(path.join(REPOSITORY_ROOT, 'packages'), path.join(root, 'packages'));
  const file = path.join(harness, plant.file ?? 'census.mjs');
  const text = readFileSync(file, 'utf8');
  assert.equal(text.split(plant.anchor).length - 1, 1, `${plant.name}: its anchor occurs once in ${plant.file ?? 'census.mjs'}`);
  writeFileSync(file, text.replace(plant.anchor, () => plant.with));
  return pathToFileURL(path.join(harness, 'census.mjs')).href;
}

// ------------------------------------------------------------------ tests

guarded('the scheduler\'s contract and waivers: the contract is the scheduler\'s, every waiver well formed, in the baseline, of a listed item and of a class the census can check', async () => {
  assert.deepEqual(realContract.problems, []);
  assert.deepEqual(realWaivers.problems, []);
  const surface = await realSurface();
  assert.equal(surface.members.length, 53, 'the scheduler returns 53 members');
  assert.equal(surface.control.length, 9, 'its control object has 9 methods');
  assert.equal(surface.ports.members.length + surface.ports.functions.length, 35, 'its source uses 32 ports and 3 data members of option objects');
  assert.deepEqual(surface.ports.unresolved, []);
  const report = census.runCensus({ contract: realContract.contract, waivers: realWaivers.waivers, containers: [], results: new Map(), expected: [], surface });
  assert.deepEqual(report.failures, [], 'the contract matches the scheduler, every waiver names a listed item and is in the baseline');
  assert.equal(report.code, EXIT.inconclusive, 'an empty corpus is never a pass');
  // The waiver list only shrinks: the file holds no more than the baseline, and every launch situation and gap is in the contract.
  assert.ok(realWaivers.waivers.length <= census.WAIVER_BASELINE.length);
  assert.deepEqual([...realContract.contract.launch].sort(), Object.keys(census.LAUNCH_SITUATIONS).sort());
  assert.deepEqual([...realContract.contract.gaps].sort(), Object.keys(census.GAPS).sort());
  for (const name of Object.keys(census.CENSUS_CHECKS)) assert.ok(typeof census.CENSUS_CHECKS[name] === 'string' && census.CENSUS_CHECKS[name].length > 10, name);
});

guarded('every named check holds for the unchanged census', async () => {
  for (const [name, check] of Object.entries(CHECKS)) assert.equal(await check(census), null, name);
});

guarded('every planted census fails its own named check', async () => {
  assert.ok(PLANTS.every((plant) => Object.hasOwn(CHECKS, plant.check)), 'every plant names a check');
  assert.equal(new Set(PLANTS.map((plant) => plant.name)).size, PLANTS.length, 'every plant has its own name');
  const missed = [];
  for (const plant of PLANTS) {
    const module = await import(plantedCensus(plant));
    let found;
    try { found = await CHECKS[plant.check](module); } catch (thrown) { found = `threw ${thrown.message}`; missed.push(`${plant.name} makes ${plant.check} throw instead of fail: ${thrown.message}`); }
    if (found === null) missed.push(`${plant.name} (${plant.purpose}) passes ${plant.check}`);
    else console.log(`planted ${plant.name}: ${plant.check}: ${String(found).slice(0, 200)}`);
  }
  assert.deepEqual(missed, []);
});
