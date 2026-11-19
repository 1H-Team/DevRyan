#!/usr/bin/env node
// The TypeScript replayer of the client engine conformance harness: the
// closure check (design file 29 §4.3, package C0d). It replays every recorded
// case of the families it can replay against the TypeScript modules
// themselves and requires an exact reproduction: what each step returned or
// threw, the arguments after it, the change set, every effect and their
// order (replay-compare.mjs). A difference means the recording missed an
// input (a recorder gap), the replayer is wrong, or the engine is not
// deterministic; it is never masked.
//
//   node scripts/client-conformance/replay.mjs --toys [--modes=file,isolated] [--json=<file>]
//   node scripts/client-conformance/replay.mjs --from=<directory of containers> --port-map=<file> [--cwd=<dir>] [--families=a,b] [--modes=] [--json=]
//
// Each case is replayed twice: in file order (the cases of one container, in
// order, on one fresh module instance, as the tests ran them) and alone (on
// a fresh module instance of its own). A step's input is delivered, the
// engine runs to quiescence, and only then is the next delivered. The engine
// is a process behind the protocol of engine.mjs; here the TypeScript one.
//
// Outcomes per case: `reproduced`; `different` (the first differing step,
// every check that differs there and its first differing path); `unrecordable`
// (as recorded: never judged); `no-reference` (recorded inconclusive or
// unstable: never judged); `not-replayable` (a feature a later package
// replays, named with that package); `inconclusive` (the replayer could not
// judge it: the engine was lost or did not answer in time, an entry it cannot
// place, an input it cannot rebuild). Exit codes as every tool of the
// harness: 0 only when every case that should be judged was judged in both
// modes and none differs, and at least one was; 1 a difference; 3
// inconclusive (precedence over 1); 64 usage.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readContainer, VALUE_REF } from './container.mjs';
import { expandStrings, openEngine, PROTOCOL, shareStrings, typescriptEngine } from './engine.mjs';
import { checkManifest, readManifestText, recordedFamilies } from './manifest.mjs';
import { loadPortMap } from './port-map.mjs';
import { createScratch, EXIT, HARNESS_DIR, parseOptions, recordOnce, REPOSITORY_ROOT, stopOnInterrupt, TOY_EXPECTED } from './record.mjs';
import { bindPlan, compareReplayed, envOf, notReplayable } from './replay-compare.mjs';

export const MODES = Object.freeze(['file', 'isolated']);
export const REPLAY_TOY_DIR = path.join(HARNESS_DIR, 'toy', 'replay');
export const REPLAY_PORT_MAP = path.join(REPLAY_TOY_DIR, 'replay-port-map.json');
export const REPLAY_TOYS = Object.freeze(['toy-relay.toy.mjs']);
/**
 * The replayer's own fixtures: the cases of its toy family that must not be
 * reproduced in a mode, with the check that must report them. Every other
 * judged case must be reproduced in both modes.
 */
export const REPLAY_FIXTURES = Object.freeze([
  { case: /toy-relay\.toy\.mjs:\d+ toy relay > a later test sees the count the earlier test left #1\/toy-relay$/, mode: 'isolated', check: 'result', step: 1,
    reason: 'hidden module state (a counter no export snapshots): file order reproduces it, a case alone starts from a fresh module (design §5, "hidden module state")' },
]);
// A halt the replayer causes itself (it could not place or rebuild a step) is no judgement of the engine.
const INCONCLUSIVE_HALTS = new Set(['unplaced', 'rebuild', 'quiescence']);
const DEFAULT_DEADLINE_MS = 300000;

/** What the engine needs of a family of the port map: its module, entries, injected ports and module ports. */
export function familyDescriptor(portMap, name) {
  const family = portMap.families.find((item) => item.name === name);
  if (!family) return null;
  const ports = [];
  for (const [module, target] of portMap.modules) {
    for (const [exportName, port] of target.ports) if (port.families.includes(name)) ports.push({ module, export: exportName, name: port.name });
  }
  return {
    name, module: family.module, state: family.state ?? null,
    entries: (family.entries ?? []).map((entry) => ({ export: entry.export, ...(entry.draft !== undefined ? { draft: entry.draft } : {}) })),
    injected: (family.injected ?? []).map((item) => ({ entry: item.entry, arg: item.arg, ...(item.key !== undefined ? { key: item.key } : {}), name: item.name })),
    injectedNames: (family.injected ?? []).map((item) => item.name),
    ports, unordered: (family.unorderedPorts ?? []).map((waiver) => waiver.port),
  };
}

/** A case with every value slot replaced by its tree (context left out: it is never replayed). */
function resolveCase(record, resolve) {
  const deep = (value) => {
    if (typeof value === 'string' && VALUE_REF.test(value)) return resolve(value);
    if (Array.isArray(value)) return value.map(deep);
    if (value !== null && typeof value === 'object') { const out = {}; for (const key of Object.keys(value)) out[key] = deep(value[key]); return out; }
    return value;
  };
  const { context: _context, ...rest } = record;
  return { ...rest, entry: deep(record.entry), steps: deep(record.steps), end: deep(record.end) };
}

/** Every step is a call, so the case can be delivered (in file order, to keep the module's history) even when it is not judged. */
const deliverable = (kase) => kase.steps.every((step) => step.input.kind === 'call' && !String(step.input.entry).includes('#') && step.input.during === undefined && step.input.caller === undefined && !step.late);

/**
 * Reads containers (`{ name, text }`) and decides each case: judged, or why
 * not. Returns `{ containers, problems }`; each container keeps its reader so
 * its cases are resolved only when a unit needs them.
 */
export function planContainers(list, portMap, { families = null } = {}) {
  const problems = [];
  const containers = [];
  for (const { name, text } of list) {
    // A container of a family not asked for is not read past its header line.
    if (families) {
      let head = null;
      try { head = JSON.parse(text.slice(0, text.indexOf('\n') < 0 ? text.length : text.indexOf('\n'))); } catch { head = null; }
      if (head && typeof head.family === 'string' && !families.includes(head.family)) continue;
    }
    let reader;
    try { reader = readContainer(text); } catch (error) { problems.push({ check: 'container', container: name, detail: error.message }); continue; }
    const { header } = reader;
    if (families && !families.includes(header.family)) continue;
    const family = familyDescriptor(portMap, header.family);
    if (!family) { problems.push({ check: 'family', container: name, detail: `family ${header.family} is not in the port map` }); continue; }
    if (header.portMap !== portMap.digest) { problems.push({ check: 'header', container: name, detail: `recorded with port map ${header.portMap}, replayed with ${portMap.digest}` }); continue; }
    const cases = reader.cases.map((record) => {
      const verdict = { id: record.id, outcome: record.outcome, judge: false, reason: null, later: null, deliver: false };
      if (record.outcome === 'unrecordable') verdict.reason = record.reason ?? 'unrecordable';
      else if (record.outcome !== 'recorded') verdict.reason = `recorded ${record.outcome}: ${record.reason ?? 'no reference'}`;
      return { record, verdict };
    });
    for (const item of cases) {
      const not = notReplayable(item.record, family);
      item.verdict.deliver = not === null && deliverable(item.record);
      if (item.record.outcome !== 'recorded') continue;
      if (not) { item.verdict.reason = not.feature; item.verdict.later = not.later; continue; }
      item.verdict.judge = true;
    }
    containers.push({ name, family, header, reader, cases });
  }
  return { containers, problems };
}

const outcomeOf = (verdict) => (verdict.judge ? null : verdict.outcome === 'unrecordable' ? 'unrecordable' : verdict.outcome !== 'recorded' ? 'no-reference' : 'not-replayable');

// A difference that something the engine noted after a case ended (or between its steps and its end) makes.
const outsideDifference = (entries, when) => ({ check: 'outside', kind: 'value', step: null, path: '/outside', expected: `nothing ${when}`, actual: JSON.stringify(entries.map((entry) => entry.what)).slice(0, 400) });

/** Runs one unit (a fresh module instance) on the engine: its cases in order, each step to quiescence before the next. */
async function runUnit(engine, unit, plants, results, notes) {
  const { container, mode, items, id } = unit;
  const where = `${container.name} (${mode})`;
  const opened = await engine.request({ op: 'open', unit: id, family: container.family, plants }, { what: `open of ${container.family.name} for ${where}` }).catch((error) => ({ ok: false, error: error.message, lost: true }));
  const judgeAll = (outcome, detail) => { for (const item of items) if (item.verdict.judge) results.get(item.key)[mode] = { outcome, differences: [], detail, stepsCompared: 0 }; };
  if (!opened.ok) { judgeAll('inconclusive', `the engine could not open ${container.family.name}: ${opened.error}`); await engine.request({ op: 'close', unit: id, force: true }, { what: `close of ${where}` }).catch(() => {}); return; }
  if ((opened.load ?? []).length) notes.push(`${where}: module load noted ${JSON.stringify(opened.load.map((entry) => entry.what)).slice(0, 300)} (not compared: no case was open)`);
  // What the engine noted after a case ended is that case's: a case the replayer judged differs by it (check `outside`).
  let previous = null;
  const charge = (entries, when) => {
    if (!entries?.length || !previous) return;
    const entry = previous.verdict.judge ? results.get(previous.key)[mode] : null;
    if (!entry) { notes.push(`${where}: ${previous.verdict.id}, not judged, left ${JSON.stringify(entries.map((item) => item.what)).slice(0, 300)} ${when}`); return; }
    if (entry.outcome === 'inconclusive') return;
    entry.outcome = 'different';
    entry.differences.push(outsideDifference(entries, when));
  };
  let lost = null;
  for (const item of items) {
    if (lost) { if (item.verdict.judge) results.get(item.key)[mode] = { outcome: 'inconclusive', differences: [], detail: lost, stepsCompared: 0 }; continue; }
    const kase = resolveCase(item.record, container.reader.resolve);
    const plan = bindPlan(kase);
    const label = (what) => `${what} of ${kase.id} in ${where}`;
    try {
      // The engine is told nothing that names the case: the replayer keeps the mapping from its unit and order to `kase`.
      const begun = await engine.request({ op: 'case', unit: id }, { what: label('the case') });
      if (!begun.ok) throw new Error(begun.error);
      charge(begun.between, 'after the case ended');
      previous = item;
      const table = [];
      for (const [index, step] of kase.steps.entries()) {
        const before = table.length;
        const input = shareStrings({ kind: step.input.kind, entry: step.input.entry, args: step.input.args, now: step.input.now }, table);
        const env = shareStrings(envOf(step), table);
        const message = { op: 'step', unit: id, step: { input, env, bind: plan[index], ...(table.length > before ? { strings: table.slice(before) } : {}) } };
        const answer = await engine.request(message, { what: label(`step ${index + 1} (recorded ${step.n})`) });
        if (!answer.ok) throw new Error(answer.error);
        if (answer.halted) break;
      }
      const ended = await engine.request({ op: 'end', unit: id }, { what: label('the end') });
      if (!ended.ok) throw new Error(ended.error);
      const replayed = readReplayed(ended.replayed, kase);
      if (!item.verdict.judge) { if (replayed.outside.length) notes.push(`${where}: ${kase.id}, not judged, made ${JSON.stringify(replayed.outside.map((entry) => entry.what)).slice(0, 300)} while no step was open`); continue; }
      const { differences, stepsCompared } = compareReplayed(kase, replayed, { unordered: container.family.unordered });
      const halt = replayed.halt;
      const inconclusive = halt && INCONCLUSIVE_HALTS.has(halt.check) && differences.every((entry) => entry.check === 'halt' || entry.step === halt.step);
      results.get(item.key)[mode] = {
        outcome: inconclusive ? 'inconclusive' : differences.length ? 'different' : 'reproduced',
        differences, stepsCompared, steps: kase.steps.length,
        detail: inconclusive ? `the replayer could not deliver step ${halt.step}: ${halt.check}: ${halt.detail}` : null,
        // A binding not found is no difference by itself: a later input that names the object then differs by identity.
        notes: replayed.bindFailures.length ? [`${replayed.bindFailures.length} bindings not found`] : [],
      };
    } catch (error) {
      lost = `the engine failed on ${kase.id}: ${error.message}`;
      if (item.verdict.judge) results.get(item.key)[mode] = { outcome: 'inconclusive', differences: [], detail: lost, stepsCompared: 0 };
    }
  }
  // A unit the engine lost (or that did not answer in time) is stopped at once, so a hung step takes no core for the rest of the run.
  const closed = await engine.request({ op: 'close', unit: id, ...(lost ? { force: true } : {}) }, { what: `close of ${where}` }).catch(() => null);
  if (!lost) charge(closed?.between, 'after the case ended');
}

/**
 * What an engine's `end` answered, in the shape the comparison reads: its
 * strings put back, and every member a careless engine might leave out
 * present (no steps is a step-count difference, not an engine failure). The
 * halt's step is the engine's count, mapped back to the recorded step number.
 */
function readReplayed(replayed, kase) {
  const given = replayed !== null && typeof replayed === 'object' ? replayed : {};
  const strings = Array.isArray(given.strings) ? given.strings : [];
  const steps = Array.isArray(given.steps) ? expandStrings(given.steps, strings).filter((step) => step !== null && typeof step === 'object').map((step) => ({ ...step, input: step.input ?? {}, effects: Array.isArray(step.effects) ? step.effects : [] })) : [];
  const halt = given.halt && typeof given.halt === 'object' ? { ...given.halt, step: Number.isInteger(given.halt.step) ? (kase.steps[given.halt.step - 1]?.n ?? given.halt.step) : given.halt.step } : null;
  return { steps, halt, outside: Array.isArray(given.outside) ? given.outside : [], bindFailures: Array.isArray(given.bindFailures) ? given.bindFailures : [] };
}

/**
 * Replays the planned containers on `engine` (a process description:
 * engine.mjs typescriptEngine) in `modes`, `concurrency` units at a time.
 * `plants` ({ module, source }) load a planted copy of a module in place of
 * its file. Resolves `{ cases, problems, engineStderr }`; each case
 * `{ container, family, id, outcome, modes: { file?, isolated? }, reason, later }`.
 */
export async function replayPlanned(planned, { engine, modes = MODES, plants = [], concurrency, deadlineMs = DEFAULT_DEADLINE_MS, startDeadlineMs }) {
  const results = new Map();
  const units = [];
  let unitId = 0;
  for (const container of planned.containers) {
    const items = container.cases.map((item, index) => ({ ...item, key: `${container.name}\0${index}` }));
    for (const item of items) results.set(item.key, {});
    if (modes.includes('file')) {
      const delivered = items.filter((item) => item.verdict.deliver);
      if (delivered.some((item) => item.verdict.judge)) units.push({ id: (unitId += 1), container, mode: 'file', items: delivered });
    }
    if (modes.includes('isolated')) for (const item of items) if (item.verdict.judge) units.push({ id: (unitId += 1), container, mode: 'isolated', items: [item] });
  }
  const engineProcess = openEngine({ ...engine, deadlineMs });
  const problems = [];
  const notes = [];
  try {
    const hello = await engineProcess.request({ op: 'hello', protocol: PROTOCOL }, { what: 'hello', deadlineMs: startDeadlineMs ?? deadlineMs });
    if (!hello.ok) throw new Error(hello.error);
    if (hello.protocol !== PROTOCOL) throw new Error(`engine ${engineProcess.name} speaks protocol ${hello.protocol}; this replayer speaks ${PROTOCOL}`);
    let next = 0;
    const width = Math.max(1, Math.min(units.length, concurrency ?? Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)))));
    await Promise.all(Array.from({ length: width }, async () => {
      while (next < units.length) {
        const unit = units[next];
        next += 1;
        await runUnit(engineProcess, unit, plants, results, notes);
      }
    }));
  } catch (error) {
    problems.push({ check: 'engine', detail: `${error.message}${engineProcess.stderr ? `\n${engineProcess.stderr.trim().slice(-2000)}` : ''}` });
  } finally {
    await engineProcess.stop();
  }
  const cases = [];
  for (const container of planned.containers) {
    container.cases.forEach((item, index) => {
      const byMode = results.get(`${container.name}\0${index}`);
      const ran = modes.map((mode) => byMode[mode]).filter(Boolean);
      let outcome = outcomeOf(item.verdict);
      if (outcome === null) {
        // A judged case is reproduced only when every mode ran it and reproduced it.
        if (ran.length < modes.length) outcome = 'inconclusive';
        else if (ran.some((entry) => entry.outcome === 'inconclusive')) outcome = 'inconclusive';
        else if (ran.some((entry) => entry.outcome === 'different')) outcome = 'different';
        else outcome = 'reproduced';
      }
      cases.push({ container: container.name, family: container.family.name, id: item.verdict.id, outcome, modes: byMode, reason: item.verdict.reason, later: item.verdict.later, delivered: item.verdict.deliver });
    });
  }
  return { cases, problems, notes, engineStderr: engineProcess.stderr };
}

/** Counts per family and outcome, and per family the features a later package replays. */
export function summarize(cases, modes = MODES) {
  const families = {};
  for (const kase of cases) {
    const row = (families[kase.family] ??= { cases: 0, judged: 0, reproduced: 0, different: 0, inconclusive: 0, unrecordable: 0, 'no-reference': 0, 'not-replayable': 0, byMode: {}, later: {}, stepsCompared: 0, steps: 0 });
    row.cases += 1;
    row[kase.outcome] += 1;
    if (['reproduced', 'different', 'inconclusive'].includes(kase.outcome)) row.judged += 1;
    if (kase.later) row.later[`${kase.reason} (${kase.later})`] = (row.later[`${kase.reason} (${kase.later})`] ?? 0) + 1;
    for (const mode of modes) {
      const entry = kase.modes[mode];
      if (!entry) continue;
      const byMode = (row.byMode[mode] ??= { reproduced: 0, different: 0, inconclusive: 0 });
      byMode[entry.outcome] += 1;
      if (mode === modes[0]) { row.stepsCompared += entry.stepsCompared ?? 0; row.steps += entry.steps ?? 0; }
    }
  }
  return families;
}

/** One line for a difference: the case, the mode, the step, each check that differs there and its first differing path. */
export function formatCase(kase) {
  const parts = [];
  for (const [mode, entry] of Object.entries(kase.modes)) {
    if (entry.outcome === 'reproduced') continue;
    if (entry.outcome === 'inconclusive') { parts.push(`${mode}: inconclusive: ${entry.detail}`); continue; }
    const step = entry.differences[0]?.step;
    parts.push(`${mode}: step ${step}: ${entry.differences.map((item) => `${item.check}${item.kind ? `/${item.kind}` : ''} at ${item.path}: expected ${item.expected}, replayed ${item.actual}${item.detail && item.check !== 'halt' ? ` (${item.detail})` : ''}`).join('; ')}`);
  }
  return `${kase.outcome} ${kase.id} [${kase.container}]: ${parts.join(' | ')}`;
}

/**
 * Judges a replay: `expected` lists fixtures that must differ in a mode with
 * a check (REPLAY_FIXTURES); every other judged case must be reproduced;
 * every family of `requireFamilies` must have a judged case.
 * Returns `{ code, failures, inconclusive, fixtures }`.
 */
export function judgeReplay(result, { expected = [], modes = MODES, requireJudged = true, requireFamilies = [] } = {}) {
  const failures = [];
  const inconclusive = [...result.problems.map((problem) => `${problem.check}${problem.container ? ` ${problem.container}` : ''}: ${problem.detail}`)];
  const fixtures = [];
  for (const kase of result.cases) {
    const fixture = expected.filter((item) => item.case.test(kase.id));
    for (const mode of modes) {
      const entry = kase.modes[mode];
      if (!entry) continue;
      const wanted = fixture.find((item) => item.mode === mode);
      if (entry.outcome === 'inconclusive') { inconclusive.push(`${kase.id} (${mode}): ${entry.detail}`); continue; }
      if (wanted) {
        const hit = entry.outcome === 'different' && entry.differences.some((item) => item.check === wanted.check && (wanted.step === undefined || item.step === wanted.step));
        fixtures.push({ case: kase.id, mode, caught: hit });
        if (!hit) failures.push(`fixture ${kase.id} (${mode}) must differ by ${wanted.check}${wanted.step ? ` at step ${wanted.step}` : ''}: ${entry.outcome === 'reproduced' ? 'it was reproduced' : formatCase(kase)}`);
        continue;
      }
      if (entry.outcome === 'different') failures.push(formatCase({ ...kase, modes: { [mode]: entry } }));
    }
    if (kase.outcome === 'inconclusive' && modes.some((mode) => !kase.modes[mode])) inconclusive.push(`${kase.id}: not run in every mode`);
  }
  for (const item of expected) if (!result.cases.some((kase) => item.case.test(kase.id) && kase.modes[item.mode])) inconclusive.push(`fixture ${item.case} (${item.mode}) was not replayed`);
  if (requireJudged && !result.cases.some((kase) => ['reproduced', 'different'].includes(kase.outcome))) inconclusive.push('nothing was replayed: no case could be judged');
  // A family that must be judged and has no judged case was not judged at all: never a pass.
  for (const family of requireFamilies) {
    if (!result.cases.some((kase) => kase.family === family && ['reproduced', 'different'].includes(kase.outcome))) inconclusive.push(`family ${family} has no judged case`);
  }
  const code = inconclusive.length ? EXIT.inconclusive : failures.length ? EXIT.fail : EXIT.pass;
  return { code, failures, inconclusive, fixtures };
}

/** The summary lines of a replay: per family, then totals. */
export function reportLines(result, verdict, modes = MODES) {
  const families = summarize(result.cases, modes);
  const lines = [];
  const notYet = [];
  for (const [name, row] of Object.entries(families).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const byMode = modes.map((mode) => `${mode} ${row.byMode[mode]?.reproduced ?? 0}/${row.judged}`).join(', ');
    lines.push(`${name}: ${row.cases} cases; ${row.judged} judged (reproduced ${byMode}; ${row.different} different, ${row.inconclusive} inconclusive), ${row.stepsCompared}/${row.steps} steps compared; ${row.unrecordable} unrecordable, ${row['no-reference']} no reference, ${row['not-replayable']} not replayable yet${Object.keys(row.later).length ? `: ${Object.entries(row.later).map(([what, count]) => `${count} ${what}`).join('; ')}` : ''}`);
    if (row['not-replayable']) notYet.push(name);
  }
  const total = (key) => Object.values(families).reduce((sum, row) => sum + row[key], 0);
  const steps = Object.values(families).reduce((sum, row) => sum + row.stepsCompared, 0);
  const allSteps = Object.values(families).reduce((sum, row) => sum + row.steps, 0);
  lines.push(`${new Set(result.cases.map((kase) => kase.container)).size} containers, ${result.cases.length} cases: ${total('reproduced')} reproduced (${modes.join(' and ')}), ${total('different')} different, ${total('inconclusive')} inconclusive, ${total('unrecordable')} unrecordable, ${total('no-reference')} no reference, ${total('not-replayable')} not replayable yet${notYet.length ? ` (${notYet.join(', ')})` : ''}; ${steps}/${allSteps} steps compared; ${verdict.fixtures.length ? `${verdict.fixtures.filter((item) => item.caught).length}/${verdict.fixtures.length} fixtures caught; ` : ''}${verdict.failures.length} differences, ${verdict.inconclusive.length} inconclusive problems; exit ${verdict.code}`);
  return lines;
}

/** Containers of a directory, by name. */
export function readContainerDir(directory) {
  return readdirSync(directory).filter((name) => name.endsWith('.ndjson')).sort().map((name) => ({ name, text: readFileSync(path.join(directory, name), 'utf8') }));
}

/**
 * A recording directory as the closure reads it: its containers, checked
 * against the recording's manifest (manifest.mjs; a missing, extra or altered
 * container, a changed count or a re-marked case is a `manifest` problem),
 * and the families it must judge: those asked for, or every family of the
 * manifest with a recorded case, and every family of the port map when the
 * recording was of all of them. Returns `{ list, problems, requireFamilies,
 * manifest }`.
 */
export function readRecording(directory, portMap, { families = null } = {}) {
  const list = readContainerDir(directory);
  const { problems, manifest } = checkManifest(readManifestText(directory), list, { portMap: portMap.digest });
  const required = new Set(families ?? recordedFamilies(manifest));
  if (manifest && manifest.scope === null && !families) {
    for (const family of portMap.families) if (!Object.hasOwn(manifest.families, family.name)) problems.push({ check: 'manifest', detail: `family ${family.name} of the port map is not in the recording` });
  }
  return { list, problems, requireFamilies: [...required].sort(), manifest };
}

/**
 * An engine given on the command line (`--engine=<file>`): a `.mjs` or `.js`
 * file is run by this Node, anything else as an executable; `args` follow.
 * The protocol is engine.mjs's; `cwd` is where it runs.
 */
export function commandEngine(file, { args = [], cwd }) {
  const absolute = path.resolve(file);
  const script = /\.[cm]?js$/.test(absolute);
  return { name: path.basename(absolute), command: script ? process.execPath : absolute, args: script ? [absolute, ...args] : args, cwd };
}

/** Records the replayer's own toy family into `workDir` (scratch); resolves the recording (record.mjs recordOnce). */
export async function recordReplayToys({ workDir, harnessDir = HARNESS_DIR, root: given = REPOSITORY_ROOT }) {
  // Port names are paths relative to the root: a root reached through a symbolic link (the OS temp dir) is resolved first.
  const root = realpathSync(given);
  const files = REPLAY_TOYS.map((name) => path.relative(root, path.join(harnessDir, 'toy', 'replay', name)).split(path.sep).join('/'));
  return recordOnce({ files, cwd: root, root, portMap: path.join(harnessDir, 'toy', 'replay', 'replay-port-map.json'), families: ['toy-relay'], workDir, recorder: path.join(harnessDir, 'recorder.mjs') });
}

/**
 * The toy closure: the tracked toy corpus (toy/expected) and a fresh recording
 * of the replayer's own toy family, each replayed with its port map; the
 * fixtures of REPLAY_FIXTURES must differ as listed. Resolves
 * `{ results: [toyCorpus, replayToys], verdicts, code }`.
 */
export async function toyClosure({ workDir, harnessDir: givenDir = HARNESS_DIR, root: given = REPOSITORY_ROOT, modes = MODES, plants = [], plantsReplay = plants, concurrency, recording, expectedDir = TOY_EXPECTED }) {
  const root = realpathSync(given);
  const harnessDir = realpathSync(givenDir);
  const toyMap = loadPortMap(path.join(harnessDir, 'toy', 'port-map.json'), { root });
  const replayMap = loadPortMap(path.join(harnessDir, 'toy', 'replay', 'replay-port-map.json'), { root });
  const engine = typescriptEngine({ cwd: root });
  const recorded = recording ?? await recordReplayToys({ workDir, harnessDir, root });
  const problems = recorded.incomplete.map((entry) => ({ check: `recording ${entry.check}`, detail: entry.detail }));
  const corpus = planContainers(readContainerDir(expectedDir), toyMap);
  const own = planContainers(recorded.containers.map((container) => ({ name: container.name, text: container.text })), replayMap);
  const [first, second] = await Promise.all([
    replayPlanned(corpus, { engine, modes, plants, concurrency }),
    replayPlanned(own, { engine, modes, plants: plantsReplay, concurrency }),
  ]);
  first.problems.unshift(...corpus.problems);
  second.problems.unshift(...own.problems, ...problems);
  const verdicts = [judgeReplay(first, { modes }), judgeReplay(second, { modes, expected: REPLAY_FIXTURES })];
  const code = verdicts.some((verdict) => verdict.code === EXIT.inconclusive) ? EXIT.inconclusive : verdicts.some((verdict) => verdict.code === EXIT.fail) ? EXIT.fail : EXIT.pass;
  return { results: [first, second], verdicts, code };
}

// ------------------------------------------------------------------ command line

export async function main(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
  const usage = 'usage: replay.mjs --toys | --from=<recording directory> --port-map=<file> [--cwd=<dir>] [--families=a,b] [--engine=<file> [--engine-args=a,b]]; [--modes=file,isolated] [--json=<file>] [--concurrency=N] [--deadline-ms=N] [--keep-artifacts]';
  const parsed = parseOptions(argv, { flags: ['toys', 'keep-artifacts'], values: ['from', 'port-map', 'cwd', 'families', 'modes', 'json', 'concurrency', 'deadline-ms', 'engine', 'engine-args'] });
  if (parsed.error) { error(`${parsed.error}\n${usage}`); return EXIT.usage; }
  const { options, positionals } = parsed;
  if (positionals.length || (options.toys === true) === (options.from !== undefined)) { error(usage); return EXIT.usage; }
  const modes = options.modes ? options.modes.split(',').filter(Boolean) : [...MODES];
  if (modes.length === 0 || modes.some((mode) => !MODES.includes(mode))) { error(`--modes takes ${MODES.join(', ')}\n${usage}`); return EXIT.usage; }
  const concurrency = options.concurrency !== undefined ? Number(options.concurrency) : undefined;
  if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1)) { error(`--concurrency must be a positive integer\n${usage}`); return EXIT.usage; }
  const deadlineMs = options['deadline-ms'] !== undefined ? Number(options['deadline-ms']) : DEFAULT_DEADLINE_MS;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1) { error(`--deadline-ms must be a positive integer\n${usage}`); return EXIT.usage; }
  if ((options.engine !== undefined || options['engine-args'] !== undefined) && (options.toys || !options.engine)) { error(`--engine takes a file and goes with --from\n${usage}`); return EXIT.usage; }
  // An interrupt stops the engine (and a recording's bun) first. Only the toy closure records (into scratch); a replay of a
  // given directory writes nothing.
  stopOnInterrupt();
  const scratch = options.toys ? createScratch('client-conformance-replay', { keepArtifacts: options['keep-artifacts'] === true }) : null;
  let status = 'failed';
  try {
    let results;
    let verdicts;
    let code;
    if (options.toys) {
      ({ results, verdicts, code } = await toyClosure({ workDir: scratch.dir, modes, concurrency }));
    } else {
      if (!options['port-map'] || !existsSync(options.from) || !statSync(options.from).isDirectory()) { error(`--from needs a directory and --port-map a file\n${usage}`); return EXIT.usage; }
      let portMap;
      try { portMap = loadPortMap(path.resolve(options['port-map']), { root: REPOSITORY_ROOT }); } catch (failure) { error(failure.message); return EXIT.usage; }
      const families = options.families ? options.families.split(',').filter(Boolean) : null;
      const recording = readRecording(path.resolve(options.from), portMap, { families });
      const planned = planContainers(recording.list, portMap, { families });
      const cwd = path.resolve(options.cwd ?? REPOSITORY_ROOT);
      const engine = options.engine ? commandEngine(options.engine, { args: options['engine-args'] ? options['engine-args'].split(',') : [], cwd }) : typescriptEngine({ cwd });
      const result = await replayPlanned(planned, { engine, modes, concurrency, deadlineMs });
      result.problems.unshift(...recording.problems, ...planned.problems);
      results = [result];
      verdicts = [judgeReplay(result, { modes, requireFamilies: recording.requireFamilies })];
      code = verdicts[0].code;
    }
    results.forEach((result, index) => {
      for (const line of verdicts[index].inconclusive) error(`inconclusive: ${line}`);
      for (const line of verdicts[index].failures) error(`different: ${line}`);
      for (const line of reportLines(result, verdicts[index], modes)) log(line);
    });
    if (options.json) writeFileSync(options.json, `${JSON.stringify({ code, runs: results.map((result, index) => ({ families: summarize(result.cases, modes), verdict: verdicts[index], cases: result.cases })) }, null, 2)}\n`);
    status = code === EXIT.pass ? 'passed' : 'failed';
    return code;
  } finally {
    scratch?.finish(status);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}

