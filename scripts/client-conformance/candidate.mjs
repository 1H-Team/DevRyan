#!/usr/bin/env node
// The candidate comparer of the client engine conformance harness (package
// C0g; design file 29 §4.1, §4.2, §4.4): judges an engine that is not the
// TypeScript one against the recordings, by the candidate rules
// (candidate-compare.mjs: the exact rules with the freedoms written there),
// and its coverage by the candidate census (candidate-census.mjs).
//
//   node scripts/client-conformance/candidate.mjs --toys [--engine=<file> [--engine-args=a,b]] [options]
//   node scripts/client-conformance/candidate.mjs --product [--from=<recording directory>] [--engine=...] [options]
//   node scripts/client-conformance/candidate.mjs --from=<dir> --port-map=<file> --census=<file> --contract=<file> [--cwd=<dir>] [options]
//   options: [--rules=candidate|exact] [--families=a,b] [--partial] [--modes=file,isolated] [--repeat=N] [--json=<file>] [--concurrency=N] [--deadline-ms=N] [--keep-artifacts]
//
// The engine is spoken to by the protocol of engine.mjs (the TypeScript
// engine by default; `--engine=<file>`, a `.mjs` file run by Node or an
// executable). It is told nothing that names a case or holds a recorded
// output; the replayer keeps that. Each case is replayed in file order and
// alone. `--toys` judges the tracked toy corpus and a fresh recording of the
// replayer's own toys, with the toy census and contract (toy/census.json,
// toy/candidate-census.json), the toy fixtures as the unrecordable waivers;
// `--product` the product recording (recorded first into scratch without
// `--from`) with the product's census and contract. A directory must be what
// its manifest lists, and its manifest must say the recording passed its own
// checks (manifest version 2's verdict) and carry the items its census
// judges, for every family it lists. A run that skips part of the judgement
// (`--families`, a directory whose manifest names a scope, or `--modes` short
// of every mode) never exits 0, and its last line says `partial` and what it
// skipped: unless asked for with `--partial` it is inconclusive (3); asked
// for, a difference is still 1 and an unstable case 2, and a run whose judged
// part passed exits 3, its last line saying `partial pass`.
// `--repeat=N` runs the engine N times and makes a case it judged two ways
// unstable. An engine that does not implement a family refuses it as not
// ported (package C0i: the Rust runner names the families it implements):
// its cases are `not-ported`, the family is out of the judgement, and the
// run is partial by a line naming it, exactly as one run with `--families`.
// Exit codes: candidate-census.mjs (0, 1, 2, 3; 64 usage).
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { candidateCensus, casesWithRecords, censusLines, EXIT, judgeCandidate, judgeUnjudged, loadContract, repeatDifferences } from './candidate-census.mjs';
import { builtEngineMessages, compareCandidate, RULE_SETS } from './candidate-compare.mjs';
import { loadCensus } from './census.mjs';
import { typescriptEngine } from './engine.mjs';
import { loadPortMap } from './port-map.mjs';
import { createScratch, HARNESS_DIR, parseOptions, REPOSITORY_ROOT, stopOnInterrupt, TOY_EXPECTED, TOY_PORT_MAP, TOY_UNRECORDABLE } from './record.mjs';
import { commandEngine, judgeReplay, MODES, planContainers, readContainerDir, readRecording, recordReplayToys, REPLAY_FIXTURES, REPLAY_PORT_MAP, REPLAY_UNRECORDABLE, replayPlanned, reportLines } from './replay.mjs';

export const TOY_CENSUS = path.join(HARNESS_DIR, 'toy', 'census.json');
export const TOY_CONTRACT = path.join(HARNESS_DIR, 'toy', 'candidate-census.json');
export const PRODUCT_CONTRACT = path.join(HARNESS_DIR, 'product', 'product-candidate-census.json');
// The product's own setup is loaded only for `--product`, so this module loads without the product's (and a planted
// copy of the harness, which has no product next to it, loads it too).
const productSetup = async () => ({ ...(await import('./product.mjs')), ...(await import('./replay-product.mjs')) });
const DEFAULT_DEADLINE_MS = 300000;

/** The replayer's comparison under `rules`: what replay.mjs replayPlanned calls for each case. */
export const comparerFor = (rules) => (kase, replayed, options) => compareCandidate(kase, replayed, { ...options, rules });

/**
 * The toys' recording census as the candidate judgement reads it: the toy
 * census (its event sources and item waivers) with the toy fixtures (record.mjs
 * TOY_UNRECORDABLE, replay.mjs REPLAY_UNRECORDABLE) as its unrecordable waivers,
 * each by its test file, test name and flag.
 */
export function toyRecordingCensus(harnessDir = HARNESS_DIR) {
  const census = loadCensus(path.join(harnessDir, 'toy', 'census.json'));
  const relative = (file) => path.relative(REPOSITORY_ROOT, path.join(HARNESS_DIR, file)).split(path.sep).join('/');
  const unrecordable = [
    ...Object.entries(TOY_UNRECORDABLE).flatMap(([file, list]) => list.map(([test, flag]) => ({ file: relative(`toy/${file}`), test, flag, reason: 'a toy fixture of the recorder (record.mjs TOY_UNRECORDABLE)' }))),
    ...REPLAY_UNRECORDABLE.flatMap((item) => item.flags.map((flag) => ({ file: relative(`toy/replay/${item.file}`), test: item.name, flag, reason: 'a toy fixture of the replayer (replay.mjs REPLAY_UNRECORDABLE)' }))),
  ];
  return { ...census, unrecordable, unstable: [] };
}

/**
 * Replays `planned` with `engine` under `rules`, `repeat` times (`replay`
 * is replay.mjs replayPlanned; the self-test counts its calls). Resolves `{
 * result, repeats }`: the first run's result, and the cases it judged two ways
 * against a later run (lines).
 */
export async function replayRepeated(planned, { engine, rules, modes, repeat, concurrency, deadlineMs, capture = null, replay = replayPlanned }) {
  const results = [];
  const judged = comparerFor(rules);
  // `capture` is handed every case the exact rules reproduce, with the engine's answer (the full test's planted engines).
  const compare = capture ? (kase, replayed, options) => { const result = judged(kase, replayed, options); if (!result.exact && !result.differences.length) capture(kase, replayed, options); return result; } : judged;
  for (let run = 0; run < repeat; run += 1) results.push(await replay(planned, { engine, modes, concurrency, deadlineMs, compare }));
  return { result: results[0], repeats: results.length > 1 ? repeatDifferences(results) : [] };
}

/**
 * Judges one or more runs (a recording, its port map and planned containers,
 * the engine's results) as candidate-census.mjs says. `runs` `[{ label,
 * planned, result, repeats, portMap, scope, universe, requireFamilies,
 * expected, complete }]`. A run judged in some modes only (`modes` short of
 * MODES) is partial too: half of what each case is judged on (in file order
 * and alone) is skipped. Resolves `{ code, failures, inconclusive, unstable,
 * partial, skipped, census, unjudged }`: `skipped` what each partial run
 * left out (lines), asked for or not.
 */
export function judgeRuns(runs, { recordingCensus, contract, problems = [], modes = MODES, partial = false }) {
  const missingModes = MODES.filter((mode) => !modes.includes(mode));
  // The families whose cases the engine refused as not ported (it does not implement them): out of the judgement.
  const notPortedOf = (run) => [...new Set(run.result.cases.filter((kase) => kase.outcome === 'not-ported').map((kase) => kase.family))].sort();
  const skippedOf = (run) => [
    ...(run.complete === false ? [`${run.label} holds part of a recording only (${run.scope ? `families ${run.scope.join(', ')}` : 'a scope its manifest names'})`] : []),
    ...(missingModes.length ? [`${run.label} judged in mode ${modes.join(', ')} only, not ${missingModes.join(', ')}`] : []),
    ...(notPortedOf(run).length ? [`${run.label}: the engine does not implement families ${notPortedOf(run).join(', ')} (${run.result.cases.filter((kase) => kase.outcome === 'not-ported').length} cases not ported, not judged)`] : []),
  ];
  const whole = (run) => skippedOf(run).length === 0;
  const verdicts = [];
  const census = { failures: [], families: {} };
  const unjudged = { inconclusive: [], unstable: [], stale: [], waived: { unrecordable: 0, unstable: 0, 'not-replayable': 0 } };
  const repeats = [];
  for (const run of runs) {
    const notPorted = notPortedOf(run);
    verdicts.push(judgeReplay(run.result, { modes, expected: run.expected ?? [], requireFamilies: (run.requireFamilies ?? []).filter((family) => !notPorted.includes(family)), allowNotPorted: true }));
    const entries = casesWithRecords(run);
    const scope = (run.scope ?? run.portMap.families.map((family) => family.name)).filter((family) => !notPorted.includes(family));
    const judged = judgeUnjudged(entries, { recordingCensus: run.recordingCensus ?? recordingCensus, contract, complete: whole(run), scope });
    unjudged.inconclusive.push(...judged.inconclusive);
    unjudged.unstable.push(...judged.unstable);
    unjudged.stale.push(...judged.stale);
    for (const key of Object.keys(unjudged.waived)) unjudged.waived[key] += judged.waived[key];
    const counted = candidateCensus({ entries, universe: run.universe ?? null, portMap: run.portMap, recordingCensus: run.recordingCensus ?? recordingCensus, contract, scope, complete: whole(run) });
    census.failures.push(...counted.failures);
    Object.assign(census.families, counted.families);
    repeats.push(...(run.repeats ?? []));
  }
  // A contract entry for a family no run's port map has can never match: stale.
  const known = new Set(runs.flatMap((run) => run.portMap.families.map((family) => family.name)));
  if (runs.every((run) => whole(run) && run.scope === undefined)) {
    for (const item of contract.items) if (!known.has(item.family)) census.failures.push({ check: 'candidate-waiver-stale', family: item.family, name: item.name ?? '(family)', detail: `the candidate census waives ${item.kind} ${item.name ?? ''} of ${item.family}, which no port map has: remove the waiver` });
    for (const item of contract.unjudged) if (!known.has(item.family)) unjudged.stale.push(`candidate-waiver-stale: the unjudged waiver names ${item.family}, which no port map has: remove it`);
    for (const family of Object.keys(contract.judged)) if (!known.has(family)) census.failures.push({ check: 'candidate-waiver-stale', family, name: '(pin)', detail: `the candidate census pins ${family}, which no port map has: remove the pin` });
  }
  // A run that skipped part of the judgement is never a pass (S2 of the C0g reviews): not asked for, inconclusive by
  // these lines; asked for, exit 3 where what it judged passed (judgeCandidate).
  const skipped = runs.flatMap(skippedOf);
  const partialLines = partial ? [] : skipped.map((line) => `partial: ${line}: judge the whole recording in every mode, or ask for a partial run with --partial`);
  const verdict = judgeCandidate({ verdicts, census, unjudged, problems, repeats, partial: partialLines, asked: partial ? skipped : [] });
  return { ...verdict, skipped, census, unjudged, verdicts };
}

/** The toy run: the tracked toy corpus and a fresh recording of the replayer's own toys, judged as candidate-census.mjs says. */
export async function candidateToys({ workDir, engine, rules = 'candidate', modes = MODES, repeat = 1, concurrency, deadlineMs = DEFAULT_DEADLINE_MS, recording, contractFile = TOY_CONTRACT, root = REPOSITORY_ROOT, partial = false }) {
  const toyMap = loadPortMap(TOY_PORT_MAP, { root });
  const replayMap = loadPortMap(REPLAY_PORT_MAP, { root });
  const own = recording ?? await recordReplayToys({ workDir: path.join(workDir, 'record') });
  const problems = own.incomplete.map((entry) => `recording ${entry.check}: ${entry.detail}`);
  if (rules === 'candidate') problems.push(...engineMessagesBuilt(toyMap), ...engineMessagesBuilt(replayMap));
  const corpus = planContainers(readContainerDir(TOY_EXPECTED), toyMap);
  const mine = planContainers(own.containers.map((item) => ({ name: item.name, text: item.text })), replayMap);
  const given = engine ?? typescriptEngine({ cwd: root });
  const [first, second] = await Promise.all([
    replayRepeated(corpus, { engine: given, rules, modes, repeat, concurrency, deadlineMs }),
    replayRepeated(mine, { engine: given, rules, modes, repeat, concurrency, deadlineMs }),
  ]);
  first.result.problems.unshift(...corpus.problems);
  second.result.problems.unshift(...mine.problems);
  const runs = [
    { label: 'toy corpus', planned: corpus, ...first, portMap: toyMap },
    { label: 'replayer toys', planned: mine, ...second, portMap: replayMap, expected: REPLAY_FIXTURES },
  ];
  const judged = judgeRuns(runs, { recordingCensus: toyRecordingCensus(), contract: loadContract(contractFile), problems, modes, partial });
  return { runs, ...judged };
}

/**
 * What a recording directory's run is judged with, from what was read of it
 * (pure; the self-test calls it on fixed inputs): the problems of its
 * manifest (it must list what the directory holds, say the recording exited
 * 0, and carry the census items of every family it lists), whether it is
 * complete (the manifest names no scope and no `families` were chosen), and
 * the families that must have a judged case. Returns `{ problems, complete,
 * requireFamilies, universe }`.
 */
export function assembleFrom({ recording, families = null, requireAlso = [] }) {
  const problems = recording.problems.map((problem) => `${problem.check}${problem.container ? ` ${problem.container}` : ''}: ${problem.detail}`);
  const manifest = recording.manifest;
  if (manifest && !manifest.verdict) problems.push('manifest: the recording\'s manifest has no verdict, so whether the recording passed its own checks (its census among them) is unknown');
  if (manifest?.verdict && manifest.verdict.code !== EXIT.pass) problems.push(`manifest: the recording exited ${manifest.verdict.code} (${manifest.verdict.failures} failed checks, ${manifest.verdict.inconclusive} inconclusive problems, ${manifest.verdict.unstable} unstable cases): it is no reference`);
  if (manifest && !manifest.items) problems.push('manifest: the recording\'s manifest has no census items, so the items no case exercises are unknown');
  // Every family the manifest lists has its items (S3 of the C0g review): an empty or partial `items` is no universe.
  if (manifest?.items) for (const family of Object.keys(manifest.families ?? {})) if (!manifest.items[family]) problems.push(`manifest: the recording's manifest has no census items for family ${family}`);
  const complete = manifest?.scope === null && families === null;
  return { problems, complete, requireFamilies: [...new Set([...recording.requireFamilies, ...requireAlso])].sort(), universe: manifest?.items ?? null };
}

/** The problems of the mapped modules that build a native error with an engine-shaped message (`engine-message-built`). */
export function engineMessagesBuilt(portMap) {
  const problems = [];
  for (const file of new Set(portMap.families.map((family) => family.module))) {
    for (const item of builtEngineMessages(readFileSync(file, 'utf8'))) problems.push(`engine-message-built ${path.relative(REPOSITORY_ROOT, file)}: it builds a ${item.className} whose message "${item.message}" has the shape of one ${item.engines.join(' and ')} writes itself, which the engine-message freedom would free`);
  }
  return problems;
}

/**
 * A recording directory's run (assembleFrom), replayed with `engine`.
 * `partial` asks for a run of part of a recording (then not inconclusive for that).
 */
export async function candidateFrom({ directory, portMapFile, censusFile, contractFile, cwd, families = null, engine, rules = 'candidate', modes = MODES, repeat = 1, concurrency, deadlineMs = DEFAULT_DEADLINE_MS, requireAlso = [], capture = null, partial = false }) {
  const portMap = loadPortMap(portMapFile, { root: REPOSITORY_ROOT });
  const recordingCensus = loadCensus(censusFile);
  const contract = loadContract(contractFile);
  const recording = readRecording(directory, portMap, { families });
  const { problems, complete, requireFamilies, universe } = assembleFrom({ recording, families, requireAlso });
  const planned = planContainers(recording.list, portMap, { families });
  problems.push(...planned.problems.map((problem) => `${problem.check}${problem.container ? ` ${problem.container}` : ''}: ${problem.detail}`));
  // The engine-message freedom reads an engine's message shapes: a mapped module that builds a native error with a
  // message of such a shape would have it freed, so such a recording is no reference for a candidate (inconclusive).
  if (rules === 'candidate') problems.push(...engineMessagesBuilt(portMap));
  const { result, repeats } = await replayRepeated(planned, { engine: engine ?? typescriptEngine({ cwd }), rules, modes, repeat, concurrency, deadlineMs, capture });
  const scope = families ?? recording.manifest?.scope ?? undefined;
  const run = { label: path.basename(directory), planned, result, repeats, portMap, ...(scope ? { scope } : {}), universe, complete, requireFamilies };
  const judged = judgeRuns([run], { recordingCensus, contract, problems, modes, partial });
  return { runs: [run], ...judged };
}

const usage = 'usage: candidate.mjs --toys | --product [--from=<dir>] | --from=<dir> --port-map=<file> --census=<file> --contract=<file> [--cwd=<dir>]; [--engine=<file> [--engine-args=a,b]] [--rules=candidate|exact] [--families=a,b] [--partial] [--modes=file,isolated] [--repeat=N] [--json=<file>] [--concurrency=N] [--deadline-ms=N] [--keep-artifacts]';

export async function main(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
  const parsed = parseOptions(argv, { flags: ['toys', 'product', 'keep-artifacts', 'partial'], values: ['from', 'port-map', 'census', 'contract', 'cwd', 'families', 'modes', 'json', 'concurrency', 'deadline-ms', 'engine', 'engine-args', 'rules', 'repeat'] });
  if (parsed.error) { error(`${parsed.error}\n${usage}`); return EXIT.usage; }
  const { options, positionals } = parsed;
  const kinds = [options.toys === true, options.product === true, options.from !== undefined && options.product !== true].filter(Boolean).length;
  if (positionals.length || kinds !== 1) { error(usage); return EXIT.usage; }
  const rules = options.rules ?? 'candidate';
  if (!RULE_SETS.includes(rules)) { error(`--rules takes ${RULE_SETS.join(' or ')}\n${usage}`); return EXIT.usage; }
  const modes = options.modes ? options.modes.split(',').filter(Boolean) : [...MODES];
  if (modes.length === 0 || modes.some((mode) => !MODES.includes(mode))) { error(`--modes takes ${MODES.join(', ')}\n${usage}`); return EXIT.usage; }
  const number = (name, fallback) => { const value = options[name] !== undefined ? Number(options[name]) : fallback; return Number.isInteger(value) && value >= 1 ? value : null; };
  const concurrency = options.concurrency !== undefined ? number('concurrency') : undefined;
  const deadlineMs = number('deadline-ms', DEFAULT_DEADLINE_MS);
  const repeat = number('repeat', 1);
  if (concurrency === null || deadlineMs === null || repeat === null) { error(`--concurrency, --deadline-ms and --repeat take a positive integer\n${usage}`); return EXIT.usage; }
  if (options['engine-args'] !== undefined && !options.engine) { error(`--engine-args goes with --engine\n${usage}`); return EXIT.usage; }
  const families = options.families !== undefined ? options.families.split(',').filter(Boolean) : null;
  if (families !== null && (families.length === 0 || options.toys)) { error(`--families names at least one family, and not with --toys\n${usage}`); return EXIT.usage; }
  const plain = options.from !== undefined && !options.product;
  if (plain && (!options['port-map'] || !options.census || !options.contract)) { error(`--from needs --port-map, --census and --contract (or --product)\n${usage}`); return EXIT.usage; }
  if (!plain && (options['port-map'] || options.census || options.contract || options.cwd)) { error(`--port-map, --census, --contract and --cwd go with --from alone\n${usage}`); return EXIT.usage; }
  if (options.from !== undefined && (!existsSync(options.from) || !statSync(options.from).isDirectory())) { error(`--from needs a directory\n${usage}`); return EXIT.usage; }
  const product = options.product ? await productSetup() : null;
  const cwd = options.toys ? REPOSITORY_ROOT : product ? product.UI_DIR : path.resolve(options.cwd ?? REPOSITORY_ROOT);
  const engine = options.engine ? commandEngine(options.engine, { args: options['engine-args'] ? options['engine-args'].split(',') : [], cwd }) : null;
  let checked;
  try {
    if (plain) { const map = loadPortMap(path.resolve(options['port-map']), { root: REPOSITORY_ROOT }); loadCensus(path.resolve(options.census)); loadContract(path.resolve(options.contract)); for (const name of families ?? []) if (!map.families.some((family) => family.name === name)) throw new Error(`--families: ${name} is not a family of the port map`); }
    else if (options.toys) loadContract(TOY_CONTRACT);
    else { const map = loadPortMap(product.PRODUCT_PORT_MAP, { root: REPOSITORY_ROOT }); loadContract(PRODUCT_CONTRACT); for (const name of families ?? []) if (!map.families.some((family) => family.name === name)) throw new Error(`--families: ${name} is not a family of the product port map`); }
    checked = true;
  } catch (failure) { error(failure.message); return EXIT.usage; }
  if (!checked) return EXIT.usage;
  stopOnInterrupt();
  const scratch = (options.toys || (options.product && options.from === undefined)) ? createScratch('client-conformance-candidate', { keepArtifacts: options['keep-artifacts'] === true }) : null;
  let status = 'failed';
  try {
    let outcome;
    if (options.toys) outcome = await candidateToys({ workDir: scratch.dir, engine, rules, modes, repeat, concurrency, deadlineMs, partial: options.partial === true });
    else {
      let directory = options.from ? path.resolve(options.from) : null;
      const extra = [];
      if (!directory) {
        directory = path.join(scratch.dir, 'containers');
        const recorded = await product.recordProduct({ workDir: path.join(scratch.dir, 'record'), out: directory, families });
        log(`recording: exit ${recorded.code}; ${recorded.report.cases} cases (${recorded.report.outcomes.recorded} recorded, ${recorded.report.outcomes.unrecordable} unrecordable, ${recorded.report.outcomes.inconclusive} inconclusive), ${recorded.report.unstableCases.length} unstable, ${recorded.report.files} files`);
      }
      const setup = options.product
        ? { portMapFile: product.PRODUCT_PORT_MAP, censusFile: product.PRODUCT_CENSUS, contractFile: PRODUCT_CONTRACT, cwd: product.UI_DIR, requireAlso: product.requiredFamilies(loadPortMap(product.PRODUCT_PORT_MAP, { root: REPOSITORY_ROOT }), families) }
        : { portMapFile: path.resolve(options['port-map']), censusFile: path.resolve(options.census), contractFile: path.resolve(options.contract), cwd, requireAlso: extra };
      outcome = await candidateFrom({ directory, ...setup, families, engine, rules, modes, repeat, concurrency, deadlineMs, partial: options.partial === true });
    }
    for (const line of outcome.inconclusive) error(`inconclusive: ${line}`);
    for (const line of outcome.unstable) error(`unstable: ${line}`);
    for (const line of outcome.failures) error(`different: ${line}`);
    outcome.runs.forEach((run, index) => { for (const line of reportLines(run.result, outcome.verdicts[index], modes)) log(`${run.label}: ${line}`); });
    for (const line of censusLines(outcome.census)) log(line);
    const freedoms = {};
    for (const run of outcome.runs) for (const kase of run.result.cases) for (const entry of Object.values(kase.modes)) for (const name of entry.freedoms ?? []) freedoms[name] = (freedoms[name] ?? 0) + 1;
    const waived = outcome.unjudged.waived;
    for (const run of outcome.runs) if (run.result.engine?.families) log(`${run.label}: engine ${run.result.engine.name} implements ${run.result.engine.families.length} families: ${run.result.engine.families.join(', ')}`);
    const notPorted = outcome.runs.reduce((sum, run) => sum + run.result.cases.filter((kase) => kase.outcome === 'not-ported').length, 0);
    // A run that skipped part of the judgement says so first, and what it skipped, on its last line (never exit 0).
    const passedPart = options.partial && outcome.code === EXIT.inconclusive && !outcome.inconclusive.length;
    const partial = !outcome.skipped.length ? '' : `, ${passedPart ? 'partial pass (asked for with --partial), not a complete pass' : options.partial ? 'partial run (asked for with --partial)' : 'partial run not asked for'}: ${outcome.skipped.join('; ')}`;
    log(`candidate (${rules} rules${partial}): ${outcome.runs.reduce((sum, run) => sum + run.result.cases.filter((kase) => kase.outcome === 'reproduced').length, 0)} reproduced; not judged and waived by name: ${waived.unrecordable} unrecordable, ${waived.unstable} unstable, ${waived['not-replayable']} not replayable; ${notPorted} not ported; freedoms used ${Object.keys(freedoms).length ? Object.entries(freedoms).map(([name, count]) => `${name} ${count}`).join(', ') : 'none'}; ${outcome.failures.length} differences or failed checks, ${outcome.unstable.length} unstable, ${outcome.inconclusive.length} inconclusive problems; exit ${outcome.code}`);
    if (options.json) writeFileSync(options.json, `${JSON.stringify({ code: outcome.code, rules, complete: !outcome.skipped.length, skipped: outcome.skipped, failures: outcome.failures, unstable: outcome.unstable, inconclusive: outcome.inconclusive, census: outcome.census, waived, runs: outcome.runs.map((run) => ({ label: run.label, cases: run.result.cases })) }, null, 2)}\n`);
    status = outcome.code === EXIT.pass || passedPart ? 'passed' : 'failed';
    return outcome.code;
  } catch (failure) {
    error(`inconclusive: ${failure.stack ?? failure.message}`);
    return EXIT.inconclusive;
  } finally {
    scratch?.finish(status);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
