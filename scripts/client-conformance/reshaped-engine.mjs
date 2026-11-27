// The reshaped engine (package C0g): a second engine behind the protocol of
// engine.mjs, deliberately unlike the TypeScript one in everything the
// candidate rules leave free and in nothing else, to show that the comparer
// does not depend on the TypeScript engine's own shape. It runs the
// TypeScript engine as its own child, forwards every request to it unchanged,
// and gives back every `end` answer reshaped (reshape.mjs: clock reads
// dropped, a settled answer opened at its group's end, identity numbers,
// call numbers and timer ids renamed, protocol members reversed).
// With a mode `outside-*` it is one of the planted engines that differ just
// outside a freedom (reshape.mjs OUTSIDE); a case the plant has no place in is
// answered reshaped. With `not-ported:<family>` (package C0i) it refuses that
// family as one it does not implement (`notPorted`), as a Rust runner does,
// and answers every other family reshaped.
//
//   node reshaped-engine.mjs [reshaped | outside-<name> | not-ported:<family> | not-ported-file-units | not-ported-first-unit]     (the working directory is the TypeScript engine's)
//
// It learns what it needs from the requests themselves (each step's input
// kind and arrival, `hold`, the inputs nested in its port calls, the env
// lists) and the groups from the TypeScript engine's answer, never from a
// recording. Its child stays in its process group (the replayer starts
// every engine in a group of its own), so a replayer that stops it (SIGKILL to
// the group) stops the TypeScript engine with it.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { expandStrings, protocolLine, typescriptEngine } from './engine.mjs';
import { plantedAnswer, stepsOfMessage } from './reshape.mjs';

const given = process.argv[2] ?? 'reshaped';
const refused = given.startsWith('not-ported:') ? given.slice('not-ported:'.length) : null;
// The C0i review's wrong engine (its B1): it implements every family, says so, and refuses some units of each as not
// ported: `not-ported-file-units` the first open after an open of another family (each container's file-order unit,
// where module history is), `not-ported-first-unit` the first open of each family. Both must be inconclusive.
const halfRefusing = given === 'not-ported-file-units' || given === 'not-ported-first-unit' ? given : null;
const mode = refused === null && halfRefusing === null ? given : 'reshaped';
const opened = new Set();
let lastFamily = null;
const refuseHalf = (name) => {
  const refuse = halfRefusing === 'not-ported-file-units' ? name !== lastFamily : !opened.has(name);
  opened.add(name);
  lastFamily = name;
  return refuse;
};
const inner = typescriptEngine({ cwd: process.cwd() });
const child = spawn(inner.command, inner.args, { cwd: inner.cwd, env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
const write = (message) => process.stdout.write(`${protocolLine(message)}\n`);

const asked = new Map(); // request id -> { op, unit }
const cases = new Map(); // unit -> { steps, nows, strings }
let stopping = false;

// The TypeScript engine ending before it was told to stop is this engine's failure: the replayer sees it exit.
child.on('close', () => { process.stdout.write('', () => process.exit(stopping ? 0 : 1)); });
child.stdin.on('error', () => {});

createInterface({ input: child.stdout }).on('line', (line) => {
  if (!/\S/.test(line)) return;
  let message;
  try { message = JSON.parse(line); } catch { process.stdout.write(`${line}\n`); return; }
  const request = asked.get(message.id);
  asked.delete(message.id);
  if (request?.op === 'hello' && message.ok) { write({ ...message, engine: `reshaped(${given}) of ${message.engine}` }); return; }
  if (request?.op === 'end' && message.ok && message.replayed) {
    const kase = cases.get(request.unit) ?? { steps: [], nows: [], strings: [] };
    cases.delete(request.unit);
    const strings = Array.isArray(message.replayed.strings) ? message.replayed.strings : [];
    const { strings: _strings, ...rest } = message.replayed;
    const replayed = expandStrings(rest, strings);
    const context = { steps: kase.steps.map((step) => ({ ...step, env: expandStrings(step.env, kase.strings) })), nows: kase.nows };
    const answer = plantedAnswer(mode, replayed, context) ?? (mode === 'reshaped' ? replayed : plantedAnswer('reshaped', replayed, context));
    write({ ...message, replayed: answer });
    return;
  }
  write(message);
});

for await (const line of createInterface({ input: process.stdin })) {
  if (!/\S/.test(line)) continue;
  let message;
  try { message = JSON.parse(line); } catch { child.stdin.write(`${line}\n`); continue; }
  // A family it does not implement: refused at open, never forwarded (the replayer sends nothing more for that unit).
  if (refused !== null && message.op === 'open' && message.family?.name === refused) { write({ id: message.id, ok: false, notPorted: true, error: `family ${refused} is not implemented by this engine` }); continue; }
  if (halfRefusing !== null && message.op === 'open' && refuseHalf(message.family?.name)) { write({ id: message.id, ok: false, notPorted: true, error: `planted (${halfRefusing}): this unit of ${message.family?.name} refused` }); continue; }
  asked.set(message.id, { op: message.op, unit: message.unit });
  if (message.op === 'case') cases.set(message.unit, { steps: [], nows: [], strings: [] });
  if (message.op === 'seed') cases.get(message.unit)?.strings.push(...(message.strings ?? []));
  if (message.op === 'step') {
    const kase = cases.get(message.unit);
    if (kase) {
      kase.strings.push(...(message.step.strings ?? []));
      kase.steps.push(...stepsOfMessage(message.step));
      const nowsOf = (step) => [step?.input?.now, ...(Array.isArray(step?.during) ? step.during.flatMap((item) => nowsOf(item.step)) : [])];
      kase.nows.push(...nowsOf(message.step));
    }
  }
  if (message.op === 'stop') stopping = true;
  child.stdin.write(`${protocolLine(message)}\n`);
}
child.stdin.end();
