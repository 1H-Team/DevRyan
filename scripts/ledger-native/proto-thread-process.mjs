#!/usr/bin/env node
// The product's ledger worker on a real worker thread, started as the host
// starts it (`new Worker(file, { workerData })`, the stub runtime put in
// inside the thread by proto-thread-bootstrap.mjs beside this file) and
// driven through `postMessage`: the true reference for how the worker orders
// what arrives. Lines on stdin become messages posted to the thread, the
// first being `init` (its `workerData` is the thread's); the lines the
// thread encodes become stdout; the thread's own output goes to stderr.
//
//   node proto-thread-process.mjs <lib directory>
//
// Exits 0 when stdin closes (the thread is terminated, not drained), 1 on a
// line that is not a message or an uncaught error in the thread, and with
// the thread's own code when it exits (70 when its runtime refuses init).
import path from 'node:path';
import process from 'node:process';
import { Worker } from 'node:worker_threads';
import { decodeLine, lineReader } from '../ledger-dual-run/dual-run-codec.mjs';

const libDirectory = path.resolve(process.argv[2] ?? '');
const writeProtocol = process.stdout.write.bind(process.stdout);
let worker = null;
const onLine = (line) => {
  const message = decodeLine(line);
  if (worker) { worker.postMessage(message); return; }
  if (message?.type !== 'init') throw new Error('proto-thread-process: the first message must be init');
  worker = new Worker(new URL('./proto-thread-bootstrap.mjs', import.meta.url), {
    workerData: message.workerData ?? {}, argv: [libDirectory], stdout: true, stderr: true,
  });
  worker.stdout.pipe(process.stderr);
  worker.stderr.pipe(process.stderr);
  worker.on('message', (line) => writeProtocol(line));
  worker.on('error', (error) => { console.error(error); process.exit(1); });
  worker.on('exit', (code) => process.exit(code));
};
process.stdin.on('data', lineReader(onLine));
process.stdin.on('end', () => process.exit(0));
