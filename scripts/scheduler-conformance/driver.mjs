// Scripted driver of the scheduler conformance harness (design file 30,
// package O0b; §4.2 steps and quiescence, §4.5 crash points). It builds a
// real scheduler (the factory is handed in: this file imports no product
// code) whose every port is the harness's, and drives it by scenario under
// full virtual time:
// - the clock is a number the driver moves (`advance`); `now()` reads it;
// - timers are the driver's: a timer fires only when the driver advances
//   past its due time (set time plus its effective delay, as Node and Bun
//   clamp it: below 1, above 2^31-1 or not finite means 1; a fractional
//   delay is refused, not modelled), earliest due first and then in the
//   order they were set, each fire its own step. Every timer due at one
//   instant fires before any automatic port answer, as in a runtime's timers
//   phase (only microtasks run between two callbacks of one phase; Node and
//   Bun order one instant's timers by due time, and one delay's timers by
//   set order);
// - every asynchronous port call (executor, persistence, hooks) returns a
//   deferred the scenario settles: resolve, reject, or never. A port's
//   policy says who settles it: `hold` (the scenario, explicitly), `auto`
//   (the driver, after quiescence and after every timer due at the current
//   instant, oldest call first, each answer its own step), `never`. This
//   models every port as answering in a later macrotask, one at a time: a
//   hook that is effectively synchronous in production (an auto-resume
//   resolver, a prerequisite check with nothing to read) is a full step
//   here, and no order with a port answering in the middle of a drain is
//   produced. Synchronous ports (publishEvent, logger.warn, the diagnostics
//   hooks, getLastRecoverableResult, resolveExecutionBackend) answer at once
//   with the policy's value. An answer in a step marker names its policy
//   (`by: auto | hold`), so a replayer need not guess who answered;
// - identifiers come from the harness, per named site (createTaskId,
//   createLeaseToken, createWaveId), as the recorder serves them
//   (trace.mjs servedUuid). Hidden draws (randomUUID, performance.now, the
//   environment) are the recorder's: under it they are served and named;
//   without it they are real and the driver's own log never holds them.
//
// Steps. Inputs are delivered in groups: one or more inputs (member calls,
// control calls, port answers, a timer fire, an abort) in the same
// macrotask with no microtask between them, which is how simultaneous calls
// are modelled. Each group is followed by a drain: one setImmediate boundary.
// What is guaranteed, and checked, is narrower than "nothing else can run":
// - every driver macrotask (a boundary, a timer turn of the paranoid drain)
//   runs the microtasks it causes to the end itself (bun:jsc
//   drainMicrotasks) and is marked as the driver's while it does, so any
//   activity at a port, timer, clock, draw or member settlement outside a
//   driver macrotask, or between two steps, came from a macrotask the
//   driver did not start (host I/O, a timer captured before the guard was
//   installed, a MessageChannel): `stray-activity` refuses it at the next
//   step or at the scenario's end, whichever comes first;
// - the drain is confirmed: two more boundaries must show no activity, and
//   no code may have set a real timer, interval or immediate through the
//   globals (`quiescence-confirmed`, `real-timer`);
// - at the end of every scenario a final confirmation (sixteen boundaries
//   and two real timer turns) must show no activity.
// An answer whose value is a promise must have settled by the end. Not seen:
// a foreign macrotask that does nothing visible at a port, timer, clock, draw
// or settlement (invisible to any trace too), and one that fires only after
// the final confirmation and settles nothing the driver answered (a recording
// still marks what it does as late).
// Under the recorder each group begins with an `in step` event (trace.mjs)
// that lists the group's inputs as structured data in delivery order, each
// with the recorder's own numbers, so a replayer delivers them as they were.
//
// Named checks guard the driver itself (DRIVER_CHECKS): each throws a
// DriverCheckError naming its check, and each is pinned by a planted bug in
// a copy of this file (driver-mutants.mjs).
import { EPOCH, servedUuid } from './trace.mjs';

const realSetImmediate = globalThis.setImmediate;
const realSetTimeout = globalThis.setTimeout;
const API = Symbol.for('devryan.scheduler-conformance');
// The driver runs under Bun only: it drains each of its macrotasks' microtasks itself (see `turn`).
const drainMicrotasks = typeof Bun === 'undefined' ? null : (await import('bun:jsc')).drainMicrotasks;

export const DRIVER_CHECKS = Object.freeze({
  'settle-order': 'the driver settles automatic port calls in call order, oldest first',
  'timer-time': 'a timer fires at exactly its set time plus its effective delay, earliest due (then earliest set) first, every timer of an instant before any port answer, and the clock never moves back',
  'input-before-drain': 'a group is delivered only after the previous drain reached confirmed quiescence',
  'group-atomic': 'the inputs of one group are delivered in one macrotask with no microtask between them',
  'quiescence-confirmed': 'after a drain reports quiescence, two more event-loop turns show no activity',
  'real-timer': 'no code set a real timer, interval or immediate while a scenario ran (its callback would arrive in no step)',
  'stray-activity': 'activity at a port, timer, clock, draw or settlement happens only inside the driver\'s own macrotasks and never between steps (none from host I/O, a captured timer or a message)',
  'unknown-port': 'every port the scheduler calls has a policy',
  'dead-instance': 'a crashed instance does nothing after its crash',
  'crash-not-reached': 'the crash point a run asks for is reached',
});

export class DriverCheckError extends Error {
  constructor(check, detail) {
    super(`scheduler driver check ${check}: ${detail}`);
    this.name = 'DriverCheckError';
    this.check = check;
  }
}
const fail = (check, detail) => { throw new DriverCheckError(check, detail); };
/** Thrown at the scenario's next input once its instance reached the crash point: the runner then restarts. */
export const CRASH_STOP = Object.freeze({ crashStop: true });

/** Node and Bun run a timer of delay below 1, above 2^31-1 or not finite after 1 ms (as the recorder's nominal clock does). */
export const effectiveDelay = (delay) => {
  const number = Number(delay);
  return Number.isFinite(number) && number >= 1 && number <= 2147483647 ? Math.trunc(number) : 1;
};
/** A delay the platforms do not agree on (Node keeps a fraction), which the driver refuses rather than models. */
const fractionalDelay = (delay) => { const number = Number(delay); return Number.isFinite(number) && number >= 1 && number <= 2147483647 && !Number.isInteger(number); };

// The driver's own macrotasks. Each marks itself as the driver's turn and runs every microtask it causes to the end
// before it returns, so activity seen while `turn` is null came from a macrotask somebody else started.
let turn = null;
let turnSeq = 0;
export const turnCounts = { boundaries: 0, timerTurns: 0 };
const inTurn = (resolve) => () => {
  turn = (turnSeq += 1);
  try { resolve(); drainMicrotasks(); } finally { turn = null; }
};
const boundary = () => new Promise((resolve) => { turnCounts.boundaries += 1; realSetImmediate(inTurn(resolve)); });
const timerTurn = () => new Promise((resolve) => { turnCounts.timerTurns += 1; realSetTimeout(inTurn(resolve), 1); });

/** Drain modes: `one` (the driver's), `paranoid` (the Q1 reference: many immediates and two timer turns), `microtasks:N` (only N microtask turns: the probe's negative control). */
export const DRAIN_MODES = Object.freeze(['one', 'paranoid']);
const parseDrain = (mode) => {
  if (DRAIN_MODES.includes(mode)) return { kind: mode };
  const match = /^microtasks:(\d+)$/.exec(mode ?? '');
  if (match) return { kind: 'microtasks', count: Number(match[1]) };
  throw new TypeError(`scheduler driver: unknown drain mode ${mode}`);
};

const SYNC_PORTS = new Set(['publishEvent', 'logger.warn', 'executor.getLastRecoverableResult', 'resolveExecutionBackend', 'onBarrierChange', 'onRequiredCheckReceipt', 'onRunCleanup', 'onPersistenceObservation', 'onMutationTiming']);
/** The policies every instance starts from; a scenario overrides them per port. */
export const DEFAULT_PORTS = Object.freeze({
  'executor.start': { mode: 'hold' },
  'executor.resume': { mode: 'hold' },
  'executor.retryInPlace': { mode: 'hold' },
  'executor.observe': { mode: 'hold' },
  'executor.abort': { mode: 'auto', answer: () => ({ aborted: true }) },
  'executor.reconcile': { mode: 'auto', answer: () => ({ state: 'unavailable' }) },
  'executor.readRecoverableResult': { mode: 'auto', answer: () => ({ recoverablePreview: '', canonicalRefs: [] }) },
  'executor.getLastRecoverableResult': { mode: 'sync', answer: () => null },
  'executor.shutdown': { mode: 'auto', answer: () => undefined },
  'persistence.load': { mode: 'auto', answer: () => null },
  'persistence.save': { mode: 'auto', answer: () => undefined },
  publishEvent: { mode: 'sync', answer: () => undefined },
  'logger.warn': { mode: 'sync', answer: () => undefined },
});
const EXECUTOR_METHODS = ['start', 'resume', 'retryInPlace', 'observe', 'abort', 'reconcile', 'readRecoverableResult', 'getLastRecoverableResult', 'shutdown'];
const LAUNCH_PORTS = new Set(['executor.start', 'executor.resume', 'executor.retryInPlace']);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}

/** What the driver's log keeps of a port call: plain, deterministic facts only (no saved owner IDs, no random draws). */
function brief(name, args) {
  if (name.startsWith('executor.') && args[0] && typeof args[0] === 'object') return { taskId: args[0].taskId ?? null, label: args[0].label ?? null, status: args[0].status ?? null };
  if (name === 'persistence.save' && args[0] && Array.isArray(args[0].tasks)) {
    const statuses = {};
    for (const task of args[0].tasks) statuses[task.status] = (statuses[task.status] ?? 0) + 1;
    return { tasks: args[0].tasks.length, statuses };
  }
  return null;
}
const briefValue = (value) => (value && typeof value === 'object' && typeof value.taskId === 'string' ? { taskId: value.taskId, status: value.status ?? null }
  : value === undefined || value === null || typeof value !== 'object' ? (typeof value === 'function' ? '<function>' : value ?? null) : Array.isArray(value) ? `<array ${value.length}>` : '<object>');
const errorCode = (error) => (error && typeof error === 'object' ? error.code ?? error.name ?? 'error' : String(error));

/**
 * A driver for one scenario run. `name` keys the served identifiers (two
 * runs of a scenario draw the same ones); `drain` is a drain mode;
 * `encodeSaved` turns a saved state into the bytes a crash point reloads
 * (the reference ledger encoder); `crash`: `{ index, mode }` stops the
 * running instance at its `index`-th save (1-based): `durable` (the bytes
 * were written, the promise never resolved: the fresh instance loads them)
 * or `torn` (the write never happened: it loads the save before).
 */
export class Driver {
  constructor({ name, drain = 'one', encodeSaved = null, crash = null }) {
    this.name = name;
    this.drain = parseDrain(drain);
    this.encodeSaved = encodeSaved;
    this.crash = crash;
    this.time = EPOCH;
    this.steps = 0;
    this.phase = 'quiet';
    this.activity = 0;
    this.lastActivity = 'nothing';
    this.portSeq = 0;
    this.callSeq = 0;
    this.draws = new Map();
    this.instances = [];
    this.inst = null;
    this.log = [];
    this.saved = []; // encoded saved states of the current instance, in save order (only with encodeSaved)
    this.crashed = null; // { instance, save, mode, state, step } once a crash point is reached
    this.pendingAutos = new Set(); // pending automatic port calls, in call order
    this.foreign = [];
    this.installed = null;
    this.problems = []; // [check, detail]: found where throwing would land inside the scheduler; raised at the next step or at the end
    this.drainShapes = new Set(); // `${boundaries}/${timerTurns}` of every drain, before its confirmation
    this.crashSaves = null; // the crashed instance's encoded saves, once restarted
    this.openValues = new Set(); // answers whose value is a promise still unsettled
  }

  // ------------------------------------------------------------ activity

  /** Once the crash point is reached the scenario's script stops at its next look or input: the runner restarts. */
  alive() { if (this.crashed) throw CRASH_STOP; }

  touch(inst, label) {
    if (inst?.dead) fail('dead-instance', `instance ${inst.n} crashed at step ${inst.diedAt} but did ${label} at step ${this.steps}`);
    if (turn === null) this.problems.push(['stray-activity', `${label} after step ${this.steps} ran in a macrotask the driver did not start (host I/O, a captured timer, a message)`]);
    else if (this.phase === 'quiet') this.problems.push(['stray-activity', `${label} ran between step ${this.steps} and the next`]);
    this.activity += 1;
    this.lastActivity = label;
  }

  /** Raises the first problem found where throwing would have landed inside the scheduler. */
  raise() {
    if (this.problems.length) fail(this.problems[0][0], `${this.problems[0][1]}${this.problems.length > 1 ? ` (and ${this.problems.length - 1} more)` : ''}`);
  }

  /** Enters the driver's own macrotasks: everything a scenario does runs inside them. */
  async start() {
    if (!drainMicrotasks) throw new Error('scheduler driver: it runs under Bun only (bun:jsc drainMicrotasks)');
    this.install();
    await boundary();
  }

  /** The end of a scenario: sixteen more boundaries and two real timer turns must show no activity, and nothing stray happened. */
  async finish() {
    const before = this.activity;
    const label = this.lastActivity;
    this.phase = 'finishing';
    for (let turnIndex = 0; turnIndex < 8; turnIndex += 1) await boundary();
    await timerTurn();
    for (let turnIndex = 0; turnIndex < 8; turnIndex += 1) await boundary();
    await timerTurn();
    this.phase = 'quiet';
    if (this.foreign.length) fail('real-timer', `${this.foreign[0]}${this.foreign.length > 1 ? ` and ${this.foreign.length - 1} more` : ''}`);
    this.raise();
    if (this.activity !== before) fail('stray-activity', `the scenario ended after "${label}", but "${this.lastActivity}" followed (${this.activity - before} more)`);
    const [open] = this.openValues;
    if (open) fail('stray-activity', `the answer to ${open.entry.name}#${open.entry.index} is a promise still unsettled when the scenario ends: it would settle in a macrotask the driver does not start`);
  }

  /** Real timers, intervals and immediates set by anyone but the driver while a scenario runs are reported, never waited for. */
  install() {
    if (this.installed) return;
    const saved = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval, setImmediate: globalThis.setImmediate };
    const note = (kind, original) => function (...args) {
      const where = (new Error().stack ?? '').split('\n').slice(2, 4).map((line) => line.trim()).join(' < ');
      driverSelf.foreign.push(`${kind} at step ${driverSelf.steps} (${where})`);
      return Reflect.apply(original, this, args);
    };
    const driverSelf = this;
    globalThis.setTimeout = note('setTimeout', saved.setTimeout);
    globalThis.setInterval = note('setInterval', saved.setInterval);
    globalThis.setImmediate = note('setImmediate', saved.setImmediate);
    this.installed = saved;
  }

  dispose() {
    if (!this.installed) return;
    Object.assign(globalThis, this.installed);
    this.installed = null;
  }

  // ------------------------------------------------------------ instances

  /**
   * Builds a scheduler with the driver's ports. `ports` overrides policies
   * by port name; `options` adds constants and hooks (a function option is a
   * port named by its key; an object of functions, a port per method, e.g.
   * autoResume); `load` is what persistence.load answers.
   */
  build(factory, { ports = {}, options = {}, load = null } = {}) {
    this.install();
    if (this.phase !== 'quiet') fail('input-before-drain', `build while the driver is ${this.phase}`);
    const inst = { n: this.instances.length + 1, dead: false, diedAt: null, policies: { ...DEFAULT_PORTS, 'persistence.load': { mode: 'auto', answer: () => load }, ...ports }, entries: [], counts: new Map(), timers: new Map(), timerSeq: 0, saves: 0, scheduler: null };
    this.instances.push(inst);
    this.inst = inst;
    this.saved = [];
    const port = (name) => {
      const self = this;
      return function harnessPort(...args) { return self.portCall(inst, name, args); };
    };
    const executor = {};
    for (const method of EXECUTOR_METHODS) if (inst.policies[`executor.${method}`]) executor[method] = port(`executor.${method}`);
    const persistence = {};
    for (const method of ['load', 'save', 'loadNativeJobProofShards', 'putNativeJobProofShard', 'removeNativeJobProofShard']) if (inst.policies[`persistence.${method}`]) persistence[method] = port(`persistence.${method}`);
    const built = {
      executor,
      persistence,
      now: () => { this.touch(inst, 'now()'); return this.time; },
      scheduleTimeout: (callback, delay) => this.setTimer(inst, callback, delay),
      cancelTimeout: (handle) => this.clearTimer(inst, handle),
      createTaskId: () => this.draw(inst, 'createTaskId', 'dvr_task_'),
      createLeaseToken: () => this.draw(inst, 'createLeaseToken', 'dvr_lease_'),
      createWaveId: () => this.draw(inst, 'createWaveId', 'dvr_wave_'),
      publishEvent: port('publishEvent'),
      logger: { warn: port('logger.warn') },
    };
    for (const [key, value] of Object.entries(options)) {
      if (typeof value === 'function') built[key] = port(key);
      else if (value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).some((item) => typeof item === 'function')) {
        built[key] = Object.fromEntries(Object.entries(value).map(([method, item]) => [method, typeof item === 'function' ? port(`${key}.${method}`) : item]));
        for (const [method, item] of Object.entries(value)) if (typeof item === 'function' && !inst.policies[`${key}.${method}`]) inst.policies[`${key}.${method}`] = { mode: SYNC_PORTS.has(`${key}.${method}`) ? 'sync' : 'auto', answer: item };
      } else built[key] = value;
      if (typeof value === 'function' && !inst.policies[key]) inst.policies[key] = { mode: SYNC_PORTS.has(key) ? 'sync' : 'auto', answer: value };
    }
    this.log.push(['build', inst.n, this.time]);
    this.phase = 'building';
    try { inst.scheduler = factory(built); } finally { this.phase = 'quiet'; }
    return inst;
  }

  draw(inst, site, prefix) {
    this.touch(inst, `draw ${site}`);
    const count = (this.draws.get(site) ?? 0) + 1;
    this.draws.set(site, count);
    return `${prefix}${servedUuid(`driver:${this.name}:${site}:${count}`).replaceAll('-', '')}`;
  }

  // ------------------------------------------------------------ ports

  portCall(inst, name, args) {
    this.touch(inst, `port ${name}`);
    const policy = inst.policies[name];
    if (!policy) fail('unknown-port', `the scheduler called ${name}, which has no policy`);
    const index = (inst.counts.get(name) ?? 0) + 1;
    inst.counts.set(name, index);
    const entry = { seq: (this.portSeq += 1), inst: inst.n, index, name, args, state: 'pending', policy, mode: null, deferred: null, step: this.steps };
    // A policy's mode may depend on the call (`(entry) => mode`): hold the third save, answer the others.
    entry.mode = typeof policy.mode === 'function' ? policy.mode(entry) : policy.mode;
    inst.entries.push(entry);
    this.log.push(['port', inst.n, entry.seq, name, brief(name, args)]);
    // The recorder's number for this port call (it is on the recorder's stack now), for the step markers.
    entry.recorded = globalThis[API]?.portOnStack?.(inst.n) ?? null;
    if (name === 'persistence.save') this.onSave(inst, entry);
    if (entry.mode === 'sync') {
      entry.state = 'returned';
      return policy.answer ? policy.answer(entry) : undefined;
    }
    entry.deferred = deferred();
    if (entry.crashHold) entry.mode = 'never';
    if (entry.mode === 'auto') this.pendingAutos.add(entry);
    return entry.deferred.promise;
  }

  onSave(inst, entry) {
    inst.saves += 1;
    if (this.encodeSaved) this.saved.push(this.encodeSaved(entry.args[0]));
    if (this.crash && inst === this.instances[0] && inst.saves === this.crash.index) {
      // The process dies with this write in flight: its promise never settles.
      entry.crashHold = true;
      const state = this.crash.mode === 'torn' ? (this.saved.length >= 2 ? this.saved[this.saved.length - 2] : null) : this.saved[this.saved.length - 1];
      this.crashed = { instance: inst.n, save: inst.saves, mode: this.crash.mode, state, step: this.steps };
    }
  }

  /**
   * A function the scenario hands the scheduler in a member's arguments (an
   * action, an authorize callback): a port of the current instance named
   * `name`, settled like any other (default: held for the scenario).
   */
  hook(name, policy = { mode: 'hold' }) {
    const inst = this.inst;
    if (!inst.policies[name]) inst.policies[name] = policy;
    const self = this;
    return function harnessHook(...args) { return self.portCall(inst, name, args); };
  }

  /** The pending calls of a port in the current instance (or all of its calls with `all`). */
  pending(name, { all = false } = {}) {
    this.alive();
    return this.inst.entries.filter((entry) => entry.name === name && (all || entry.state === 'pending'));
  }

  // ------------------------------------------------------------ timers

  setTimer(inst, callback, delay) {
    this.touch(inst, 'timer.set');
    const id = (inst.timerSeq += 1);
    if (fractionalDelay(delay)) this.problems.push(['timer-time', `timer ${id} has the fractional delay ${delay}, which Node keeps and the driver does not model`]);
    const timer = { id, callback, delay, setAt: this.time, due: this.time + effectiveDelay(delay), recorded: globalThis[API]?.lastTimer?.(inst.n) ?? null };
    inst.timers.set(id, timer);
    this.log.push(['timer.set', inst.n, id, typeof delay === 'number' ? delay : String(delay), timer.due - EPOCH]);
    return Object.freeze({ harnessTimer: id, instance: inst.n });
  }

  clearTimer(inst, handle) {
    this.touch(inst, 'timer.clear');
    const id = handle && typeof handle === 'object' && handle.instance === inst.n ? handle.harnessTimer : null;
    if (id !== null && inst.timers.has(id)) inst.timers.delete(id);
    this.log.push(['timer.clear', inst.n, id]);
  }

  /** The live timer that fires next at or before `limit`: earliest due, then earliest set. */
  nextTimer(limit) {
    let next = null;
    for (const timer of this.inst.timers.values()) {
      if (timer.due > limit) continue;
      if (!next || timer.due < next.due || (timer.due === next.due && timer.id < next.id)) next = timer;
    }
    return next;
  }

  /** timer-time: the fire happens at its own due time, recomputed from what was set, and no live timer is due before it. */
  checkFire(timer, previousTime) {
    const want = timer.setAt + effectiveDelay(timer.delay);
    if (this.time !== want) fail('timer-time', `timer ${timer.id} (set at +${timer.setAt - EPOCH} with delay ${timer.delay}) fires at +${this.time - EPOCH}, not +${want - EPOCH}`);
    if (this.time < previousTime) fail('timer-time', `the clock moved back from +${previousTime - EPOCH} to +${this.time - EPOCH}`);
    for (const other of this.inst.timers.values()) {
      if (other === timer) continue;
      const otherDue = other.setAt + effectiveDelay(other.delay);
      if (otherDue < want || (otherDue === want && other.id < timer.id)) fail('timer-time', `timer ${timer.id} fires before timer ${other.id}, which is due at +${otherDue - EPOCH}`);
    }
  }

  /**
   * Moves the clock by `ms`, firing every timer due on the way. All timers
   * due at one instant fire first, each in its own step with nothing but
   * microtasks between them (a runtime's timers phase); only then are the
   * automatic ports answered. With `until`, it stops after the first instant
   * after which `until()` holds (the clock stays at that instant).
   */
  async advance(ms, { until = null } = {}) {
    this.alive();
    const target = this.time + ms;
    for (;;) {
      const first = this.nextTimer(target);
      if (!first) break;
      const instant = first.due;
      for (let timer = first; timer; timer = this.nextTimer(instant)) {
        const previous = this.time;
        this.time = timer.due;
        this.checkFire(timer, previous);
        await this.deliver([this.fire(timer)]);
      }
      await this.settleAutos();
      if (until?.()) return;
    }
    if (target > this.time) this.time = target;
  }

  /** The delays of the live timers of the current instance, in set order. */
  liveTimers() { return [...this.inst.timers.values()].map((timer) => ({ id: timer.id, delay: timer.delay, due: timer.due - EPOCH })); }

  // ------------------------------------------------------------ inputs
  //
  // An input is `{ label, describe, run }`: `describe()` is its structured
  // form in the step marker, taken just before it runs (`construction`: the
  // instance it reaches; the recorder's numbers: `call` for a call, control
  // or fire, `port` for an answer, `of` for the port call a control belongs
  // to, `timer`, `signal`; null without the recorder).

  /** A timer fire, as an input. */
  fire(timer) {
    const inst = this.inst;
    return {
      label: `fire timer ${timer.id}`,
      describe: () => ({ kind: 'fire', construction: inst.n, timer: timer.recorded, call: this.nextCall(inst) }),
      run: () => { inst.timers.delete(timer.id); this.log.push(['fire', inst.n, timer.id, this.time - EPOCH]); timer.callback(); },
    };
  }

  /** The recorder's number for the next input call of an instance (null without the recorder). */
  nextCall(inst) { return globalThis[API]?.nextCall?.(inst.n) ?? null; }

  /** A member call of the current scheduler. Its handle says how it ended (`returned`, `threw`, `resolved`, `rejected`). */
  call(member, ...args) {
    this.alive();
    const inst = this.inst;
    return {
      label: `call ${member}`,
      describe: () => ({ kind: 'call', construction: inst.n, member, call: this.nextCall(inst) }),
      run: () => this.track(inst, member, () => inst.scheduler[member](...args)),
    };
  }

  /** A call of a method of the control object the scheduler handed executor call `entry`. */
  control(entry, method, ...args) {
    this.alive();
    const inst = this.instances[entry.inst - 1];
    return {
      label: `control ${method} of ${entry.name}#${entry.index}`,
      describe: () => ({ kind: 'control', construction: inst.n, method, of: entry.recorded, call: this.nextCall(inst) }),
      run: () => this.track(inst, `control.${method}`, () => entry.args[1][method](...args)),
    };
  }

  /** Settles a pending port call: `resolve` (default) or `reject`. */
  answer(entry, value, outcome = 'resolve') {
    this.alive();
    if (!entry) throw new TypeError('scheduler driver: answer() needs a port call');
    return {
      label: `answer ${entry.name}#${entry.index} ${outcome}`,
      describe: () => ({ kind: 'answer', construction: entry.inst, port: entry.recorded, outcome, by: entry.mode === 'auto' ? 'auto' : 'hold' }),
      run: () => {
        if (entry.state !== 'pending') throw new Error(`scheduler driver: ${entry.name}#${entry.index} is ${entry.state}, not pending`);
        entry.state = outcome === 'reject' ? 'rejected' : 'resolved';
        this.pendingAutos.delete(entry);
        this.log.push(['answer', entry.inst, entry.seq, outcome, briefValue(value)]);
        // An answer whose value is itself a promise must settle inside the driver's turns too: one still open when the
        // scenario ends would land after it, where no step can hold it.
        if (value && typeof value.then === 'function') {
          const open = { entry, settled: false };
          this.openValues.add(open);
          const settled = () => { open.settled = true; this.openValues.delete(open); };
          value.then(settled, settled);
        }
        if (outcome === 'reject') entry.deferred.reject(value); else entry.deferred.resolve(value);
      },
    };
  }

  /** Aborts a signal the scenario handed the scheduler. */
  abort(controller, reason, label = 'signal') {
    this.alive();
    const inst = this.inst;
    return {
      label: `abort ${label}`,
      describe: () => ({ kind: 'abort', construction: inst.n, signal: globalThis[API]?.signalNumber?.(inst.n, controller.signal) ?? null }),
      run: () => { this.log.push(['abort', label]); controller.abort(reason); },
    };
  }

  track(inst, member, thunk) {
    const handle = { id: (this.callSeq += 1), member, state: 'pending', value: undefined, error: undefined };
    this.log.push(['call', inst.n, handle.id, member]);
    let result;
    try {
      result = thunk();
    } catch (error) {
      handle.state = 'threw';
      handle.error = error;
      this.log.push(['threw', handle.id, errorCode(error)]);
      return handle;
    }
    if (result && typeof result.then === 'function') {
      result.then((value) => {
        this.touch(inst, `settle ${member}`);
        handle.state = 'resolved';
        handle.value = value;
        this.log.push(['resolved', handle.id, briefValue(value)]);
      }, (error) => {
        this.touch(inst, `settle ${member}`);
        handle.state = 'rejected';
        handle.error = error;
        this.log.push(['rejected', handle.id, errorCode(error)]);
      });
    } else {
      handle.state = 'returned';
      handle.value = result;
      this.log.push(['returned', handle.id, briefValue(result)]);
    }
    return handle;
  }

  // ------------------------------------------------------------ steps

  /** Delivers one group, drains it to confirmed quiescence, then settles every automatic port call (each its own step). Returns the inputs' handles. */
  async step(...inputs) {
    const results = await this.deliver(inputs);
    await this.settleAutos();
    return results.length === 1 ? results[0] : results;
  }

  async deliver(inputs) {
    if (this.phase !== 'quiet') fail('input-before-drain', `step ${this.steps + 1} (${inputs.map((item) => item.label).join(', ')}) was delivered while the driver was ${this.phase}`);
    if (this.crashed) throw CRASH_STOP;
    this.raise();
    this.phase = 'delivering';
    const number = (this.steps += 1);
    const labels = inputs.map((item) => item.label);
    this.log.push(['step', number, this.time - EPOCH, labels]);
    const api = globalThis[API];
    api?.step?.({ step: number, now: this.time, inputs: [] });
    const group = { open: true };
    queueMicrotask(() => { group.open = false; });
    const results = [];
    for (const input of inputs) {
      if (!group.open) fail('group-atomic', `input "${input.label}" of step ${number} was delivered after a microtask ran: the group was split`);
      // The marker lists each input as it is delivered, with the recorder's numbers taken just before it runs.
      if (api?.stepInput) api.stepInput({ ...(input.describe ? input.describe() : { kind: 'other' }), label: input.label });
      results.push(input.run());
    }
    this.phase = 'draining';
    await this.quiesce();
    await this.confirm(number);
    if (this.crashed && !this.inst.dead) { this.inst.dead = true; this.inst.diedAt = number; this.log.push(['crash', this.inst.n, this.crashed.save, this.crashed.mode]); }
    this.phase = 'quiet';
    return results;
  }

  async quiesce() {
    const before = { ...turnCounts };
    if (this.drain.kind === 'one') await boundary();
    else if (this.drain.kind === 'paranoid') {
      for (let turnIndex = 0; turnIndex < 8; turnIndex += 1) await boundary();
      await timerTurn();
      for (let turnIndex = 0; turnIndex < 8; turnIndex += 1) await boundary();
      await timerTurn();
      await boundary();
    } else for (let turnIndex = 0; turnIndex < this.drain.count; turnIndex += 1) await null;
    this.drainShapes.add(`${turnCounts.boundaries - before.boundaries}/${turnCounts.timerTurns - before.timerTurns}`);
  }

  /** quiescence-confirmed, real-timer and stray-activity: two more turns of the event loop show nothing, no real timer was set, and nothing ran outside the driver's turns. */
  async confirm(number) {
    const before = this.activity;
    const label = this.lastActivity;
    await boundary();
    await boundary();
    // A real timer is known when it is set, and a stray when it ran, so both are reported before the activity they may
    // have caused here: where a foreign callback lands depends on the machine's load, what it is does not.
    if (this.foreign.length) fail('real-timer', `${this.foreign[0]}${this.foreign.length > 1 ? ` and ${this.foreign.length - 1} more` : ''}`);
    this.raise();
    if (this.activity !== before) fail('quiescence-confirmed', `the drain of step ${number} reported quiescence after "${label}", but "${this.lastActivity}" followed (${this.activity - before} more)`);
  }

  /** The oldest pending automatic port call of a live instance. */
  nextAuto() {
    for (const entry of this.pendingAutos) if (!this.instances[entry.inst - 1].dead) return entry;
    return null;
  }

  /** settle-order: no older automatic call of a live instance is still pending. */
  checkSettleOrder(entry) {
    for (const other of this.pendingAutos) {
      if (other === entry || this.instances[other.inst - 1].dead || other.state !== 'pending') continue;
      if (other.seq < entry.seq) fail('settle-order', `${entry.name}#${entry.index} (call ${entry.seq}) is settled before ${other.name}#${other.index} (call ${other.seq})`);
    }
  }

  async settleAutos() {
    for (;;) {
      if (this.crashed) return;
      const entry = this.nextAuto();
      if (!entry) return;
      this.checkSettleOrder(entry);
      // timer-time: a port answers only after every timer due at this instant has fired (one timers phase).
      const due = this.nextTimer(this.time);
      if (due) fail('timer-time', `${entry.name}#${entry.index} is answered at +${this.time - EPOCH} before timer ${due.id}, due then, fired`);
      let outcome = 'resolve';
      let value;
      try {
        const answered = entry.policy.answer ? entry.policy.answer(entry, this) : undefined;
        if (answered && typeof answered === 'object' && answered.$reject !== undefined) { outcome = 'reject'; value = answered.$reject; } else value = answered;
      } catch (error) {
        outcome = 'reject';
        value = error;
      }
      await this.deliver([this.answer(entry, value, outcome)]);
    }
  }

  /** After a crash point: a fresh instance that loads what the crashed one left on disk. */
  restart(factory, config = {}) {
    if (!this.crashed) fail('crash-not-reached', `no crash at save ${this.crash?.index} (${this.inst?.saves ?? 0} saves made)`);
    const state = this.crashed.state;
    this.crashed = { ...this.crashed, restarted: true };
    const crashedAt = this.crashed;
    this.crashed = null;
    this.crash = null;
    this.crashSaves = this.saved;
    const inst = this.build(factory, { ...config, load: state === null ? null : JSON.parse(state) });
    inst.restartedFrom = crashedAt;
    return inst;
  }
}

/** Facts of a driver log: what a scenario shows (launches, saves, steps), computed from the log alone. */
export function logFacts(log) {
  const facts = { steps: 0, saves: 0, launches: [], savesBeforeFirstLaunch: null, launchSteps: [], reconciles: [], crashes: [] };
  let step = 0;
  for (const entry of log) {
    if (entry[0] === 'step') { step = entry[1]; facts.steps = step; continue; }
    if (entry[0] === 'crash') { facts.crashes.push({ instance: entry[1], save: entry[2], mode: entry[3] }); continue; }
    if (entry[0] !== 'port') continue;
    const [, instance, , name, info] = entry;
    if (name === 'persistence.save') facts.saves += 1;
    if (LAUNCH_PORTS.has(name)) {
      if (facts.savesBeforeFirstLaunch === null) facts.savesBeforeFirstLaunch = facts.saves;
      facts.launches.push({ instance, port: name, taskId: info?.taskId ?? null, step, savesBefore: facts.saves });
      facts.launchSteps.push(step);
    }
    if (name === 'executor.reconcile') facts.reconciles.push({ instance, taskId: info?.taskId ?? null, step });
  }
  return facts;
}

/** The first entry where two driver logs differ, or null. */
export function firstLogDifference(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = JSON.stringify(left[index]);
    const b = JSON.stringify(right[index]);
    if (a !== b) return { index, left: a ?? '(none)', right: b ?? '(none)' };
  }
  return null;
}
