// Engines that are wrong on purpose, behind the protocol of engine.mjs (client
// conformance harness, package C0d): the replayer's self-test runs the closure
// against each and requires the exit code it names (replay-mutants.mjs, part
// `engines`). Run by Node: `node fake-engine.mjs <mode> [<recording directory>]`.
//
// Engines that try to pass without running anything (each must end the
// closure with exit 1, a difference):
// - `echo`: answers every step with what it was sent (the arguments as the
//   return value and as the arguments after the call, the env as effects);
// - `lag`: reads the recording directory itself, finds the case by the inputs
//   of its first step, and answers each step with the previous step's
//   recorded outputs;
// - `lookup`: the review's engine (C0d review, B2): reads the recording
//   directory and answers a case with the recorded steps of the case id the
//   `case` request names; protocol 2 names none, so it has nothing to look up.
// Engines that fail (each must end the closure with exit 3, inconclusive):
// - `crash`: answers as `echo` and exits on the third step it is sent;
// - `hang`: never answers a step;
// - `protocol-1`: says it speaks protocol 1.
// Protocol 3 (package C0e): `seed` is answered and, for `echo`, the seeded state
// is echoed as the case's entry and end state; timer, settle and callback
// inputs are echoed like calls. `lookup` answers the pending timers recorded
// for the id too (C0e fix round). Protocol 5 (package C0g fix round): every
// answer is in its shape (steps with their group and positions, the groups'
// effects); `lookup` lays the recorded case out as the comparer does, so with
// the id it would be an exact answer.
// Its subject is the replayer's toy recording only; product code never runs here.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const [mode, directory] = process.argv.slice(2);
const here = path.dirname(new URL(import.meta.url).pathname);
const { expandStrings, PROTOCOL, protocolLine } = await import(pathToFileURL(path.join(here, '..', '..', 'engine.mjs')).href);
const { readContainer, VALUE_REF } = await import(pathToFileURL(path.join(here, '..', '..', 'container.mjs')).href);
const { caseLayout, pendingByGroup } = await import(pathToFileURL(path.join(here, '..', '..', 'replay-compare.mjs')).href);

// The recording, read as an engine that cheats would read it: every case's steps with their values resolved.
const recorded = [];
if (directory) {
  for (const name of readdirSync(directory).filter((file) => file.endsWith('.ndjson'))) {
    const reader = readContainer(readFileSync(path.join(directory, name), 'utf8'));
    const deep = (value) => (typeof value === 'string' && VALUE_REF.test(value) ? reader.resolve(value) : Array.isArray(value) ? value.map(deep) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deep(item)])) : value);
    for (const record of reader.cases) recorded.push({ id: record.id, steps: deep(record.steps), entry: deep(record.entry)?.state ?? undefined, end: deep(record.end)?.state ?? undefined, pending: deep(record.end)?.pending ?? [] });
  }
}
const byId = new Map(recorded.map((item) => [item.id, item.steps]));
// A protocol-5 answer: steps laid out in groups as the comparer lays out a recording (replay-compare.mjs caseLayout).
const asProtocol5 = (steps) => {
  const layout = caseLayout(steps);
  return {
    steps: steps.map(({ effects: _effects, returnedAt: _returnedAt, ...rest }, index) => ({ ...rest, group: layout.groupOf[index] + 1, openedAt: layout.openedAt[index], ...(layout.returnedAt[index] !== undefined ? { returnedAt: layout.returnedAt[index] } : {}) })),
    groups: layout.sequences.map((effects) => ({ effects })),
  };
};
const statesById = new Map(recorded.map((item) => [item.id, { entry: item.entry ?? undefined, end: item.end ?? undefined }]));
const pendingById = new Map(recorded.map((item) => [item.id, pendingByGroup(item.pending, item.steps)]));
const keyOf = (input) => JSON.stringify([input.entry, input.args]);
const byFirstInput = new Map();
for (const item of recorded) if (item.steps[0] && !byFirstInput.has(keyOf(item.steps[0].input))) byFirstInput.set(keyOf(item.steps[0].input), item.steps);

const open = new Map(); // unit -> the open case { asked, steps, strings }
const write = (message) => process.stdout.write(`${protocolLine(message)}\n`);
let stepsSeen = 0;
const echoed = (step, index) => ({ n: index + 1, input: step.input, effects: step.env.map((item, at) => (item.kind === 'port' ? { kind: 'port', port: item.port, call: at + 1, args: [], ...(Object.hasOwn(item, 'throws') ? { throws: item.throws } : { answer: item.answer }) } : { kind: item.kind, source: item.source, value: item.value })), returns: step.input.args, after: step.input.args });

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  const { id, op, unit } = message;
  if (op === 'hello') { write({ id, ok: true, engine: `fake-${mode}`, protocol: mode === 'protocol-1' ? 1 : PROTOCOL }); continue; }
  if (op === 'stop') { write({ id, ok: true }); process.exit(0); }
  if (op === 'open') { write({ id, ok: true, exports: [] }); continue; }
  // The review's lookup: by the id the request names (`message.case`, which protocol 2 never sends).
  if (op === 'case') { open.set(unit, { asked: message.case, steps: [], strings: [], seeded: undefined }); write({ id, ok: true, between: [] }); continue; }
  if (op === 'seed') { const kase = open.get(unit); for (const text of message.strings ?? []) kase.strings.push(text); kase.seeded = expandStrings(message.state, kase.strings); write({ id, ok: true, seeded: true }); continue; }
  if (op === 'step') {
    stepsSeen += 1;
    if (mode === 'hang') continue;
    if (mode === 'crash' && stepsSeen === 3) process.exit(7);
    const kase = open.get(unit);
    for (const text of message.step.strings ?? []) kase.strings.push(text);
    kase.steps.push({ input: expandStrings(message.step.input, kase.strings), env: expandStrings(message.step.env, kase.strings) });
    write({ id, ok: true, halted: null });
    continue;
  }
  if (op === 'end') {
    const kase = open.get(unit);
    open.delete(unit);
    let steps;
    if (mode === 'lookup') steps = byId.get(kase.asked);
    else if (mode === 'lag') {
      const found = kase.steps.length ? byFirstInput.get(keyOf(kase.steps[0].input)) : undefined;
      steps = found ? kase.steps.map((step, index) => (index === 0 ? { n: 1, input: step.input, effects: [], returns: { $dr: 'undefined' } } : { ...found[index - 1], n: index + 1, input: step.input })) : [];
    } else steps = kase.steps.map(echoed);
    // `echo` echoes a seed as both states; `lookup` answers with the states recorded for the id it was told.
    const looked = mode === 'lookup' ? statesById.get(kase.asked) : undefined;
    const states = mode === 'echo' && kase.seeded !== undefined ? { entry: kase.seeded, end: kase.seeded } : looked ? Object.fromEntries(Object.entries(looked).filter(([, value]) => value !== undefined && value !== null)) : {};
    // `lookup` also answers the timers recorded as pending at the end (C0e fix round); the others report none.
    const pending = mode === 'lookup' ? (pendingById.get(kase.asked) ?? []) : [];
    write({ id, ok: true, replayed: { ...asProtocol5(steps ?? []), ...states, pending, strings: [], halt: null, outside: [], bindFailures: [] } });
    continue;
  }
  if (op === 'close') { write({ id, ok: true, between: [] }); continue; }
  write({ id, ok: false, error: `unknown request ${op}` });
}
