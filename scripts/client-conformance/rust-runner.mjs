#!/usr/bin/env node
// The Rust engine of the client engine conformance harness, judged (package
// C0i; docs/TESTING.md, "The Rust runner"): the families the Rust runner
// (packages/native/crates/client-engine-runner) implements, judged on the
// product recording by the candidate rules and by the exact rules, each
// family's reproduced cases held to the product contract's pin (the number
// of cases the TypeScript engine reproduces); with `--plants`, every planted
// difference of the Rust families (the runner's `--plant=<id>`) run on its
// family and reported with the cases it made different, or as escaped (a gap
// in the product's tests, listed, never fixed here); with `--measure`, the
// time per case, CPU and peak resident memory of the Rust runner against the
// TypeScript engine on the same cases, arms alternated, with the load
// average before each run.
//
//   node scripts/client-conformance/rust-runner.mjs [--from=<recording directory>] [--runner=<binary>] [--build] [--families=a,b] [--plants[=id,id]] [--measure[=rounds]] [--json=<file>] [--keep-artifacts]
//
// Without `--from` the product is recorded first, into scratch. `--build`
// builds the runner first (release, with the pinned toolchain, into
// packages/native/target); without it `--runner` (default that release
// binary) must exist. Exit codes: 0 when every implemented family (or those
// named) reproduces exactly its pinned cases under both rules and every
// planted difference asked for ran to a verdict (an escaped one is reported,
// not a failure); 1 a difference, a pin not met or a plant that left a case
// inconclusive; 3 inconclusive (the recording, the runner or a run could not
// be judged); 64 usage. This is no complete candidate pass: the families the
// runner does not implement are not judged, and the last line names them.
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { EXIT, loadContract } from './candidate-census.mjs';
import { assembleFrom, judgeRuns, PRODUCT_CONTRACT, replayRepeated } from './candidate.mjs';
import { loadCensus } from './census.mjs';
import { typescriptEngine } from './engine.mjs';
import { loadPortMap } from './port-map.mjs';
import { createScratch, parseOptions, REPOSITORY_ROOT, stopOnInterrupt } from './record.mjs';
import { commandEngine, planContainers, readRecording } from './replay.mjs';

export const NATIVE_DIR = path.join(REPOSITORY_ROOT, 'packages', 'native');
export const DEFAULT_RUNNER = path.join(NATIVE_DIR, 'target', 'release', 'client-engine-runner');
const BUILD_DEADLINE_MS = 900000;
const LIST_DEADLINE_MS = 30000;
// At most two heavy children at once (each plant run starts a runner).
const PLANTS_AT_ONCE = 2;
const usage = 'usage: rust-runner.mjs [--from=<recording directory>] [--runner=<binary>] [--build] [--families=a,b] [--plants[=id,id]] [--measure[=rounds]] [--json=<file>] [--keep-artifacts]';

/** Builds the runner in release mode with the pinned toolchain; resolves its path. */
export async function buildRunner() {
  const { locateNativeToolchain, readNativeToolchain } = await import('../check-native.mjs');
  const { bin } = locateNativeToolchain(readNativeToolchain());
  const built = spawnSync(path.join(bin, 'cargo'), ['build', '--release', '--locked', '--offline', '-p', 'devryan-client-engine-runner'], {
    cwd: NATIVE_DIR, encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` }, timeout: BUILD_DEADLINE_MS, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
  });
  if (built.error || built.status !== 0) throw new Error(`cargo build of the Rust runner failed (${built.error?.message ?? `exit ${built.status ?? built.signal}`}):\n${String(built.stderr ?? '').slice(-4000)}`);
  return DEFAULT_RUNNER;
}

/** The planted differences the runner holds: `[{ id, family, change }]` (`--plants`). */
export function listPlants(runner) {
  const listed = spawnSync(runner, ['--plants'], { encoding: 'utf8', timeout: LIST_DEADLINE_MS, killSignal: 'SIGKILL' });
  if (listed.error || listed.status !== 0) throw new Error(`the Rust runner did not list its planted differences (${listed.error?.message ?? `exit ${listed.status ?? listed.signal}`})`);
  return listed.stdout.split('\n').filter(Boolean).map((line) => { const [id, family, change] = line.split('\t'); return { id, family, change }; });
}

/** The families the runner implements, as its `hello` answer names them. */
export function implementedFamilies(runner) {
  const asked = spawnSync(runner, [], { input: '{"id":1,"op":"hello","protocol":5}\n{"id":2,"op":"stop"}\n', encoding: 'utf8', timeout: LIST_DEADLINE_MS, killSignal: 'SIGKILL' });
  if (asked.error || asked.status !== 0) throw new Error(`the Rust runner did not answer hello (${asked.error?.message ?? `exit ${asked.status ?? asked.signal}`})`);
  const hello = JSON.parse(asked.stdout.split('\n')[0]);
  if (!hello.ok || hello.protocol !== 5 || !Array.isArray(hello.families)) throw new Error(`the Rust runner's hello is not protocol 5 with its families: ${asked.stdout.split('\n')[0]}`);
  return hello.families;
}

/**
 * One judgement of `families` of a recording read once (`setup`), with
 * `engine`, by `rules`: resolves `{ code, run, judged }` (judgeRuns' verdict,
 * asked for as a partial run).
 */
export async function judgeFamilies(setup, { engine, families, rules = 'candidate', concurrency }) {
  const { recording, portMap, recordingCensus, contract } = setup;
  const scoped = { ...recording, requireFamilies: [...families].sort() };
  const { problems, complete, requireFamilies, universe } = assembleFrom({ recording: scoped, families });
  const planned = planContainers(recording.list, portMap, { families });
  problems.push(...planned.problems.map((problem) => `${problem.check}${problem.container ? ` ${problem.container}` : ''}: ${problem.detail}`));
  const { result, repeats } = await replayRepeated(planned, { engine, rules, modes: ['file', 'isolated'], repeat: 1, concurrency, deadlineMs: 300000 });
  const run = { label: 'product', planned, result, repeats, portMap, scope: families, universe, complete, requireFamilies };
  const judged = judgeRuns([run], { recordingCensus, contract, problems, partial: true });
  return { run, judged };
}

/** Per family: cases, judged (reproduced, different, inconclusive), not judged, against the contract's pin. */
export function familyRows(run, families, contract) {
  const rows = {};
  for (const family of families) rows[family] = { cases: 0, reproduced: 0, different: 0, inconclusive: 0, notJudged: 0, pinned: contract.judged[family]?.cases ?? null };
  for (const kase of run.result.cases) {
    const row = rows[kase.family];
    if (!row) continue;
    row.cases += 1;
    if (kase.outcome === 'reproduced') row.reproduced += 1;
    else if (kase.outcome === 'different') row.different += 1;
    else if (kase.outcome === 'inconclusive' || kase.outcome === 'not-ported') row.inconclusive += 1;
    else row.notJudged += 1;
  }
  return rows;
}

/** The peak resident memory (bytes) and CPU seconds `time` printed for a process, from its stderr. */
export function parseTime(text) {
  const darwinRss = /(\d+)\s+maximum resident set size/.exec(text);
  const linuxRss = /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(text);
  const darwinCpu = /([\d.]+)\s+real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys/.exec(text);
  const linuxUser = /User time \(seconds\):\s*([\d.]+)/.exec(text);
  const linuxSys = /System time \(seconds\):\s*([\d.]+)/.exec(text);
  return {
    rss: darwinRss ? Number(darwinRss[1]) : linuxRss ? Number(linuxRss[1]) * 1024 : null,
    cpu: darwinCpu ? Number(darwinCpu[2]) + Number(darwinCpu[3]) : linuxUser && linuxSys ? Number(linuxUser[1]) + Number(linuxSys[1]) : null,
  };
}

/** An engine run under `/usr/bin/time` (its own resource use on stderr). */
const timed = (engine) => ({ ...engine, command: '/usr/bin/time', args: [process.platform === 'darwin' ? '-l' : '-v', engine.command, ...engine.args] });

export async function main(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
  const parsed = parseOptions(argv, { flags: ['build', 'keep-artifacts', 'plants', 'measure'], values: ['from', 'runner', 'families', 'json', 'plants', 'measure'] });
  if (parsed.error || parsed.positionals.length) { error(`${parsed.error ?? 'no positional arguments'}\n${usage}`); return EXIT.usage; }
  const { options } = parsed;
  const rounds = options.measure === undefined ? 0 : options.measure === true ? 3 : Number(options.measure);
  if (!Number.isInteger(rounds) || rounds < 0) { error(`--measure takes a number of rounds\n${usage}`); return EXIT.usage; }
  if (options.from !== undefined && !existsSync(options.from)) { error(`--from needs a recording directory\n${usage}`); return EXIT.usage; }
  stopOnInterrupt();
  const scratch = createScratch('client-conformance-rust', { keepArtifacts: options['keep-artifacts'] === true });
  let status = 'failed';
  try {
    const product = { ...(await import('./product.mjs')), ...(await import('./replay-product.mjs')) };
    const runner = options.build ? await buildRunner() : path.resolve(options.runner ?? DEFAULT_RUNNER);
    if (!existsSync(runner)) { error(`inconclusive: no Rust runner at ${runner}: build it with --build, or (in packages/native, with the pinned toolchain) cargo build --release --locked -p devryan-client-engine-runner`); return EXIT.inconclusive; }
    const portMap = loadPortMap(product.PRODUCT_PORT_MAP, { root: REPOSITORY_ROOT });
    // The product families it implements (the runner also implements harness toys, judged with candidate.mjs --toys).
    const implemented = implementedFamilies(runner).filter((family) => portMap.families.some((item) => item.name === family));
    const named = options.families ? options.families.split(',').filter(Boolean) : implemented;
    const unknown = named.filter((family) => !implemented.includes(family));
    if (unknown.length) { error(`--families: the Rust runner does not implement ${unknown.join(', ')} (it implements ${implemented.join(', ')})\n${usage}`); return EXIT.usage; }
    let directory = options.from ? path.resolve(options.from) : null;
    if (!directory) {
      directory = path.join(scratch.dir, 'containers');
      const recorded = await product.recordProduct({ workDir: path.join(scratch.dir, 'record'), out: directory });
      log(`recording: exit ${recorded.code}; ${recorded.report.cases} cases`);
      if (recorded.code !== EXIT.pass) { error('inconclusive: the product recording did not pass its own checks'); return EXIT.inconclusive; }
    }
    const setup = { recording: readRecording(directory, portMap), portMap, recordingCensus: loadCensus(product.PRODUCT_CENSUS), contract: loadContract(PRODUCT_CONTRACT) };
    if (setup.recording.problems.length) { for (const problem of setup.recording.problems) error(`inconclusive: ${problem.check}: ${problem.detail}`); return EXIT.inconclusive; }
    const rust = commandEngine(runner, { cwd: product.UI_DIR });
    const report = { runner, implemented, families: {}, rules: {}, plants: [], measure: [] };
    const failures = [];
    const inconclusive = [];
    // 1. The judgement, by both rule sets: every judged case of each family reproduced, and as many as its pin. The Rust
    // writes its own text for an error the JavaScript engine throws itself, so under the exact rules (the TypeScript
    // closure's, which compare that text) a case the candidate rules reproduce by the `engine-message` freedom alone
    // differs by design: it is counted apart (`engine-written`), never as reproduced, and every other difference fails.
    const keyOf = (kase) => `${kase.container}\0${kase.id}`;
    let engineWritten = new Set();
    for (const rules of ['candidate', 'exact']) {
      const { run, judged } = await judgeFamilies(setup, { engine: rust, families: named, rules });
      if (rules === 'candidate') engineWritten = new Set(run.result.cases.filter((kase) => kase.outcome === 'reproduced' && Object.values(kase.modes).some((entry) => (entry.freedoms ?? []).length) && Object.values(kase.modes).every((entry) => (entry.freedoms ?? []).every((name) => name === 'engine-message'))).map(keyOf));
      const excused = rules === 'exact' ? run.result.cases.filter((kase) => kase.outcome === 'different' && engineWritten.has(keyOf(kase))) : [];
      const rows = familyRows(run, named, setup.contract);
      for (const kase of excused) { rows[kase.family].different -= 1; rows[kase.family].engineWritten = (rows[kase.family].engineWritten ?? 0) + 1; }
      report.rules[rules] = { code: judged.code, rows, failures: judged.failures, inconclusive: judged.inconclusive };
      for (const line of judged.inconclusive) inconclusive.push(`${rules} rules: ${line}`);
      const excusedIds = new Set(excused.map((kase) => kase.id));
      for (const line of judged.failures) if (![...excusedIds].some((id) => line.includes(id))) failures.push(`${rules} rules: ${line}`);
      for (const [family, row] of Object.entries(rows)) {
        const written = row.engineWritten ?? 0;
        log(`${rules} rules: ${family}: ${row.cases} cases, ${row.reproduced + row.different + row.inconclusive + written} judged: ${row.reproduced} reproduced, ${row.different} different${written ? `, ${written} differing only by engine-written messages (reproduced under the candidate rules)` : ''}, ${row.inconclusive} inconclusive; ${row.notJudged} not judged (as recorded); pinned ${row.pinned}`);
        if (row.pinned === null || row.reproduced + written !== row.pinned || row.different || row.inconclusive) failures.push(`${rules} rules: ${family} reproduced ${row.reproduced} cases, ${row.different} different, ${row.inconclusive} inconclusive; the contract pins ${row.pinned}`);
      }
      if (!judged.inconclusive.length && judged.code !== EXIT.inconclusive && judged.code !== EXIT.fail) failures.push(`${rules} rules: a partial run exited ${judged.code}, never 3`);
    }
    report.families = report.rules.candidate.rows;
    const others = portMap.families.map((family) => family.name).filter((family) => !implemented.includes(family));
    // 2. The planted differences, each on its own family.
    if (options.plants !== undefined) {
      const wanted = options.plants === true ? null : options.plants.split(',').filter(Boolean);
      // A plant of the JavaScript semantics (`js`) or of the runner itself (`runner`) runs on every judged family; a
      // plant of a toy family is proven on the toys (candidate.mjs --toys), never here.
      const shared = (plant) => plant.family === 'js' || plant.family === 'runner';
      const plants = listPlants(runner).filter((plant) => (wanted ? wanted.includes(plant.id) : named.includes(plant.family) || shared(plant)));
      if (wanted && plants.length !== wanted.length) { error(`--plants: no planted difference named ${wanted.filter((id) => !plants.some((plant) => plant.id === id)).join(', ')}`); return EXIT.usage; }
      for (let at = 0; at < plants.length; at += PLANTS_AT_ONCE) {
        const batch = await Promise.all(plants.slice(at, at + PLANTS_AT_ONCE).map(async (plant) => {
          const engine = commandEngine(runner, { args: [`--plant=${plant.id}`], cwd: product.UI_DIR });
          const { run } = await judgeFamilies(setup, { engine, families: shared(plant) ? named : [plant.family], concurrency: 1 });
          const different = run.result.cases.filter((kase) => kase.outcome === 'different').map((kase) => kase.id);
          const lost = run.result.cases.filter((kase) => kase.outcome === 'inconclusive').map((kase) => kase.id);
          return { ...plant, caught: different.length > 0, different, inconclusive: lost };
        }));
        report.plants.push(...batch);
      }
      for (const plant of report.plants) {
        log(`plant ${plant.id} (${plant.family}): ${plant.caught ? `caught by ${plant.different.length} cases, first ${plant.different[0]}` : 'ESCAPED: no case comes out different'}${plant.inconclusive.length ? `; ${plant.inconclusive.length} inconclusive` : ''}`);
        if (plant.inconclusive.length) failures.push(`plant ${plant.id} left ${plant.inconclusive.length} cases inconclusive, first ${plant.inconclusive[0]}`);
      }
    }
    // 3. Time and memory, the TypeScript engine and the Rust runner on the same cases, arms alternated.
    for (let round = 0; round < rounds; round += 1) {
      for (const family of named) {
        for (const [arm, engine] of [['typescript', typescriptEngine({ cwd: product.UI_DIR })], ['rust', rust]]) {
          const load = loadavg()[0];
          const started = performance.now();
          const { run } = await judgeFamilies(setup, { engine: timed(engine), families: [family], concurrency: 1 });
          const wall = performance.now() - started;
          const judgedCases = run.result.cases.filter((kase) => kase.outcome === 'reproduced').length;
          const { rss, cpu } = parseTime(run.result.engineStderr ?? '');
          report.measure.push({ round: round + 1, family, arm, cases: judgedCases, wallMs: wall, msPerCase: judgedCases ? wall / judgedCases : null, cpuSeconds: cpu, rssBytes: rss, load });
          log(`measure round ${round + 1}: ${family} ${arm}: ${judgedCases} cases, ${(wall / Math.max(1, judgedCases)).toFixed(2)} ms per case (${wall.toFixed(0)} ms), CPU ${cpu ?? '?'} s, peak RSS ${rss === null ? '?' : `${(rss / 1048576).toFixed(1)} MB`}, load ${load.toFixed(2)}`);
        }
      }
    }
    for (const line of inconclusive) error(`inconclusive: ${line}`);
    for (const line of failures) error(`different: ${line}`);
    const code = inconclusive.length ? EXIT.inconclusive : failures.length ? EXIT.fail : EXIT.pass;
    const escaped = report.plants.filter((plant) => !plant.caught).length;
    if (options.json) writeFileSync(options.json, `${JSON.stringify({ code, ...report }, null, 2)}\n`);
    log(`rust runner: ${named.length} of ${portMap.families.length} families judged (${Object.values(report.families).reduce((sum, row) => sum + row.reproduced, 0)} cases reproduced under both rules), not implemented: ${others.join(', ') || 'none'}${report.plants.length ? `; ${report.plants.length} planted differences, ${report.plants.length - escaped} caught, ${escaped} escaped` : ''}; not a complete candidate pass; exit ${code}`);
    status = code === EXIT.pass ? 'passed' : 'failed';
    return code;
  } catch (failure) {
    error(`inconclusive: ${failure.stack ?? failure.message}`);
    return EXIT.inconclusive;
  } finally {
    scratch.finish(status);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
