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
// answered reshaped.
//
//   node reshaped-engine.mjs [reshaped | outside-<name>]     (the working directory is the TypeScript engine's)
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

const mode = process.argv[2] ?? 'reshaped';
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
  if (request?.op === 'hello' && message.ok) { write({ ...message, engine: `reshaped(${mode}) of ${message.engine}` }); return; }
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
