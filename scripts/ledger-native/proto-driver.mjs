// Drives one ledger process over its stdio protocol from a scripted host
// transcript, and normalizes what it said for comparison. The ledger is
// either the product's worker as a process (JavaScript) or devryan-ledger
// (Rust); the driver treats both the same.
//
// A transcript is `{ name, init, steps, answer?, exit? }`:
//   init       the workerData of `init` (or `{ line }` for raw text first)
//   steps      { send }      a message, encoded as the host encodes it
//              { raw }       text (or a Buffer) written as it is
//              { await, label }  wait for a message matching `await(message)` that no
//                            earlier await claimed
//              { answer, value | error }  answer a deferred callback (by its label)
//              { close: true }  close stdin
//              { signal }   send a signal
//   answer     (callback, deferred) => { value } | { error } | { defer: label } | { raw }
//              how the host answers each `callback` (default: its arguments back)
//
// As the host does, the driver waits for the handshake's outcome (the first
// message, or the ledger's exit) before it runs the steps: a ledger that
// sees stdin close ends at once, and a line it has not started yet, `init`
// included, never runs.
import { spawn } from 'node:child_process';
import { decodeLine, encodeLine, lineReader } from '../ledger-dual-run/dual-run-codec.mjs';

const AWAIT_MS = 30_000;

/** Runs a transcript against `{ command, args, env }`: `{ messages, raw, exit, stderr, closedAt }`. */
export function runTranscript(arm, transcript) {
  return new Promise((resolve, reject) => {
    const child = spawn(arm.command, arm.args, { env: arm.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const messages = [], raw = [];
    let stderr = '', waiting = null, closedAt = null, failed = false;
    // Each await claims the first unclaimed message it matches, wherever it is.
    const claimed = new Set();
    const deferred = new Map();
    const fail = (error) => { if (failed) return; failed = true; try { child.kill('SIGKILL'); } catch { /* gone */ } reject(error); };
    const write = (text) => { if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(text); };
    const send = (message) => write(encodeLine(message));
    const answerCallback = (message) => {
      const answer = transcript.answer ? transcript.answer(message) : { value: ['answer', ...(message.args ?? [])] };
      if (answer?.defer) { deferred.set(answer.defer, message); return; }
      reply(message, answer);
    };
    const reply = (message, answer) => {
      if (answer.raw !== undefined) { write(answer.raw); return; }
      send(answer.error !== undefined ? { type: 'callback-result', id: message.id, failed: answer.failed ?? true, error: answer.error }
        : { type: 'callback-result', id: message.id, failed: answer.failed ?? false, value: answer.value });
    };
    const check = () => {
      if (!waiting) return;
      for (let index = 0; index < messages.length; index++) {
        if (!claimed.has(index) && waiting.match(messages[index])) { claimed.add(index); const done = waiting.done; waiting = null; done(); return; }
      }
    };
    child.stdout.on('data', lineReader((line) => {
      let parsed;
      try { parsed = JSON.parse(line); } catch { fail(new Error(`${transcript.name}: a line that is not JSON: ${line.slice(0, 200)}`)); return; }
      raw.push({ message: parsed, afterClose: closedAt !== null });
      const message = decodeLine(line);
      messages.push(message);
      if (message?.type === 'callback') answerCallback(message);
      check();
    }));
    child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 65_536) stderr = stderr.slice(-65_536); });
    child.on('error', fail);
    // Writing to a ledger that already exited is part of some transcripts.
    child.stdin.on('error', () => {});
    const exited = new Promise((done) => child.on('close', (code, signal) => done({ code, signal })));
    const awaitMessage = (match, label) => new Promise((done, timeout) => {
      const timer = setTimeout(() => timeout(new Error(`${transcript.name}: no message for ${label ?? match} within ${AWAIT_MS} ms`)), AWAIT_MS);
      waiting = { match, done: () => { clearTimeout(timer); done(); } };
      check();
    });
    (async () => {
      if (transcript.init?.line !== undefined) write(transcript.init.line);
      else send({ type: 'init', ...(transcript.protocol === undefined ? {} : { protocol: transcript.protocol }), workerData: transcript.init ?? { directory: '/tmp/ledger-native-conformance', observers: {} } });
      let gone = false;
      exited.then(() => { gone = true; });
      await new Promise((done) => { const first = () => (messages.length || gone ? done() : setTimeout(first, 5)); first(); });
      for (const step of transcript.steps ?? []) {
        if (step.send !== undefined) send(typeof step.send === 'function' ? step.send() : step.send);
        else if (step.raw !== undefined) write(step.raw);
        else if (step.await) await Promise.race([awaitMessage(step.await, step.label), exited.then(() => { throw new Error(`${transcript.name}: the ledger exited while waiting for ${step.label}`); })]);
        else if (step.answer !== undefined) {
          const message = deferred.get(step.answer);
          if (!message) throw new Error(`${transcript.name}: no deferred callback ${step.answer}`);
          deferred.delete(step.answer);
          reply(message, step);
        } else if (step.close) { closedAt = raw.length; child.stdin.end(); }
        else if (step.signal) child.kill(step.signal);
        else if (step.pause) await new Promise((done) => setTimeout(done, step.pause));
      }
      if (closedAt === null) { closedAt = raw.length; child.stdin.end(); }
      const timer = setTimeout(() => fail(new Error(`${transcript.name}: the ledger did not exit after stdin closed`)), AWAIT_MS);
      const exit = await exited;
      clearTimeout(timer);
      if (!failed) resolve({ messages, raw: raw.map((entry) => entry.message), afterClose: raw.filter((entry) => entry.afterClose).map((entry) => entry.message), exit, stderr, closedAt });
    })().catch(fail);
  });
}

const DURATION_KEYS = new Set(['elapsedMs']);

/** A message with what legitimately differs masked: stacks, durations, stall times. */
export function normalizeMessage(message) {
  const visit = (value, key) => {
    if (Array.isArray(value)) return value.map((item) => visit(item));
    if (value === null || typeof value !== 'object') {
      if (DURATION_KEYS.has(key) && typeof value === 'number') return '#';
      if (key === 'steps' && typeof value === 'string') return value.replace(/\/[^,]*/g, '/#');
      return value;
    }
    const out = {};
    for (const [entryKey, entry] of Object.entries(value)) {
      if (entryKey === 'stack' && value.__devryanError === true) continue;
      out[entryKey] = visit(entry, entryKey);
    }
    return out;
  };
  const normalized = visit(message);
  if (normalized?.type === 'ready') return { type: 'ready', methods: normalized.methods };
  if (normalized?.type === 'observe' && normalized.observer === 'onWorkerStall') {
    return { ...normalized, payload: Object.fromEntries(Object.keys(normalized.payload ?? {}).map((key) => [key, typeof normalized.payload[key]])) };
  }
  return normalized;
}

const key = (value) => JSON.stringify(value === undefined ? { $dr: 'undefined' } : value);

/**
 * The comparable shape of a run (raw JSON messages, tags not decoded):
 *   ready       the first message
 *   calls       per call id: every message about it in order, progress apart
 *   progress    per call id: the sequence of `waiting` states, repeats collapsed
 *   streams     per stream id: its chunks in order
 *   background  observations and callbacks of no call, sorted (a multiset)
 *   stalls      whether any onWorkerStall observation came (their number
 *               follows the machine's load)
 *   exit        how the process ended
 */
export function shapeOf(run, { exitClass = (exit) => exit } = {}) {
  const calls = new Map(), progress = new Map(), streams = new Map(), background = [];
  let stalls = 0;
  // Messages are kept as their JSON text, so key order is compared too.
  const into = (map, id, message) => { const name = key(id); if (!map.has(name)) map.set(name, []); map.get(name).push(JSON.stringify(message)); };
  const isUndefined = (value) => value === undefined || (value && value.$dr === 'undefined');
  const [first, ...rest] = run.raw.map(normalizeMessage);
  for (const message of rest) {
    switch (message?.type) {
      case 'result': case 'report': into(calls, message.id, message); break;
      case 'progress': {
        const states = progress.get(key(message.id)) ?? [];
        if (states.at(-1) !== message.waiting) states.push(message.waiting);
        progress.set(key(message.id), states);
        break;
      }
      case 'callback': {
        const cause = message.target?.call !== undefined && !isUndefined(message.target.call) ? message.target.call : message.target?.cause;
        if (isUndefined(cause)) background.push(JSON.stringify(message)); else into(calls, cause, message);
        break;
      }
      case 'observe':
        if (message.observer === 'onWorkerStall') { stalls += 1; break; }
        if (isUndefined(message.cause)) background.push(JSON.stringify(message)); else into(calls, message.cause, message);
        break;
      case 'chunk': into(streams, message.stream, message); break;
      default: background.push(JSON.stringify(message));
    }
  }
  return {
    ready: JSON.stringify(first),
    calls: Object.fromEntries([...calls].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    progress: Object.fromEntries([...progress].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    streams: Object.fromEntries([...streams].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    background: background.sort(),
    stalls: stalls > 0,
    exit: exitClass(run.exit),
  };
}

/** Each call's last `progress` precedes its `result` (the final forward of a settling call). */
export function progressPrecedesResults(run) {
  const lastProgress = new Map(), results = new Map();
  run.raw.forEach((message, index) => {
    if (message?.type === 'progress') lastProgress.set(key(message.id), index);
    if (message?.type === 'result') results.set(key(message.id), index);
  });
  return [...lastProgress].filter(([id, index]) => results.has(id) && index > results.get(id)).map(([id]) => id);
}
