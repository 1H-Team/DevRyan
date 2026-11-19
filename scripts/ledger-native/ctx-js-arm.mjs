#!/usr/bin/env node
// The JavaScript arm of the execution-context differential tests: runs
// scenarios (ctx-scenarios.mjs) on the product's execution-admission.js,
// execution-io-pool.js and host-stall-clock.js under a virtual clock that
// drives Node's own timers (node-virtual-clock.mjs), against the Rust
// probe's virtual clock, which drives the event loop the binary ships.
//
//   node --expose-internals ctx-js-arm.mjs < scenarios (one tagged JSON line, an array)
//   stdout: one line per scenario, { name, events }
import process from 'node:process';
import { decodeLine, encodeLine } from '../ledger-dual-run/dual-run-codec.mjs';
import { advanceTo, resetClock } from './node-virtual-clock.mjs';

const { runInRemoteExecutionContext } = await import('../../packages/harness-runtime/lib/execution-admission.js');
const { createHostStallClock, resetHostStallClock } = await import('../../packages/harness-runtime/lib/host-stall-clock.js');
const { createStubGlobal, run, summarize, value } = await import('./stub-interpreter.mjs');

const setEnv = (entries) => { for (const [name, text] of Object.entries(entries ?? {})) { if (typeof text === 'string') process.env[name] = text; else delete process.env[name]; } };

async function tasksScenario(scenario, events, epoch) {
  const global = createStubGlobal({ observers: {}, events, epoch });
  const push = (entry) => events.push({ t: Date.now() - epoch, ...entry });
  const controllers = new Map();
  let pending = 0;
  for (const action of scenario.timeline ?? []) {
    setTimeout(() => {
      push({ timeline: action });
      if (typeof action.abort === 'string') controllers.get(action.abort)?.abort(value(action.reason, { fns: [], regs: {}, global }));
      for (const key of ['open', 'fail']) if (action[key] !== undefined) run([{ op: key, gate: action[key], value: action.value }], { fns: [], regs: {}, global });
      if (action.env) setEnv(action.env);
    }, action.at);
  }
  for (const task of scenario.tasks ?? []) {
    const controller = new AbortController();
    controllers.set(task.name, controller);
    const env = { fns: [], regs: {}, global, task: task.name };
    pending += 1;
    (async () => {
      const outcome = await runInRemoteExecutionContext(task.context, async () => (await run(task.program ?? [], env)).value, {
        signal: controller.signal,
        onReport: (record) => push({ task: task.name, report: record }),
        onProgress: (state) => push({ task: task.name, progress: state.waiting }),
        progressMs: task.progressMs ?? 250,
      });
      const steps = outcome.steps.map(([phase, step]) => [phase, { count: step.count, elapsedMs: step.elapsedMs }]);
      push({ task: task.name, result: outcome.failed ? { failed: true, error: summarize(outcome.failure), steps } : { failed: false, value: outcome.result, steps } });
      pending -= 1;
    })();
  }
  await advanceTo(epoch + (scenario.until ?? 60_000));
  push({ end: { pending } });
}

function stallScenario(scenario, events) {
  let time = Date.now();
  const options = scenario.options ?? {};
  const clock = createHostStallClock({ now: () => time, onStall: (stall) => events.push({ stall: { from: stall.from, to: stall.to, ms: stall.ms } }), ...options });
  const tick = options.tickMs ?? 250;
  const marks = new Map();
  const at = (reference) => (reference === undefined ? undefined : typeof reference === 'object' && reference !== null
    ? (typeof reference.mark === 'string' ? marks.get(reference.mark) ?? NaN : time) + Number(reference.plus ?? 0) : Number(reference));
  for (const step of scenario.steps ?? []) {
    if (step.run !== undefined) { for (let passed = 0; passed < step.run; passed += tick) { time += tick; clock.tick(); } }
    else if (step.block !== undefined) { time += step.block; clock.tick(); }
    else if (step.advance !== undefined) time += step.advance;
    else if (typeof step.mark === 'string') marks.set(step.mark, time);
    else if (step.env) setEnv(step.env);
    else if (typeof step.query === 'string') {
      const answer = step.query === 'stalledMsBetween' ? clock.stalledMsBetween(at(step.from) ?? NaN, at(step.to))
        : step.query === 'activeMsSince' ? clock.activeMsSince(at(step.since) ?? NaN, at(step.at))
          : step.query === 'expired' ? clock.expired(at(step.since) ?? NaN, Number(step.limit), step.cap === undefined ? undefined : Number(step.cap), at(step.at))
            : step.query === 'snapshot' ? clock.snapshot() : `unknown query ${step.query}`;
      events.push({ query: step.query, answer });
    }
  }
}

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  const saved = { ...process.env };
  for (const scenario of decodeLine(input.trim())) {
    const epoch = scenario.epoch ?? 1_000_000;
    resetHostStallClock();
    resetClock(epoch);
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    setEnv(scenario.env);
    const events = [];
    if (scenario.kind === 'stall') stallScenario(scenario, events);
    else await tasksScenario(scenario, events, epoch);
    process.stdout.write(encodeLine({ name: scenario.name, events }));
  }
});
