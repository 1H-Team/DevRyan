// Named checks of the toy recordings (toy/). The self-test knows the toy, so
// it knows every event the recorder must write; each check reads one
// property of a recording, and each planted recorder bug (mutants.mjs) must
// be reported by its own check. A check returns null when it holds, or what
// it found instead. TOY_CHECKS read the corpus recording
// (toy-scheduler.toy.mjs, every case recorded), golden.json pins its whole
// event sequence, and CORPUS_CHECKS read the fixture recordings, which the
// recorder must refuse in named ways.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allCases, EPOCH, servedUuid, sha256 } from './trace.mjs';

export const GOLDEN_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'toy', 'golden.json');
/** One event as the golden list pins it: direction, kind, what it names, its numbers, and its marks (no values). */
export function eventTuple(event) {
  const label = event.name ?? event.member ?? event.method ?? event.path ?? (event.kind === 'read' ? `${event.object}.${typeof event.key === 'string' ? event.key : '<symbol>'}${event.op ? `:${event.op}` : ''}` : event.site ?? event.source ?? '');
  const ids = ['call', 'port', 'of', 'timer', 'signal'].filter((key) => event[key] !== undefined).map((key) => `${key}=${event[key]}`);
  if (event.outcome) ids.push(event.outcome);
  if (event.source && event.kind !== 'read' && event.source !== label) ids.push(`source=${event.source}`);
  if (event.during !== undefined) ids.push(`during=${event.during}`);
  if (event.signals) ids.push(`signals=${event.signals.map((entry) => `${entry.signal}@${entry.in}.${(entry.at ?? ['?']).join('.')}`).join(',')}`);
  if (event.ambiguous) ids.push(`ambiguous=${event.ambiguous.join(',')}`);
  if (event.supplied) ids.push('supplied');
  if (event.late) ids.push('late');
  return [event.dir, event.kind, label, ...ids].filter(Boolean).join(' ');
}
/** The golden form of a toy recording: per case name, per construction, its event tuples. */
export const goldenOf = (cases) => Object.fromEntries(cases.map((record) => [record.name, record.constructions.map((construction) => construction.events.map(eventTuple))]));
const readGolden = () => JSON.parse(readFileSync(GOLDEN_FILE, 'utf8'));

const byName = (cases, name) => {
  const found = cases.filter((record) => record.name === name);
  if (found.length !== 1) throw new Error(`the toy recording has ${found.length} cases named ${name}`);
  return found[0];
};
const events = (record, n = 1) => record.constructions.find((construction) => construction.n === n)?.events ?? [];
const value = (record, slot) => record.resolve(slot);
/** A value tree without its identity wrapper (an object seen twice in the case is written as {"$dr":"id",...}). */
const plain = (tree) => (tree && tree.$dr === 'id' ? tree.value : tree);
const count = (list, predicate) => list.filter(predicate).length;

const NAMES = Object.freeze({
  submit: 'submits two tasks with the nominal clock and served identifiers',
  injected: 'an injected clock and injected identifiers are the test\'s',
  settle: 'settlements stay with their calls',
  identity: 'errors and identity',
  stop: 'a stop draws its request id at a named site',
  timing: 'mutation timing reads performance at named sites',
  abort: 'an abort reaches the scheduler as an input',
  callback: 'a callback the test passes is a port',
  leaves: 'leaves a timer for the next test',
  fires: 'fires the timer the previous test left',
  schedulerAbort: 'a signal the scheduler hands a port and aborts is an output',
  lazy: 'a later change to the options is what the scheduler reads',
  persistence: 'without a persistence the scheduler saves through the recorded default',
  timers: 'the nominal clock moves with the recorder\'s timers, and new Date() agrees with Date.now()',
  carries: 'leaves a recorder timer for the next test',
  carried: 'reads the clock after the previous test\'s timer fired',
  signals: 'signals are numbered in order of first sight, at any depth',
  nulls: 'options set to null are left out, as the scheduler\'s ?? treats them',
  receiver: 'a value the scheduler hands out and the test changes later keeps its case',
  ambiguous: 'a clear through a handle two live timers share is ambiguous',
});

export const TOY_CHECKS = Object.freeze({
  /** Every call the toy makes across its options is in the trace, once. */
  'option-calls': (cases) => {
    const list = events(byName(cases, NAMES.submit));
    const ports = (name) => count(list, (event) => event.kind === 'port' && event.name === name);
    const seen = { 'persistence.save': ports('persistence.save'), publishEvent: ports('publishEvent'), 'executor.start': ports('executor.start'), markAccepted: count(list, (event) => event.kind === 'control' && event.method === 'markAccepted'), onProgress: count(list, (event) => event.kind === 'callback' && event.path === '1.onProgress') };
    const want = { 'persistence.save': 4, publishEvent: 4, 'executor.start': 2, markAccepted: 2, onProgress: 4 };
    return JSON.stringify(seen) === JSON.stringify(want) ? null : `saw ${JSON.stringify(seen)}, want ${JSON.stringify(want)}`;
  },
  /** Every answer belongs to a port call before it, and a promise answer settles once. */
  'answers': (cases) => {
    for (const record of cases) for (const construction of record.constructions) {
      const ports = new Set();
      const settled = new Map();
      for (const event of construction.events) {
        if (event.kind === 'port') ports.add(event.port);
        if (event.kind !== 'answer') continue;
        if (!ports.has(event.port)) return `${record.name}: an answer to port ${event.port}, which was never called`;
        if (event.outcome === 'resolve' || event.outcome === 'reject') settled.set(event.port, (settled.get(event.port) ?? 0) + 1);
      }
      for (const [port, times] of settled) if (times !== 1) return `${record.name}: port ${port} settled ${times} times`;
    }
    return null;
  },
  /** A promise a member returned settles under its own call: `later('slow', 30)` with 'slow', after 'fast'. */
  'settlement-call': (cases) => {
    const record = byName(cases, NAMES.settle);
    const list = events(record);
    const calls = new Map(list.filter((event) => event.kind === 'call' && event.member === 'later').map((event) => [event.call, value(record, event.args)[0]]));
    const settles = list.filter((event) => event.kind === 'settle' && calls.has(event.call));
    if (settles.length !== 2) return `${settles.length} settlements of later, want 2`;
    for (const event of settles) if (value(record, event.value) !== calls.get(event.call)) return `call ${event.call} (later ${JSON.stringify(calls.get(event.call))}) settled with ${JSON.stringify(value(record, event.value))}`;
    const order = settles.map((event) => calls.get(event.call)).join(',');
    return order === 'fast,slow' ? null : `settled in the order ${order}`;
  },
  /** Hidden identifiers are drawn at named sites, served from servedUuid, and are the values the scheduler used. */
  'hidden-draws': (cases) => {
    const stop = byName(cases, NAMES.stop);
    const draws = events(stop).filter((event) => event.kind === 'draw' && event.source === 'hidden' && event.site === 'stop');
    if (draws.length !== 1) return `${draws.length} hidden draws at site stop, want 1`;
    const drawn = value(stop, draws[0].value);
    const settle = events(stop).find((event) => event.kind === 'settle');
    const requestId = settle && plain(value(stop, settle.value))?.requestId;
    if (requestId !== `toy_stop_${drawn.replaceAll('-', '')}`) return `the stop's requestId ${requestId} is not the drawn ${drawn}`;
    const submit = byName(cases, NAMES.submit);
    const saves = events(submit).filter((event) => event.kind === 'port' && event.name === 'persistence.save').map((event) => value(submit, event.args)[0].owner);
    const owners = events(submit).filter((event) => event.kind === 'draw' && event.source === 'hidden' && event.site === 'persistLocked').map((event) => `toy_save_${value(submit, event.value).replaceAll('-', '')}`);
    if (JSON.stringify(saves) !== JSON.stringify(owners)) return `save owners ${JSON.stringify(saves)} are not the drawn ${JSON.stringify(owners)}`;
    return null;
  },
  /** Served values are recomputable: the case, the construction, the site and the draw's number. */
  'served-values': (cases) => {
    const submit = byName(cases, NAMES.submit);
    const ordinal = cases.filter((record) => record.kind === 'test').indexOf(submit) + 1;
    const counts = new Map();
    for (const event of events(submit)) {
      if (event.kind !== 'draw' || event.source === 'option') continue;
      const n = (counts.get(event.site) ?? 0) + 1;
      counts.set(event.site, n);
      const uuid = servedUuid(`test:${ordinal}:1:${event.site}:${n}`);
      const want = event.source === 'hidden' ? uuid : `${event.site === 'createTaskId' ? 'toy_task_' : 'toy_lease_'}${uuid.replaceAll('-', '')}`;
      if (value(submit, event.value) !== want) return `${event.site} draw ${n} is ${value(submit, event.value)}, want ${want}`;
    }
    return counts.size === 3 ? null : `draws at ${[...counts.keys()].join(', ')}`;
  },
  /** Every save names the digest of its state's reference bytes (toy-ledger.mjs: the state's JSON and a newline). */
  'ledger-digest': (cases) => {
    const record = byName(cases, NAMES.submit);
    const saves = events(record).filter((event) => event.kind === 'port' && event.name === 'persistence.save');
    if (saves.length !== 4) return `${saves.length} saves, want 4`;
    for (const event of saves) {
      const want = sha256(`${JSON.stringify(value(record, event.args)[0])}\n`);
      if (event.ledger !== want) return `save ${event.port} names ledger ${JSON.stringify(event.ledger)}, want ${want}`;
    }
    return null;
  },
  /** The environment is read at its site once per save. */
  'env-reads': (cases) => {
    const list = events(byName(cases, NAMES.submit));
    const reads = count(list, (event) => event.kind === 'env' && event.site === 'persistLocked' && event.name === 'DEVRYAN_ORCHESTRATION_UNACKNOWLEDGED_EXPIRY');
    return reads === 4 ? null : `${reads} environment reads, want 4`;
  },
  /** Without `now` the scheduler reads the case's nominal time; with it, the test's. */
  'clock': (cases) => {
    const nominal = byName(cases, NAMES.submit);
    const values = events(nominal).filter((event) => event.kind === 'clock').map((event) => `${event.source}:${value(nominal, event.value)}`);
    if (values.length !== 4 || values.some((entry) => entry !== 'nominal:1700000000000')) return `nominal case read ${values.join(', ')}`;
    const injected = byName(cases, NAMES.injected);
    const option = events(injected).filter((event) => event.kind === 'clock').map((event) => `${event.source}:${value(injected, event.value)}`);
    return option.length === 2 && option.every((entry) => entry === 'option:5000') ? null : `injected case read ${option.join(', ')}`;
  },
  /** performance.now() is a hidden clock read at named sites, served from the nominal clock. */
  'performance': (cases) => {
    const record = byName(cases, NAMES.timing);
    const reads = events(record).filter((event) => event.kind === 'clock' && event.source === 'performance').map((event) => `${event.site}=${value(record, event.value)}`);
    const want = ['runExclusive.queued=1000', 'runExclusive.started=1000', 'runExclusive.held=1000', 'runExclusive.queued=1000', 'runExclusive.started=1000', 'runExclusive.held=1000'];
    return JSON.stringify(reads) === JSON.stringify(want) ? null : `read ${reads.join(', ')}`;
  },
  /** An object returned as its argument is the same object (identity across slots); a copy is not. */
  'identity': (cases) => {
    const record = byName(cases, NAMES.identity);
    const list = events(record);
    const call = (member) => list.find((event) => event.kind === 'call' && event.member === member);
    const returned = (member) => list.find((event) => event.kind === 'return' && event.call === call(member)?.call);
    const echoArg = value(record, call('echo').args)[0];
    const echoed = value(record, returned('echo').value);
    const copied = value(record, returned('copy').value);
    if (echoArg?.$dr !== 'id' || echoed?.$dr !== 'id' || echoed.n !== echoArg.n) return `echo recorded ${JSON.stringify(echoArg)} -> ${JSON.stringify(echoed)}`;
    if (copied?.$dr === 'id') return `copy recorded as the same object: ${JSON.stringify(copied)}`;
    const thrown = list.find((event) => event.kind === 'throw' && event.call === call('fail').call);
    const error = thrown && value(record, thrown.error);
    return error?.name === 'ToyError' && error.value?.code === 'toy_code' && error.error?.message === 'toy failure toy_code' ? null : `fail threw ${JSON.stringify(error)}`;
  },
  /** An AbortSignal the scheduler got aborts as an input, before the settlement it causes; the call that carried it names its number and path. */
  'abort': (cases) => {
    const record = byName(cases, NAMES.abort);
    const list = events(record);
    const at = list.findIndex((event) => event.kind === 'abort');
    const settled = list.findIndex((event) => event.kind === 'settle');
    if (at < 0) return 'no abort recorded';
    if (list[at].dir !== 'in') return `the test's abort is recorded as ${list[at].dir}`;
    if (value(record, list[at].reason) !== 'stopped') return `abort reason ${JSON.stringify(value(record, list[at].reason))}`;
    const carried = list.find((event) => event.kind === 'call' && event.member === 'waitForAbort');
    if (JSON.stringify(carried?.signals) !== JSON.stringify([{ signal: list[at].signal, at: [0, 'signal'], in: 'args' }])) return `the call carries signals ${JSON.stringify(carried?.signals)}`;
    return settled > at ? null : 'the settlement came before the abort';
  },
  /** A signal the scheduler made and handed a port aborts as an output, with its reason, tied to the port's argument by number. */
  'scheduler-abort': (cases) => {
    const record = byName(cases, NAMES.schedulerAbort);
    const list = events(record);
    const port = list.find((event) => event.kind === 'port' && event.name === 'executor.watch');
    const abort = list.find((event) => event.kind === 'abort');
    if (!port || !abort) return `port ${Boolean(port)}, abort ${Boolean(abort)}`;
    if (abort.dir !== 'out') return `the scheduler's abort is recorded as ${abort.dir}`;
    // The scheduler's own listener (put on before the signal was handed out) publishes: after the abort that caused it.
    const published = list.findIndex((event) => event.kind === 'port' && event.name === 'publishEvent');
    if (published < 0 || published < list.indexOf(abort)) return `the listener's publishEvent is event ${published + 1}, the abort ${list.indexOf(abort) + 1}`;
    if (JSON.stringify(port.signals) !== JSON.stringify([{ signal: abort.signal, at: [0, 'signal'], in: 'args' }])) return `the port carries signals ${JSON.stringify(port.signals)}, the abort is of ${abort.signal}`;
    const reason = value(record, abort.reason);
    return reason?.name === 'ToyError' && reason.value?.code === 'toy_abort' ? null : `abort reason ${JSON.stringify(reason)}`;
  },
  /** The scheduler reads the test's own options object: a member the test sets later is read then, and the read is an input. */
  'lazy-options': (cases) => {
    const record = byName(cases, NAMES.lazy);
    const reads = events(record).filter((event) => event.kind === 'read' && event.object === 'options' && ['expireUnacknowledged', 'onMutationTiming'].includes(event.key)).map((event) => `${event.key}=${JSON.stringify(value(record, event.value))}`);
    const want = ['expireUnacknowledged={"$dr":"undefined"}', 'onMutationTiming={"$dr":"undefined"}', 'expireUnacknowledged=false', 'onMutationTiming={"$dr":"function","name":""}'];
    if (JSON.stringify(reads) !== JSON.stringify(want)) return `reads ${reads.join(', ')}`;
    // `in` on the options answers as the test's own object does: false for a member the recorder would supply.
    const has = events(record).filter((event) => event.kind === 'read' && event.object === 'options' && event.op === 'has' && event.key === 'now').map((event) => value(record, event.value));
    if (JSON.stringify(has) !== '[false,false]') return `'now' in options answered ${JSON.stringify(has)}`;
    const own = events(record).filter((event) => event.kind === 'read' && event.object === 'persistence' && event.op === 'own' && event.key === 'load').map((event) => event.found);
    return JSON.stringify(own) === '[true,true]' ? null : `the own-member checks of persistence.load found ${JSON.stringify(own)}`;
  },
  /** A scheduler built without a persistence gets the recorded default: its saves cross, and so does the probe of an absent member. */
  'default-persistence': (cases) => {
    const record = byName(cases, NAMES.persistence);
    const construction = record.constructions[0];
    if (!construction?.defaulted.includes('persistence')) return `defaulted ${JSON.stringify(construction?.defaulted)}`;
    const list = events(record);
    // The supplied load answers what the scheduler's own does: a promise of null.
    const load = list.find((event) => event.kind === 'port' && event.name === 'persistence.load');
    const answers = list.filter((event) => event.kind === 'answer' && event.port === load?.port).map((event) => `${event.outcome}${event.value === undefined ? '' : `=${JSON.stringify(value(record, event.value))}`}`);
    if (JSON.stringify(answers) !== '["promise","resolve=null"]') return `the supplied load answered ${JSON.stringify(answers)}`;
    const saves = count(list, (event) => event.kind === 'port' && event.name === 'persistence.save');
    const probe = count(list, (event) => event.kind === 'read' && event.object === 'persistence' && event.key === 'putShard');
    return saves === 2 && probe === 1 ? null : `${saves} saves and ${probe} probes, want 2 and 1`;
  },
  /** The nominal clock: a recorder timer moves its case's time to its due time, Date.now() and new Date() agree, and a timer that fires in the next test moves only its own case. */
  'recorder-clock': (cases) => {
    const timers = byName(cases, NAMES.timers);
    const echo = events(timers).find((event) => event.kind === 'call' && event.member === 'echo');
    const seen = plain(value(timers, echo?.args)?.[0]);
    // Date() is the nominal time as a string, to the second: EPOCH + 20 ms reads back as EPOCH.
    const want = [EPOCH, EPOCH, EPOCH + 20, EPOCH + 20, EPOCH, 5, true];
    if (JSON.stringify(seen) !== JSON.stringify(want)) return `the clock read ${JSON.stringify(seen)}, want ${JSON.stringify(want)}`;
    const owner = byName(cases, NAMES.carries);
    const late = events(owner).filter((event) => event.late && event.kind === 'clock').map((event) => value(owner, event.value));
    if (JSON.stringify(late) !== JSON.stringify([EPOCH + 30])) return `the owner's late clock reads ${JSON.stringify(late)}, want ${EPOCH + 30}`;
    const next = byName(cases, NAMES.carried);
    const echoed = plain(value(next, events(next).find((event) => event.kind === 'call' && event.member === 'echo')?.args)?.[0]);
    return JSON.stringify(echoed) === JSON.stringify([EPOCH + 30, EPOCH]) ? null : `the next test read ${JSON.stringify(echoed)}, want [${EPOCH + 30},${EPOCH}]`;
  },
  /** Signals are numbered in order of first sight, each with its path at any depth; aborts name their own signal, in the order they came. */
  'signal-numbers': (cases) => {
    const record = byName(cases, NAMES.signals);
    const list = events(record);
    const call = list.find((event) => event.kind === 'call' && event.member === 'waitForSignals');
    const want = [{ signal: 1, at: [0, 'first'], in: 'args' }, { signal: 2, at: [0, 'second'], in: 'args' }, { signal: 3, at: [0, 'nested', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'signal'], in: 'args' }];
    if (JSON.stringify(call?.signals) !== JSON.stringify(want)) return `the call carries signals ${JSON.stringify(call?.signals)}`;
    const aborts = list.filter((event) => event.kind === 'abort').map((event) => `${event.dir} ${event.signal}=${value(record, event.reason)}`);
    return JSON.stringify(aborts) === JSON.stringify(['in 2=two', 'in 3=three', 'in 1=one']) ? null : `aborts ${aborts.join(', ')}`;
  },
  /** An option the test set to null is left out (the scheduler's `??`): the recorder supplies it, marked, and its clock, timers and draws are recorded. */
  'null-options': (cases) => {
    const record = byName(cases, NAMES.nulls);
    const construction = record.constructions[0];
    const keys = ['persistence', 'now', 'scheduleTimeout', 'cancelTimeout', 'createTaskId', 'createLeaseToken', 'publishEvent'];
    const missing = keys.filter((key) => !construction?.defaulted.includes(key));
    if (missing.length || construction.defaulted.includes('persistence:internal')) return `defaulted ${JSON.stringify(construction?.defaulted)}`;
    const list = events(record);
    const unsupplied = keys.filter((key) => !list.some((event) => event.kind === 'read' && event.object === 'options' && event.key === key && event.supplied));
    if (unsupplied.length) return `reads of ${unsupplied.join(', ')} not marked supplied`;
    const kinds = ['clock nominal', 'timer.set', 'draw default', 'port persistence.save'].filter((kind) => !list.some((event) => `${event.kind} ${event.source ?? event.name ?? ''}`.trim() === kind));
    return kinds.length ? `no ${kinds.join(', ')} recorded` : null;
  },
  /** A value the scheduler handed out and the test changed later is a note on a recorded case, not an unrecordable one. */
  'receiver-mutation': (cases) => {
    const record = byName(cases, NAMES.receiver);
    if (JSON.stringify(record.flags) !== '[]' || JSON.stringify(record.notes) !== '["mutated-by-receiver"]') return `flags ${JSON.stringify(record.flags)}, notes ${JSON.stringify(record.notes)}`;
    const marked = events(record).filter((event) => event.mutatedByReceiver || event.mutated).map((event) => `${event.dir} ${event.kind} ${JSON.stringify(event.mutatedByReceiver ?? null)} ${JSON.stringify(event.mutated ?? null)}`);
    return JSON.stringify(marked) === JSON.stringify(['out return ["value"] null']) ? null : `marked ${JSON.stringify(marked)}`;
  },
  /** A clear through a primitive handle two live timers share names both, and is attributed to the last. */
  'ambiguous-clear': (cases) => {
    const list = events(byName(cases, NAMES.ambiguous));
    const clears = list.filter((event) => event.kind === 'timer.clear').map((event) => JSON.stringify({ timer: event.timer, ambiguous: event.ambiguous ?? null }));
    return JSON.stringify(clears) === JSON.stringify(['{"timer":2,"ambiguous":[1,2]}']) ? null : `clears ${clears.join(', ')}`;
  },
  /** The whole event sequence of every toy case, as golden.json pins it (order, attribution, during, late, numbers). */
  'golden-events': (cases) => {
    const golden = readGolden();
    const got = goldenOf(cases);
    for (const name of new Set([...Object.keys(golden), ...Object.keys(got)])) {
      const want = golden[name];
      const have = got[name];
      if (!want || !have) return `case ${JSON.stringify(name)} is ${want ? 'missing from the recording' : 'not in golden.json'}`;
      if (want.length !== have.length) return `${name}: ${have.length} constructions, want ${want.length}`;
      for (const [index, list] of want.entries()) {
        const at = list.findIndex((tuple, position) => tuple !== have[index][position]);
        if (at >= 0 || list.length !== have[index].length) {
          const position = at >= 0 ? at : Math.min(list.length, have[index].length);
          return `${name}: construction ${index + 1} event ${position + 1} is ${JSON.stringify(have[index][position] ?? null)}, want ${JSON.stringify(list[position] ?? null)}`;
        }
      }
    }
    return null;
  },
  /** Callbacks the test passes a member are ports; data the scheduler reads from such an object is an input. */
  'test-callbacks': (cases) => {
    const record = byName(cases, NAMES.callback);
    const list = events(record);
    const names = list.filter((event) => event.kind === 'port').map((event) => event.name);
    const read = list.find((event) => event.kind === 'read' && event.key === 'value');
    if (JSON.stringify(names) !== JSON.stringify(['authorize#1.arg1.authorize', 'authorize#1.arg0'])) return `ports ${names.join(', ')}`;
    return read && value(record, read.value) === 21 ? null : 'the read of value is missing';
  },
  /** A timer one test left fires during the next: its events stay with the case that built the scheduler, marked late. */
  'late-owner': (cases) => {
    const owner = byName(cases, NAMES.leaves);
    const next = byName(cases, NAMES.fires);
    if (next.constructions.length !== 0) return `the next test holds ${next.constructions.length} constructions`;
    const late = events(owner).filter((event) => event.late);
    const kinds = late.map((event) => event.kind).join(',');
    return kinds === 'fire,return,settle' ? null : `late events in the owner: ${kinds || 'none'}`;
  },
  /** Every event of a construction carries the next sequence number, and the case order runs across them. */
  'total-order': (cases) => {
    for (const record of cases) {
      const ats = [];
      for (const construction of record.constructions) {
        construction.events.forEach((event, index) => { if (event.seq !== index + 1) throw new Error(`${record.name}: event ${index + 1} has seq ${event.seq}`); ats.push(event.at); });
      }
      const sorted = [...ats].sort((a, b) => a - b);
      if (sorted.some((at, index) => at !== index + 1)) return `${record.name}: case order ${ats.join(',')}`;
    }
    return null;
  },
});

/** Runs every toy check over a toy recording's containers: `{ name: null | finding }`. */
export function runToyChecks(containers) {
  const cases = allCases(containers);
  const results = {};
  for (const [name, check] of Object.entries(TOY_CHECKS)) {
    try { results[name] = check(cases); } catch (error) { results[name] = `threw: ${error.message}`; }
  }
  return results;
}

const problemsOf = (recording) => recording.incomplete.map((entry) => (entry.check === 'unrecordable' ? `${entry.check} ${entry.case.replace(/^.*:\d+ /, '')} [${entry.flags}]` : `${entry.check} ${entry.file ?? '(run)'}`)).sort();
const FIXTURE_PROBLEMS = Object.freeze([
  'empty (run)',
  'no-construction scripts/scheduler-conformance/toy/toy-empty.toy.mjs',
  'unrecordable a member that hands the test scheduler code #1 [handed-code]',
  'unrecordable a port answer that holds a function #1 [unwrapped-function]',
  'unrecordable a port answer that is a class instance holding a method #1 [unwrapped-function]',
  'unrecordable a scheduler that acts after the recording was written #1 [late-after-write]',
  'unrecordable an input the test changes after passing it #1 [mutated-after-crossing]',
  'unrecordable an overlapping test releases #1 [concurrent]',
  'unrecordable an overlapping test waits #1 [concurrent]',
  'unrecordable a value the scheduler handed out crosses back in, changed #1 [mutated-after-crossing]',
].sort());
const REFUSED_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'toy', 'toy-refused.mjs');
/** The line of toy-refused.mjs that holds `text` (exactly once). */
const refusedLine = (text) => {
  const lines = readFileSync(REFUSED_SOURCE, 'utf8').split('\n').flatMap((line, index) => (line.includes(text) ? [index + 1] : []));
  if (lines.length !== 1) throw new Error(`toy-refused.mjs holds ${JSON.stringify(text)} ${lines.length} times`);
  return lines[0];
};
const outside = (kind, text, where) => new RegExp(`^recorder error: a ${kind} read in product code outside any construction's chain \\(an event listener\\?\\) at scripts/scheduler-conformance/toy/toy-refused\\.mjs:${refusedLine(text)} in ${where}: the real value was used$`);
const LISTEN = "box.id = globalThis.crypto.randomUUID();";
// The tests of toy-refused.toy.mjs, in order: 1 unnamed, 2 tail, 3 listener, 4 spin, 5 direct (no error), 6 arms, 7 fires the previous test's listener; then the hooks after test 7.
const REFUSED_ERRORS = Object.freeze([
  ['unnamed-line', () => /^recorder error: a draw read at scripts\/scheduler-conformance\/toy\/toy-refused\.mjs:\d+ has no site in the target spec$/],
  ['tail-call', () => /^recorder error: a draw read by product code whose frame is gone \(a tail call\) has no site/],
  ['listener', () => outside('draw', LISTEN, 'test:3')],
  ['listener-in-a-test-that-built-none', () => outside('draw', LISTEN, 'test:7')],
  ['listener-env-in-the-hooks', () => outside('env', 'box.env = process.env', 'hooks:7')],
  ['listener-calls-the-direct-helper', () => outside('draw', '// a helper tests may call', 'hooks:7')],
  ['listener-after-the-recording-was-written', () => outside('draw', LISTEN, 'hooks:7')],
  // The limit is pinned: 1,000,000 identical reads (docs/TESTING.md), not fewer.
  ['spin', () => /^recorder error: scheduler-conformance: Date\.now\(\) returned the nominal time 1700000000000 1000000 times in a row/],
]);

// The recorder digest covers exactly these files (docs/TESTING.md, Containers): its own two and the shared codec and container.
const DIGEST_FILES = Object.freeze(['scheduler-conformance/recorder.mjs', 'scheduler-conformance/trace.mjs', 'client-conformance/codec.mjs', 'client-conformance/container.mjs']);
// The corpus each corpus check reads, when it is not the check's own name.
export const CORPUS_OF = Object.freeze({ 'recorder-digest': 'toy' });

/** Checks of the fixture recordings, each over the first recording of its corpus (`{ junit, incomplete, ... }`). */
export const CORPUS_CHECKS = Object.freeze({
  /** The toy's header names the digest of exactly the recorder's files (computed here from that list, not by the recorder's code). */
  'recorder-digest': ({ toy }) => {
    const [container] = toy.containers;
    if (!container) return 'no toy container';
    const header = JSON.parse(container.text.slice(0, container.text.indexOf('\n')));
    const scripts = path.join(toy.harnessDir, '..');
    const want = sha256(DIGEST_FILES.map((file) => `${file} ${sha256(readFileSync(path.join(scripts, file)))}`).join('\n'));
    return header.recorder === want ? null : `the header's recorder digest ${header.recorder} is not the digest of ${DIGEST_FILES.join(', ')} (${want})`;
  },
  /** toy-fixtures and toy-empty: each fixture unrecordable with exactly its flag, and the empty file inconclusive. */
  fixtures: ({ fixtures }) => {
    const problems = problemsOf(fixtures);
    return JSON.stringify(problems) === JSON.stringify(FIXTURE_PROBLEMS) ? null : `problems ${JSON.stringify(problems)}`;
  },
  /** toy-refused: every refused hidden read is a recorder error with its own message, and the spinning test fails under the recorder. */
  refused: ({ refused }) => {
    const errors = refused.incomplete.filter((entry) => entry.check === 'recorder-error').map((entry) => entry.detail);
    for (const [name, pattern] of REFUSED_ERRORS) if (!errors.some((detail) => pattern().test(detail))) return `no recorder error for the ${name} read (errors: ${JSON.stringify(errors)})`;
    if (errors.length !== REFUSED_ERRORS.length) return `${errors.length} recorder errors, want ${REFUSED_ERRORS.length}: ${JSON.stringify(errors)}`;
    const spin = refused.junit.find((test) => test.name === 'spins on Date.now() waiting for time to pass');
    return spin?.status === 'failed' ? null : `the spinning test ${spin?.status ?? 'is missing'} under the recorder`;
  },
});

/**
 * Every finding of a set of corpus recordings (first recordings: `{ toy?,
 * fixtures?, refused? }`): the toy checks, the corpus checks, and each
 * problem of the toy recording by its check name (provenance, recorder-error,
 * ...). `{ name: null | finding }` for every check that could run.
 */
export function findings(recordings) {
  const results = {};
  if (recordings.toy) {
    Object.assign(results, runToyChecks(recordings.toy.containers));
    results['toy-complete'] = null;
    for (const entry of recordings.toy.incomplete) results[entry.check] = `${results[entry.check] ? `${results[entry.check]}; ` : ''}${entry.detail}`;
    if (recordings.toy.incomplete.length) results['toy-complete'] = recordings.toy.incomplete.map((entry) => entry.check).join(', ');
  }
  for (const [name, check] of Object.entries(CORPUS_CHECKS)) {
    if (!recordings[CORPUS_OF[name] ?? name]) continue;
    try { results[name] = check(recordings); } catch (error) { results[name] = `threw: ${error.message}`; }
  }
  return results;
}
