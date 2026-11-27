#!/usr/bin/env node
// Codec vectors for the scheduler's errors (design file 30 §4.2): the shared
// codec of scripts/client-conformance must write a ManagedOrchestrationError
// and a DOMException with name, message and code, and read each back to an
// error that re-encodes to the same bytes. Each vector pins the exact text,
// so a codec change that drops a field fails here, in Node and in Bun.
//
//   node scripts/scheduler-conformance/vectors.mjs --check     (also: bun scripts/scheduler-conformance/vectors.mjs --check)
// Exit 0 when every vector holds, 1 otherwise, 64 on any other argument.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCodecContext, decodeSlots, emitSlots, encodeText, decode, parseTree, snapshot, stringifyTree } from '../client-conformance/codec.mjs';
import { ManagedOrchestrationError } from '../../packages/orchestration-runtime/scheduler.js';

const error = (code, message) => new ManagedOrchestrationError(code, message);
const orchestration = (code, message) => `{"$dr":"class","name":"ManagedOrchestrationError","error":{"name":"ManagedOrchestrationError","message":${JSON.stringify(message)}},"value":{"name":"ManagedOrchestrationError","code":${JSON.stringify(code)}}}`;
const dom = (name, message, code) => `{"$dr":"class","name":"DOMException","error":{"name":${JSON.stringify(name)},"message":${JSON.stringify(message)},"code":${code}},"value":{}}`;

/** Each vector: a value, its exact text, and what the decoded value must still say. */
export const VECTORS = Object.freeze([
  { name: 'orchestration error', make: () => error('handoff_in_progress', 'An agent handoff is in progress'), text: orchestration('handoff_in_progress', 'An agent handoff is in progress'), expect: { name: 'ManagedOrchestrationError', message: 'An agent handoff is in progress', code: 'handoff_in_progress' } },
  { name: 'orchestration error, empty message', make: () => error('task_not_found', ''), text: orchestration('task_not_found', ''), expect: { name: 'ManagedOrchestrationError', message: '', code: 'task_not_found' } },
  { name: 'orchestration error, another code', make: () => error('ledger_capacity_exceeded', 'cannot fit'), text: orchestration('ledger_capacity_exceeded', 'cannot fit'), expect: { name: 'ManagedOrchestrationError', message: 'cannot fit', code: 'ledger_capacity_exceeded' } },
  { name: 'AbortError', make: () => new DOMException('stopped by user', 'AbortError'), text: dom('AbortError', 'stopped by user', 20), expect: { name: 'AbortError', message: 'stopped by user', code: 20 } },
  { name: 'TimeoutError', make: () => new DOMException('late', 'TimeoutError'), text: dom('TimeoutError', 'late', 23), expect: { name: 'TimeoutError', message: 'late', code: 23 } },
  { name: 'NotFoundError', make: () => new DOMException('gone', 'NotFoundError'), text: dom('NotFoundError', 'gone', 8), expect: { name: 'NotFoundError', message: 'gone', code: 8 } },
  { name: 'DOMException without a legacy code', make: () => new DOMException('plain'), text: dom('Error', 'plain', 0), expect: { name: 'Error', message: 'plain', code: 0 } },
  { name: 'signal aborted with an orchestration error', make: () => AbortSignal.abort(error('managed_runtime_restarting', 'restarting')), text: `{"$dr":"abortsignal","aborted":true,"reason":${orchestration('managed_runtime_restarting', 'restarting')}}`, expect: null },
]);

/** Two slots of one scope: the same error thrown twice is one object (`id` then `id` with the same n). */
const SCOPE = Object.freeze({
  make: () => { const shared = error('operator_stop_pending', 'pending'); return [shared, { cause: shared }, new DOMException('x', 'AbortError')]; },
  texts: [
    `{"$dr":"id","n":1,"value":${orchestration('operator_stop_pending', 'pending')}}`,
    `{"cause":{"$dr":"id","n":1,"value":${orchestration('operator_stop_pending', 'pending')}}}`,
    dom('AbortError', 'x', 20),
  ],
});

/** Every vector that does not hold, as `{ vector, detail }`. */
export function checkVectors() {
  const failures = [];
  for (const vector of VECTORS) {
    const text = encodeText(vector.make());
    if (text !== vector.text) { failures.push({ vector: vector.name, detail: `encodes as ${text}` }); continue; }
    const back = decode(parseTree(text));
    const again = encodeText(back);
    if (again !== text) failures.push({ vector: vector.name, detail: `decodes to a value that encodes as ${again}` });
    if (vector.expect) {
      if (!(back instanceof Error)) failures.push({ vector: vector.name, detail: 'decodes to a value that is not an Error' });
      for (const [key, value] of Object.entries(vector.expect)) if (back[key] !== value) failures.push({ vector: vector.name, detail: `decoded ${key} is ${JSON.stringify(back[key])}, not ${JSON.stringify(value)}` });
    }
  }
  const context = createCodecContext();
  const trees = emitSlots(SCOPE.make().map((value) => snapshot(value, context)));
  const texts = trees.map((tree) => stringifyTree(tree));
  texts.forEach((text, index) => { if (text !== SCOPE.texts[index]) failures.push({ vector: `scope slot ${index + 1}`, detail: `encodes as ${text}` }); });
  // Every slot decodes alone; the shared context carries the identity, so the slots re-emit with the same numbers.
  const scope = createCodecContext();
  const decoded = decodeSlots(SCOPE.texts.map(parseTree), scope);
  if (decoded[0].code !== 'operator_stop_pending' || decoded[1].cause.code !== 'operator_stop_pending') failures.push({ vector: 'scope decode', detail: 'the shared error lost its code' });
  const again = emitSlots(decoded.map((value) => snapshot(value, scope))).map((tree) => stringifyTree(tree));
  again.forEach((text, index) => { if (text !== SCOPE.texts[index]) failures.push({ vector: `scope slot ${index + 1} round trip`, detail: `re-encodes as ${text}` }); });
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== '--check') { console.error('usage: vectors.mjs --check'); process.exitCode = 64; } else {
    const failures = checkVectors();
    for (const failure of failures) console.error(`vector ${failure.vector}: ${failure.detail}`);
    console.log(failures.length ? `${failures.length} vectors fail` : `${VECTORS.length} vectors and one identity scope of 3 slots hold`);
    process.exitCode = failures.length ? 1 : 0;
  }
}
