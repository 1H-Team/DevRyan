// The reviewed facts of the scripted scenarios (design file 30, package O0b).
// Every scenario of scenarios.mjs states, in its own entry (`facts`), what
// makes it what it is, read from the scheduler: the steps and the virtual
// time of each, the inputs of every group in delivery order, which step each
// port call and each port answer belongs to, the launches in order with the
// saves before each, every timer with its delay, set time and fire time, how
// every member call ended, the final status of every task and, after a crash
// point, which save the fresh instance loads. This file computes the same
// facts from a run (`scenarioFacts`, from the driver) and from a recording
// (`traceFacts`, the keys a trace holds), and compares them exactly with what
// the scenario states. A scenario that states no facts fails; a changed fact
// is printed with the first difference. The facts change only by review, as
// the toy's golden.json does.
//
//   bun scripts/scheduler-conformance/scenario-facts.mjs [--scenarios=<name,...>]   (one JSON line; exit 1 on a difference)
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EPOCH } from './trace.mjs';

/** Every scenario states these; `restart` too after a crash point. */
export const FACT_KEYS = Object.freeze(['steps', 'clock', 'groups', 'ports', 'answers', 'launches', 'timers', 'outcomes', 'final']);
/** The keys a recorded trace gives (driver.test.mjs compares them with the same statement). */
export const TRACE_FACT_KEYS = Object.freeze(['steps', 'clock', 'groups', 'launches']);
const LAUNCH = new Set(['executor.start', 'executor.resume', 'executor.retryInPlace']);

/** Step numbers (with repeats, ascending) as text: `3 5-9 12x4` (12 four times). */
export function stepList(steps) {
  const counted = [];
  for (const step of steps) {
    const last = counted[counted.length - 1];
    if (last && last[0] === step) last[1] += 1; else counted.push([step, 1]);
  }
  const parts = [];
  for (let index = 0; index < counted.length;) {
    const [step, count] = counted[index];
    if (count > 1) { parts.push(`${step}x${count}`); index += 1; continue; }
    let end = index;
    while (end + 1 < counted.length && counted[end + 1][1] === 1 && counted[end + 1][0] === counted[end][0] + 1) end += 1;
    parts.push(end > index ? `${step}-${counted[end][0]}` : `${step}`);
    index = end + 1;
  }
  return parts.join(' ');
}

/** A list of strings with runs compressed: equal neighbours `text x3`, numbered neighbours `name#1..8 rest` and `name-1..8`. */
export function runs(items) {
  const out = [];
  const numbered = (text) => /^(.*?[#-])(\d+)(\D.*)?$/.exec(text);
  for (let index = 0; index < items.length;) {
    let end = index;
    while (end + 1 < items.length && items[end + 1] === items[index]) end += 1;
    if (end > index) { out.push(`${items[index]} x${end - index + 1}`); index = end + 1; continue; }
    const first = numbered(items[index]);
    if (first) {
      while (end + 1 < items.length) {
        const next = numbered(items[end + 1]);
        if (!next || next[1] !== first[1] || (next[3] ?? '') !== (first[3] ?? '') || Number(next[2]) !== Number(first[2]) + (end + 1 - index)) break;
        end += 1;
      }
      if (end > index) { out.push(`${first[1]}${first[2]}..${Number(first[2]) + end - index}${first[3] ?? ''}`); index = end + 1; continue; }
    }
    out.push(items[index]);
    index += 1;
  }
  return out;
}

/** Each distinct text with its count, in order of first occurrence: `{ "<text>": n }`. */
const counted = (items) => { const out = {}; for (const item of items) out[item] = (out[item] ?? 0) + 1; return out; };
/** Labels in natural order: `fan-2` before `fan-10`. */
const byLabel = (a, b) => a.localeCompare(b, 'en', { numeric: true });
const valueText = (value) => (value && typeof value === 'object' ? value.status ?? '<object>' : value === null || value === undefined ? '' : String(value));

/** The facts of one run of a scenario, from its driver (its log, its instances). */
export function scenarioFacts(d) {
  let step = 0;
  let now = 0;
  const clock = [];
  const groups = [];
  const ports = new Map();
  const answers = new Map();
  const names = new Map(); // driver port seq -> `name`
  const launches = [];
  const timers = new Map(); // `i<instance>#<id>` -> text parts
  const calls = new Map(); // handle id -> { member, end }
  let saves = 0;
  const inst = (number) => (number > 1 ? `i${number} ` : '');
  for (const entry of d.log) {
    const [kind] = entry;
    if (kind === 'step') {
      [, step, now] = entry;
      const last = clock[clock.length - 1];
      if (last && last.now === now) last.to = step; else clock.push({ now, from: step, to: step });
      if (entry[3].length > 1) groups.push(`${step}: ${runs(entry[3]).join(', ')}`);
    } else if (kind === 'port') {
      const [, instance, seq, name, brief] = entry;
      names.set(seq, name);
      const key = `${inst(instance)}${name}`;
      ports.set(key, [...(ports.get(key) ?? []), step]);
      if (name === 'persistence.save') saves += 1;
      if (LAUNCH.has(name)) launches.push(`${inst(instance)}${name === 'executor.start' ? '' : `${name.slice('executor.'.length)} `}${brief?.label ?? '?'} @${step} after ${saves}`);
    } else if (kind === 'answer') {
      const [, instance, seq, outcome] = entry;
      const key = `${inst(instance)}${names.get(seq)}`;
      answers.set(key, [...(answers.get(key) ?? []), outcome === 'reject' ? `${step}!` : step]);
    } else if (kind === 'timer.set') {
      const [, instance, id, delay] = entry;
      timers.set(`${instance}#${id}`, `${inst(instance)}${delay} at +${now} `);
    } else if (kind === 'fire') {
      const [, instance, id, at] = entry;
      timers.set(`${instance}#${id}`, `${timers.get(`${instance}#${id}`)}fired +${at}`);
    } else if (kind === 'timer.clear') {
      const [, instance, id] = entry;
      if (id !== null && timers.has(`${instance}#${id}`) && timers.get(`${instance}#${id}`).endsWith(' ')) timers.set(`${instance}#${id}`, `${timers.get(`${instance}#${id}`)}cleared +${now}`);
    } else if (kind === 'call') {
      calls.set(entry[2], { member: `${inst(entry[1])}${entry[3]}`, end: 'pending' });
    } else if (kind === 'returned' || kind === 'resolved' || kind === 'rejected' || kind === 'threw') {
      const call = calls.get(entry[1]);
      const text = valueText(entry[2]);
      call.end = `${kind}${text ? ` ${text}` : ''}`;
    }
  }
  const answerText = (list) => {
    // Rejections keep their mark; the rest compress like steps.
    const plain = list.filter((item) => typeof item === 'number');
    const rejected = list.filter((item) => typeof item === 'string');
    return `${stepList(plain)}${rejected.length ? `${plain.length ? ' ' : ''}rejected ${rejected.map((item) => item.slice(0, -1)).join(' ')}` : ''}`;
  };
  const facts = {
    steps: d.steps,
    clock: clock.map(({ now: at, from, to }) => `+${at} ${from === to ? from : `${from}-${to}`}`),
    groups,
    ports: Object.fromEntries([...ports].map(([name, list]) => [name, stepList(list)])),
    answers: Object.fromEntries([...answers].map(([name, list]) => [name, answerText(list)])),
    launches: runs(launches),
    timers: counted([...timers.values()].map((text) => (text.endsWith(' ') ? `${text}live` : text))),
    outcomes: runs([...calls.values()].map((call) => `${call.member} ${call.end}`)),
    final: finalStatuses(d),
  };
  if (d.crashSaves) facts.restart = restartFacts(d);
  return facts;
}

/** The last instance's last saved state: every task's label by status, in the state's order. */
function finalStatuses(d) {
  const last = d.instances[d.instances.length - 1];
  const save = [...last.entries].reverse().find((entry) => entry.name === 'persistence.save');
  if (!save) return {};
  const byStatus = new Map();
  for (const task of save.args[0].tasks) byStatus.set(task.status, [...(byStatus.get(task.status) ?? []), task.label]);
  return Object.fromEntries([...byStatus].sort(([a], [b]) => (a < b ? -1 : 1)).map(([status, labels]) => [status, runs(labels.sort(byLabel)).join(', ')]));
}

/** After a crash point: what the crashed instance did, and which of its saves the fresh one loads (by the bytes). */
function restartFacts(d) {
  const [crashed, fresh] = d.instances;
  const saves = crashed.entries.filter((entry) => entry.name === 'persistence.save');
  const crashSave = crashed.saves;
  const after = crashed.entries.filter((entry) => entry.seq > saves[saves.length - 1].seq && entry.name !== 'publishEvent').map((entry) => entry.name);
  const loaded = fresh.policies['persistence.load'].answer();
  // By the bytes; when two saves have the same bytes (a ledger emptied again), the one the crash point names, if it is one of them.
  const encoded = loaded === null ? null : d.encodeSaved(loaded);
  const named = fresh.restartedFrom ? (fresh.restartedFrom.mode === 'durable' ? fresh.restartedFrom.save : fresh.restartedFrom.save - 1) : 0;
  const index = loaded === null ? 0 : named > 0 && d.crashSaves[named - 1] === encoded ? named : d.crashSaves.indexOf(encoded) + 1;
  return { crashedAfterSave: crashSave, portsAfterIt: after, loads: loaded === null ? 'nothing' : index === 0 ? 'no save of the crashed instance' : `save ${index}` };
}

/** The facts a crash point states: the crashed instance stops at save k; a durable write is loaded, a torn one is not. */
export const crashFacts = (index, mode) => ({ crashedAfterSave: index, portsAfterIt: [], loads: mode === 'durable' ? `save ${index}` : index === 1 ? 'nothing' : `save ${index - 1}` });

/** What a corpus test states: its scenario's facts, or for a crash point the restart alone (its other facts are the scenario's run up to where it stops, which the scenario's own case pins). */
export const statedFacts = (entry, actual) => (entry.crash
  ? { ...Object.fromEntries(FACT_KEYS.map((key) => [key, actual[key]])), restart: crashFacts(entry.crash.index, entry.crash.mode) }
  : entry.scenario.facts);

/** The trace facts of one recorded case (TRACE_FACT_KEYS), read from its events in `at` order, plus what is wrong with its step markers. */
export function traceFacts(record, resolve) {
  const events = record.constructions.flatMap((construction) => construction.events.map((event) => ({ ...event, construction: construction.n }))).sort((a, b) => a.at - b.at);
  let marker = null;
  let saves = 0;
  const clock = [];
  const groups = [];
  const launches = [];
  const problems = [];
  const stepInputs = [];
  const closeStep = () => {
    if (!marker) return;
    // Every input the marker lists is in its step, and every input event of the step is listed.
    const want = marker.inputs.map((item) => inputKey(item)).sort();
    const got = stepInputs.sort();
    if (JSON.stringify(want) !== JSON.stringify(got)) problems.push(`step ${marker.step}: the marker lists ${JSON.stringify(want)}, the step holds ${JSON.stringify(got)}`);
    stepInputs.length = 0;
  };
  for (const event of events) {
    if (event.kind === 'step') {
      closeStep();
      marker = event;
      const at = event.now - EPOCH;
      const last = clock[clock.length - 1];
      if (last && last.now === at) last.to = event.step; else clock.push({ now: at, from: event.step, to: event.step });
      if (event.inputs.length > 1) groups.push(`${event.step}: ${runs(event.inputs.map((item) => item.label)).join(', ')}`);
      continue;
    }
    if (event.dir === 'in' && event.kind === 'clock' && event.source === 'option' && marker && resolve(event.value) !== marker.now) problems.push(`step ${marker.step}: a clock read gave ${resolve(event.value)}, the marker says ${marker.now}`);
    if (event.dir === 'in' && marker && event.call !== 0) {
      const key = eventKey(event);
      if (key) stepInputs.push(key);
    }
    if (event.kind === 'port' && event.name === 'persistence.save') saves += 1;
    if (event.kind === 'port' && LAUNCH.has(event.name)) {
      const args = resolve(event.args);
      launches.push(`${event.construction > 1 ? `i${event.construction} ` : ''}${event.name === 'executor.start' ? '' : `${event.name.slice('executor.'.length)} `}${args?.[0]?.label ?? '?'} @${marker?.step ?? 0} after ${saves}`);
    }
  }
  closeStep();
  return { facts: { steps: marker?.step ?? 0, clock: clock.map(({ now, from, to }) => `+${now} ${from === to ? from : `${from}-${to}`}`), groups, launches: runs(launches) }, problems };
}
/** The key of a delivered input, from the marker and from its event. */
const inputKey = (item) => (item.kind === 'answer' ? `${item.construction} answer ${item.port} ${item.outcome}` : item.kind === 'abort' ? `${item.construction} abort ${item.signal}` : `${item.construction} ${item.kind} ${item.call}`);
function eventKey(event) {
  if (event.kind === 'answer') return event.outcome === 'resolve' || event.outcome === 'reject' ? `${event.construction} answer ${event.port} ${event.outcome}` : null;
  if (event.kind === 'abort') return `${event.construction} abort ${event.signal}`;
  if (event.kind === 'call' || event.kind === 'control' || event.kind === 'callback' || event.kind === 'fire') return `${event.construction} ${event.kind} ${event.call}`;
  return null;
}

/** The differences between what a scenario states and what a run shows, one line per key. `keys` limits the comparison (a trace has fewer). */
export function compareFacts(stated, actual, keys = Object.keys(actual)) {
  if (!stated || typeof stated !== 'object') return ['the scenario states no facts'];
  const out = [];
  for (const key of FACT_KEYS) if (!(key in stated)) out.push(`${key}: not stated`);
  if ('restart' in actual && !('restart' in stated)) out.push('restart: not stated');
  for (const key of keys) {
    if (!(key in stated)) continue;
    const want = JSON.stringify(stated[key]);
    const got = JSON.stringify(actual[key]);
    if (want === got) continue;
    out.push(`${key}: ${firstDifference(stated[key], actual[key])}`);
  }
  return out;
}
function firstDifference(want, got) {
  if (Array.isArray(want) && Array.isArray(got)) {
    for (let index = 0; index < Math.max(want.length, got.length); index += 1) {
      if (JSON.stringify(want[index]) !== JSON.stringify(got[index])) return `entry ${index}: stated ${JSON.stringify(want[index]) ?? '(none)'}, found ${JSON.stringify(got[index]) ?? '(none)'}`;
    }
  }
  if (want && got && typeof want === 'object' && typeof got === 'object' && !Array.isArray(want)) {
    for (const key of new Set([...Object.keys(want), ...Object.keys(got)])) {
      if (JSON.stringify(want[key]) !== JSON.stringify(got[key])) return `${key}: stated ${JSON.stringify(want[key]) ?? '(none)'}, found ${JSON.stringify(got[key]) ?? '(none)'}`;
    }
  }
  return `stated ${JSON.stringify(want)}, found ${JSON.stringify(got)}`;
}

/** Runs every scenario (the large ones excepted) and every crash point once and compares its facts. In this process: run it with bun. */
export async function checkScenarioFacts({ names = null, withCrashPoints = true } = {}) {
  const { corpusTests, runScenario } = await import('./scenarios.mjs');
  const results = [];
  for (const entry of corpusTests()) {
    if (names && !names.includes(entry.scenario.name)) continue;
    if (entry.crash && !withCrashPoints) continue;
    let differences;
    try {
      const { driver } = await runScenario(entry.scenario, { crash: entry.crash });
      const actual = scenarioFacts(driver);
      differences = compareFacts(statedFacts(entry, actual), actual);
    } catch (error) {
      differences = [`the run failed: ${error?.check ? `driver check ${error.check}: ` : ''}${error?.message ?? error}`];
    }
    results.push({ name: entry.name, differences });
  }
  return { results, problems: results.filter((entry) => entry.differences.length).map((entry) => `${entry.name}: ${entry.differences.join('; ')}`) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const option = process.argv.slice(2).find((arg) => arg.startsWith('--scenarios='));
  const result = await checkScenarioFacts({ names: option ? option.slice('--scenarios='.length).split(',') : null });
  console.log(JSON.stringify({ cases: result.results.length, problems: result.problems }));
  process.exitCode = result.problems.length ? 1 : 0;
}
