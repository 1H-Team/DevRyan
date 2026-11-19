#!/usr/bin/env node
// The JavaScript arm of the protocol's virtual-time differential test: the
// product's ledger worker (the stub runtime put in by a module hook, as in
// proto-js-process.mjs) on Node's own timers under a virtual clock
// (node-virtual-clock.mjs), driven by a timed host script. Its Rust twin is
// `ledger-native-probe transcript`, which runs the protocol on the event
// loop the binary ships under the same clock; both follow this driver:
//
//   for each step {at, send}: run the clock to `at`, then deliver `send` as
//   one message; after every message and every instant, answer each
//   callback the worker sent with `['answer', ...args]`, one message per
//   answer, at the same instant; at the end run the clock to `until`.
//
//   node --expose-internals proto-virtual-js-arm.mjs <lib directory> < transcript (one tagged JSON line)
//   stdout: `<ms since the start>\t<line>` per message the worker sent
import * as nodeModule from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { decodeLine, encodeLine } from '../ledger-dual-run/dual-run-codec.mjs';
import { moveTo, resetClock, step, unit } from './node-virtual-clock.mjs';

const EPOCH = 1_000_000;
const libDirectory = path.resolve(process.argv[2] ?? '');
const workerURL = pathToFileURL(path.join(libDirectory, 'session-mutation-worker.js')).href;
const shimURL = new URL('../ledger-dual-run/worker-threads-shim.mjs', import.meta.url).href;
const stubURL = new URL('./proto-stub-runtime.mjs', import.meta.url).href;
nodeModule.registerHooks({ resolve: (specifier, context, next) => {
  if (context.parentURL === workerURL && (specifier === 'node:worker_threads' || specifier === 'worker_threads')) return { url: shimURL, shortCircuit: true };
  if (context.parentURL === workerURL && specifier === './session-mutations.js') return { url: stubURL, shortCircuit: true };
  return next(specifier, context);
} });

let input = '';
for await (const chunk of process.stdin) input += chunk;
const transcript = decodeLine(input.trim());
resetClock(EPOCH);

const out = [], answers = [], listeners = [];
const port = {
  postMessage(message) {
    out.push(`${Date.now() - EPOCH}\t${encodeLine(message).trimEnd()}`);
    if (message?.type === 'callback') answers.push(message);
  },
  on(event, listener) { if (event === 'message') listeners.push(listener); return port; },
};
// One message as a MessagePort delivers it: a structured clone of what the line decodes to.
const deliver = (message) => unit(() => { const cloned = structuredClone(decodeLine(encodeLine(message))); for (const listener of listeners) listener(cloned); });
const answerAll = async () => {
  while (answers.length) {
    const callback = answers.shift();
    await deliver({ type: 'callback-result', id: callback.id, failed: false, value: ['answer', ...(callback.args ?? [])] });
  }
};
const runTo = async (target) => {
  for (;;) {
    await answerAll();
    if (!(await step(target))) break;
  }
  moveTo(target);
  await answerAll();
};

globalThis.__ledgerDualRunPort = { parentPort: port, workerData: transcript.init ?? {} };
await unit(() => {});
await import(workerURL);
for (const { at, send } of transcript.steps ?? []) {
  await runTo(EPOCH + at);
  await deliver(send);
  await answerAll();
}
await runTo(EPOCH + (transcript.until ?? 0));
process.stdout.write(`${out.join('\n')}\n`);
