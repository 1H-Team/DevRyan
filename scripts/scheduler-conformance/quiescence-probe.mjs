// The quiescence probe (design file 30 §8.2 Q1): is one setImmediate boundary
// a sound quiescence point when every port is a harness deferred? Run by
// experiment, in this process (run it with bun; node works too, slowly):
//
//   bun scripts/scheduler-conformance/quiescence-probe.mjs [--scenarios=<name,...>]
//
// 1. Event loop: a microtask chain of any depth, promise reactions included,
//    finishes before an immediate queued before it started; structuredClone,
//    TextEncoder and AbortSignal dispatch queue no macrotask.
// 2. Every scenario, drained with one boundary and with the paranoid drain
//    (sixteen boundaries and two real timer turns per step), gives the same
//    driver log; and twice with one boundary, the same log (determinism).
// 3. The microtask depth a fixed microtask count would need differs from
//    scenario to scenario (the smallest `microtasks:N` drain that passes the
//    driver's confirmation): so no fixed count is sound, and one boundary is.
// 4. Where one boundary is not sound, the driver says so and stops: a real
//    timer, interval or immediate set while a scenario runs (`real-timer`),
//    activity after a drain (`quiescence-confirmed`, here from a drain of
//    one microtask), and activity from a macrotask the driver did not start
//    (`stray-activity`: a port answer settled by host I/O, by a timer captured
//    before the driver's guard was installed, whether it lands between steps
//    or inside a later step's drain, or after the scenario ends, or by a
//    MessageChannel). An answer that settles after a million microtasks is
//    no stray.
// 5. Every drain took the turns its mode says: one boundary, or the paranoid
//    sixteen boundaries (eight, a timer turn, eight, a timer turn, one more).
// Prints one JSON line; exit 1 when an expectation does not hold.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promises as fsp } from 'node:fs';
import { DriverCheckError, firstLogDifference } from './driver.mjs';
import { runScenario, SCENARIOS, scenarioNamed, taskInput } from './scenarios.mjs';
import { createManagedTaskScheduler } from '../../packages/orchestration-runtime/scheduler.js';

const realSetImmediate = globalThis.setImmediate;
// Taken at load, before any driver installs its guard: as a module that captured it at import would.
const capturedSetTimeout = globalThis.setTimeout;

/** 1: what the event loop guarantees, by experiment. */
export async function eventLoopProbes() {
  const results = {};
  for (const depth of [1, 1_000, 100_000]) {
    let done = false;
    let chain = Promise.resolve();
    const order = [];
    const immediate = new Promise((resolve) => { realSetImmediate(() => { order.push(`immediate (chain ${done ? 'done' : 'unfinished'})`); resolve(); }); });
    for (let index = 0; index < depth; index += 1) chain = chain.then(() => undefined);
    chain.then(() => { done = true; order.push('chain'); });
    await immediate;
    results[`microtask chain ${depth}`] = order.join(' < ');
  }
  // Each mechanism runs inside a microtask chain; a macrotask it queued would still be pending when the immediate runs.
  const mechanisms = {
    structuredClone: () => structuredClone({ tasks: Array.from({ length: 2_000 }, (_, index) => ({ index, nested: { text: 'x'.repeat(32) } })) }),
    TextEncoder: () => new TextEncoder().encode('x'.repeat(100_000)).byteLength,
    'AbortSignal dispatch': () => { const controller = new AbortController(); let heard = 0; controller.signal.addEventListener('abort', () => { heard += 1; Promise.resolve().then(() => { heard += 1; }); }); controller.abort(new Error('probe')); return heard; },
  };
  for (const [name, run] of Object.entries(mechanisms)) {
    const foreign = [];
    const saved = { setTimeout: globalThis.setTimeout, setImmediate: globalThis.setImmediate, setInterval: globalThis.setInterval };
    for (const key of Object.keys(saved)) globalThis[key] = (...args) => { foreign.push(key); return saved[key](...args); };
    let after = null;
    try {
      const immediate = new Promise((resolve) => { realSetImmediate(resolve); });
      Promise.resolve().then(run).then((value) => { after = value; });
      await immediate;
    } finally { Object.assign(globalThis, saved); }
    results[name] = { macrotasksQueued: foreign.length, finishedBeforeTheImmediate: after !== null };
  }
  return results;
}

/** 2 and 3 for one scenario. */
async function scenarioProbe(scenario) {
  const one = await runScenario(scenario, { drain: 'one' });
  const again = await runScenario(scenario, { drain: 'one' });
  const paranoid = await runScenario(scenario, { drain: 'paranoid' });
  let depth = null;
  for (let count = 1; count <= 1 << 16; count *= 2) {
    try { await runScenario(scenario, { drain: `microtasks:${count}` }); depth = count; break; } catch (error) { if (!(error instanceof DriverCheckError) || error.check !== 'quiescence-confirmed') throw error; }
  }
  return { steps: one.facts.steps, saves: one.facts.saves, log: one.log.length, deterministic: firstLogDifference(one.log, again.log), drainEqual: firstLogDifference(one.log, paranoid.log), microtaskDepth: depth, drains: { one: [...one.driver.drainShapes], paranoid: [...paranoid.driver.drainShapes] } };
}

/** 4: the conditions under which one boundary is not sound, each reported by the driver. */
export async function negativeControls() {
  const outcome = async (scenario) => { try { await runScenario(scenario); return 'passed'; } catch (error) { return error instanceof DriverCheckError ? error.check : `error: ${error?.message ?? error}`; } };
  const viaRealTimer = (kind) => ({
    name: `prerequisites answered after a real ${kind}`,
    async run(d) {
      d.build(createManagedTaskScheduler, { options: { verifyTaskPrerequisites: () => true }, ports: { verifyTaskPrerequisites: { mode: 'hold' } } });
      await d.step(d.call('initialize'));
      await d.step(d.call('submit', taskInput('late', { taskPrerequisites: [{ taskId: 'dvr_task_producer', checkName: 'interface', paths: ['src/api.js'], contentHash: 'a'.repeat(64) }] })));
      // The answer comes from outside the driver: a real timer or immediate settles the held deferred.
      const [held] = d.pending('verifyTaskPrerequisites');
      await d.step({ label: `real ${kind}`, run: () => { globalThis[kind](() => held.deferred.resolve(true), 0); } });
    },
  });
  const PRE = [{ taskId: 'dvr_task_producer', checkName: 'interface', paths: ['src/api.js'], contentHash: 'a'.repeat(64) }];
  // A held prerequisite check answered with a value that settles in a macrotask the driver did not start. `wait`: the
  // scenario waits for it outside any step (it lands between steps); otherwise the next steps run at once (it lands in
  // one of their drains, or between them).
  const viaForeign = (label, settle, { wait }) => ({
    name: `prerequisites answered through ${label}`,
    async run(d) {
      d.build(createManagedTaskScheduler, { options: { verifyTaskPrerequisites: () => true }, ports: { verifyTaskPrerequisites: { mode: 'hold' } } });
      await d.step(d.call('initialize'));
      await d.step(d.call('submit', taskInput('late', { taskPrerequisites: PRE })));
      const [held] = d.pending('verifyTaskPrerequisites');
      const value = settle();
      await d.step(d.answer(held, value));
      if (wait) await value;
      for (let index = 0; index < 4; index += 1) await d.step(d.call('listTasks'));
    },
  });
  const viaFs = () => fsp.readFile(new URL(import.meta.url)).then(() => true);
  const viaCaptured = () => new Promise((resolve) => { capturedSetTimeout(() => resolve(true), 0); });
  const viaCapturedLate = () => new Promise((resolve) => { capturedSetTimeout(() => resolve(true), 30); });
  const viaMessage = () => new Promise((resolve) => { const { port1, port2 } = new MessageChannel(); port1.onmessage = () => { port1.close(); port2.close(); resolve(true); }; port2.postMessage(1); });
  const viaMicrotasks = () => new Promise((resolve) => { let count = 0; const spin = () => { count += 1; if (count < 1_000_000) queueMicrotask(spin); else resolve(true); }; queueMicrotask(spin); });
  return {
    'host I/O, waited for': await outcome(viaForeign('host I/O', viaFs, { wait: true })),
    'host I/O': await outcome(viaForeign('host I/O', viaFs, { wait: false })),
    'a captured timer, waited for': await outcome(viaForeign('a captured timer', viaCaptured, { wait: true })),
    'a captured timer': await outcome(viaForeign('a captured timer', viaCaptured, { wait: false })),
    'a captured 30 ms timer': await outcome(viaForeign('a captured 30 ms timer', viaCapturedLate, { wait: false })),
    'a MessageChannel': await outcome(viaForeign('a MessageChannel', viaMessage, { wait: false })),
    'a million microtasks': await outcome(viaForeign('a million microtasks', viaMicrotasks, { wait: false })),
    'real setTimeout': await outcome(viaRealTimer('setTimeout')),
    'real setImmediate': await outcome(viaRealTimer('setImmediate')),
    'drain of one microtask': await (async () => { try { await runScenario(scenarioNamed('F1-fanout-8'), { drain: 'microtasks:1' }); return 'passed'; } catch (error) { return error instanceof DriverCheckError ? error.check : `error: ${error?.message ?? error}`; } })(),
  };
}

/** The boundaries and timer turns of every drain, per mode. */
export const DRAIN_TURNS = Object.freeze({ one: ['1/0'], paranoid: ['17/2'] });
/** What each negative control must be reported by (`passed`: no check). */
export const CONTROL_CHECKS = Object.freeze({
  'host I/O, waited for': 'stray-activity', 'host I/O': 'stray-activity', 'a captured timer, waited for': 'stray-activity', 'a captured timer': 'stray-activity',
  'a captured 30 ms timer': 'stray-activity', 'a MessageChannel': 'stray-activity', 'a million microtasks': 'passed',
  'real setTimeout': 'real-timer', 'real setImmediate': 'real-timer', 'drain of one microtask': 'quiescence-confirmed',
});

export async function quiescenceProbe({ names = null } = {}) {
  const loop = await eventLoopProbes();
  const scenarios = {};
  for (const scenario of SCENARIOS) {
    if (scenario.large || (names && !names.includes(scenario.name))) continue;
    scenarios[scenario.name] = await scenarioProbe(scenario);
  }
  const controls = await negativeControls();
  const problems = [];
  for (const [name, order] of Object.entries(loop)) {
    if (typeof order === 'string' && !order.startsWith('chain < immediate')) problems.push(`event loop: ${name}: ${order}`);
    if (typeof order === 'object' && (order.macrotasksQueued !== 0 || !order.finishedBeforeTheImmediate)) problems.push(`event loop: ${name}: ${JSON.stringify(order)}`);
  }
  for (const [name, result] of Object.entries(scenarios)) {
    if (result.deterministic) problems.push(`${name} is not deterministic: entry ${result.deterministic.index}: ${result.deterministic.left} then ${result.deterministic.right}`);
    if (result.drainEqual) problems.push(`${name} depends on the drain: entry ${result.drainEqual.index}: ${result.drainEqual.left} then ${result.drainEqual.right}`);
    if (JSON.stringify(result.drains) !== JSON.stringify(DRAIN_TURNS)) problems.push(`${name}: the drains took ${JSON.stringify(result.drains)} boundaries/timer turns, not ${JSON.stringify(DRAIN_TURNS)}`);
  }
  const want = CONTROL_CHECKS;
  for (const [name, check] of Object.entries(want)) if (controls[name] !== check) problems.push(`negative control "${name}" gave ${controls[name]}, not ${check}`);
  return { runtime: typeof Bun === 'undefined' ? `node ${process.version}` : `bun ${Bun.version}`, loop, scenarios, controls, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const option = process.argv.slice(2).find((arg) => arg.startsWith('--scenarios='));
  const result = await quiescenceProbe({ names: option ? option.slice('--scenarios='.length).split(',') : null });
  console.log(JSON.stringify(result));
  process.exitCode = result.problems.length ? 1 : 0;
}
