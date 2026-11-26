// Checks of the family command (family-run.mjs: the product's recording
// command, set up for the toys here, so the self-test reaches no product
// file). Most replay two recordings of the toy corpus that the caller hands
// in (`recordings`), changed where a check needs it; `family-discovery`
// records a fixture tree in scratch end to end (discovery, plain runs, two
// recordings). Each check names what it proves; `familyChecks()` returns the
// ones that fail. Everything is imported from this directory, so a copy of
// the harness checks its own command.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringifyTree } from './codec.mjs';
import { createContainerWriter, readContainer } from './container.mjs';
import { familyCommand, recordFamilies } from './family-run.mjs';
import { checkManifest, MANIFEST_FILE, readManifestText } from './manifest.mjs';
import { EXIT, REPOSITORY_ROOT } from './record.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOY = path.join(HERE, 'toy');
const TOY_PREFIX = 'scripts/client-conformance/toy/';
/** The toy modules a product would reach: everything but the tests and the helper the naming rule does not call test code. */
const TOY_ENGINE = ['toy-clock.mjs', 'toy-flow.mjs', 'toy-gate.mjs', 'toy-guard.mjs', 'toy-host.mjs', 'toy-log.mjs', 'toy-reducer.mjs', 'toy-sched.mjs', 'toy-timers.mjs', 'toy-transport.mjs'].map((name) => TOY_PREFIX + name);
// What the toy recordings pass through (toy-host, toy-sched, toy-fixtures, the two no-frame calls): any change is a change of the caller rule.
export const TOY_PASSED = Object.freeze({ calls: 14, nested: 1, noFrame: 2, ports: 2, portsNested: 1 });

/** The exports the toy census judges per family (census.mjs censusItems, written into a recording's manifest): a change is a change of the census. */
export const TOY_ITEM_EXPORTS = Object.freeze({
  'toy-reducer': ['applyEvent', 'createState'], 'toy-timers': ['createDebouncer'], 'toy-transport': ['connect'], 'toy-flow': ['createFlow'], 'toy-guard': ['deferred', 'guard'],
  'toy-gate': ['arm', 'ask', 'drainOpen', 'eager', 'eagerLater', 'frozenControls', 'items', 'meter', 'nested', 'poke', 'promiseLike', 'signal', 'signalResolvers', 'start', 'subscribe', 'wait', 'waitDeep', 'waitLong', 'waitOn', 'waitResolvers'],
  'toy-clock': ['later', 'online', 'ping', 'readClock', 'roll'], 'toy-sched': ['after', 'later', 'seed', 'sinkLater', 'sinkTo', 'visit', 'whenSettled', 'withCallback'],
});

const clone = (recording) => ({ ...recording, incomplete: [...recording.incomplete], containers: recording.containers.map((container) => ({ ...container })) });

/** A toy setup whose recordings are `recordings[run - 1]`, changed by `change(recording, run)`. */
function toySetup(recordings, { census, reachableFixtures = false, change = () => {}, seen = null } = {}) {
  return {
    portMapFile: path.join(TOY, 'port-map.json'), censusFile: census ?? path.join(TOY, 'census.json'), cwd: REPOSITORY_ROOT, root: REPOSITORY_ROOT, always: [], search: [], scope: TOY_PREFIX,
    reachable: () => new Set([...TOY_ENGINE, ...(reachableFixtures ? [`${TOY_PREFIX}toy-fixtures.mjs`] : [])]),
    recordRun: async ({ run, required }) => { if (seen) seen.push(required); const recording = clone(recordings[run - 1]); change(recording, run); return recording; },
  };
}
/** A census file in `dir`: the toy census with `edit(census)` applied. */
function censusWith(dir, name, edit) {
  const census = JSON.parse(readFileSync(path.join(TOY, 'census.json'), 'utf8'));
  edit(census);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify(census));
  return file;
}
const run = (setup, options = {}) => recordFamilies({ setup, workDir: options.workDir, ...options });
const checks = (list) => list.map(({ check }) => check);
/** The first case of the first container with another seed: the recording then differs from the other in that case alone. */
function perturb(recording) {
  const [first] = recording.containers;
  const read = readContainer(first.text);
  const writer = createContainerWriter(read.header, { table: new Map([...read.values].map(([hash, tree]) => [hash, stringifyTree(tree)])) });
  read.cases.forEach((record, index) => writer.addCase(index === 0 ? { ...record, seed: 'perturbed' } : record));
  recording.containers[0] = { ...first, text: writer.toText() };
}

/**
 * The fixture tree of `family-discovery`: one family module, a test beside it,
 * a test that reaches it only through a re-export, one through a dynamic
 * import, one that does not reach it, one that reaches it only through engine
 * code (its calls are passed through: no case), one that reaches it only
 * through a helper that is neither test code by the naming rule nor reached by
 * the product (test support code under another name: kept, and the run is
 * inconclusive and names it), and one whose only use is a call with no frame
 * (kept; its case is unrecordable `no-frame`, waived by the fixture census).
 */
function writeFixture(root) {
  const write = (file, text) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); };
  write('ui/src/sync/m.mjs', 'export function f(value) { return value + 1; }\n');
  write('ui/src/sync/m.test.mjs', "import { expect, test } from 'bun:test';\nimport { f } from './m.mjs';\ntest('beside', () => { expect(f(1)).toBe(2); });\n");
  write('ui/src/lib/barrel.mjs', "export { f } from '../sync/m.mjs';\n");
  write('ui/src/lib/a.test.mjs', "import { expect, test } from 'bun:test';\nimport { f } from './barrel.mjs';\ntest('through a re-export', () => { expect(f(2)).toBe(3); });\n");
  write('ui/src/lib/b.test.mjs', "import { expect, test } from 'bun:test';\ntest('no family', () => { expect(1).toBe(1); });\n");
  write('ui/src/lib/c.test.mjs', "import { expect, test } from 'bun:test';\nconst { f } = await import('../sync/m.mjs');\ntest('through a dynamic import', () => { expect(f(3)).toBe(4); });\n");
  write('ui/src/lib/user.mjs', "import { f } from '../sync/m.mjs';\nexport function render(value) { const shown = f(value); return `shown ${shown}`; }\n");
  write('ui/src/lib/d.test.mjs', "import { expect, test } from 'bun:test';\nimport { render } from './user.mjs';\ntest('renders through engine code only', () => { expect(render(4)).toBe('shown 5'); });\n");
  write('ui/src/lib/fixtureBuilders.mjs', "import { f } from '../sync/m.mjs';\nexport function build(value) { const built = f(value); return { built }; }\n");
  write('ui/src/lib/e.test.mjs', "import { expect, test } from 'bun:test';\nimport { build } from './fixtureBuilders.mjs';\ntest('through a helper of another name', () => { expect(build(5)).toEqual({ built: 6 }); });\n");
  write('ui/src/lib/g.test.mjs', "import { expect, test } from 'bun:test';\nimport { f } from './barrel.mjs';\ntest('only with no frame', async () => { expect(await Promise.resolve(6).then(f)).toBe(7); });\n");
  write('map.json', JSON.stringify({ version: 1, families: [{ name: 'm', module: 'ui/src/sync/m.mjs', allExports: true }] }));
  write('census.json', JSON.stringify({ version: 1, unrecordable: [{ file: 'ui/src/lib/g.test.mjs', test: 'only with no frame', flag: 'no-frame', family: 'm', reason: 'the fixture of a test whose only family use has no frame' }] }));
}

/** [name, async (context) => true when the command behaves]. `context`: `{ recordings, dir(name) }`. */
export const FAMILY_CHECKS = Object.freeze([
  ['family-pass', async ({ recordings, dir }) => {
    // The toy corpus judged as a product recording passes once its fixture helper counts as reached, with every count in the report.
    const { code, report } = await run(toySetup(recordings, { reachableFixtures: true }), { workDir: dir('pass') });
    const cases = recordings[0].containers.reduce((sum, container) => sum + container.cases, 0);
    return code === EXIT.pass && report.failures.length === 0 && report.incomplete.length === 0 && report.cases === cases && report.containers === recordings[0].containers.length
      && report.outcomes.recorded + report.outcomes.unrecordable === cases && report.outcomes.unrecordable === recordings[0].outcomes.unrecordable && report.steps > cases && report.changeSetsChecked >= 17;
  }],
  ['family-unclassified-caller', async ({ recordings, dir }) => {
    // A passed-through caller under the scope that is no test code by the naming rule and that nothing reaches: inconclusive, named.
    const { code, report } = await run(toySetup(recordings), { workDir: dir('caller') });
    return code === EXIT.inconclusive && report.incomplete.length === 1 && report.incomplete[0].check === 'caller-unclassified' && report.incomplete[0].file === `${TOY_PREFIX}toy-fixtures.mjs`;
  }],
  ['family-passed-totals', async ({ recordings, dir }) => {
    // Every passed-through call is counted, inside pass-through calls and with no frame too, per caller file, and the last line shows the totals.
    const lines = [];
    const code = await familyCommand([], toySetup(recordings, { reachableFixtures: true }), { log: (line) => lines.push(line), error: () => {} });
    void dir;
    const last = lines.at(-1) ?? '';
    const totals = `passed through ${TOY_PASSED.calls} calls (${TOY_PASSED.nested} inside pass-through calls, ${TOY_PASSED.noFrame} with no frame) and ${TOY_PASSED.ports} port uses (${TOY_PASSED.portsNested} inside pass-through calls)`;
    return code === EXIT.pass && last.includes(totals) && lines.some((line) => line.startsWith(`passed-through caller ${TOY_PREFIX}toy-host.mjs: 8 calls, 1 port uses`))
      && lines.some((line) => line === 'passed through, toy-reducer: applyEvent 7, createState 1') && lines.some((line) => line.startsWith('passed-through caller <no frame>: 2 calls'));
  }],
  ['family-exit-precedence', async ({ recordings, dir }) => {
    // Inconclusive over unstable over fail over pass; a problem of the second recording counts and is named so.
    const stale = censusWith(dir('precedence'), 'stale', (census) => { census.exports.push({ family: 'toy-reducer', export: 'gone', reason: 'planted' }); });
    const fail = await run(toySetup(recordings, { census: stale, reachableFixtures: true }), { workDir: dir('fail') });
    const unstable = await run(toySetup(recordings, { census: stale, reachableFixtures: true, change: (recording, index) => { if (index === 2) perturb(recording); } }), { workDir: dir('unstable') });
    const lost = await run(toySetup(recordings, { census: stale, reachableFixtures: true, change: (recording, index) => { if (index === 2) { perturb(recording); recording.incomplete.push({ check: 'bun-exit', detail: 'bun exited 1' }); } } }), { workDir: dir('lost') });
    return fail.code === EXIT.fail && checks(fail.report.failures).join() === 'waiver-stale' && unstable.code === EXIT.unstable && unstable.report.unstableCases.length > 0
      && lost.code === EXIT.inconclusive && lost.report.incomplete.some((entry) => entry.check === 'bun-exit' && entry.detail.startsWith('recording 2:'));
  }],
  ['family-census-problems', async ({ recordings, dir }) => {
    // A census problem (an event source whose entry is not found) makes the run inconclusive.
    const census = censusWith(dir('problems'), 'events', (value) => { value.events.push({ family: 'toy-gate', entry: 'missingEntry', arg: 0 }); });
    const { code, report } = await run(toySetup(recordings, { census, reachableFixtures: true }), { workDir: dir('problems-run') });
    return code === EXIT.inconclusive && report.incomplete.some((entry) => entry.check === 'census-events');
  }],
  ['family-targets-scope', async ({ recordings, dir }) => {
    // With chosen test files nothing is stale and nothing fails for being unexercised; on a whole run the same waivers fail.
    const census = censusWith(dir('targets'), 'stale', (value) => {
      value.exports.push({ family: 'toy-reducer', export: 'gone', reason: 'planted' });
      value.unrecordable.push({ file: `${TOY_PREFIX}toy-reducer.toy.mjs`, test: 'no such test', flag: 'accessor', reason: 'planted' });
    });
    const whole = await run(toySetup(recordings, { census, reachableFixtures: true }), { workDir: dir('targets-whole') });
    const chosen = await run(toySetup(recordings, { census, reachableFixtures: true }), { workDir: dir('targets-chosen'), targets: [`${TOY_PREFIX}toy-reducer.toy.mjs`] });
    return whole.code === EXIT.fail && whole.report.failures.length === 2 && whole.report.failures.every((entry) => entry.check === 'waiver-stale')
      && chosen.code === EXIT.pass && chosen.report.complete === false && chosen.report.failures.length === 0;
  }],
  ['family-families-scope', async ({ recordings, dir }) => {
    // --families scopes every judgement: another family's stale waiver is not this run's; the asked family's is.
    const census = censusWith(dir('families'), 'other', (value) => { value.exports.push({ family: 'toy-gate', export: 'gone', reason: 'planted' }); });
    const reducer = await run(toySetup(recordings, { census, reachableFixtures: true }), { workDir: dir('families-reducer'), families: ['toy-reducer'] });
    const gate = await run(toySetup(recordings, { census, reachableFixtures: true }), { workDir: dir('families-gate'), families: ['toy-gate'] });
    return reducer.code === EXIT.pass && Object.keys(reducer.report.families).join() === 'toy-reducer' && reducer.report.containers === recordings[0].containers.filter((container) => container.family === 'toy-reducer').length
      && gate.code === EXIT.fail && checks(gate.report.failures).join() === 'waiver-stale';
  }],
  ['family-required', async ({ recordings, dir }) => {
    // A family the census waives as a whole need not record a case: it is left out of the families the recording must reach.
    const census = censusWith(dir('required'), 'family', (value) => { value.families = [{ family: 'toy-sched', reason: 'planted' }]; });
    const seen = [];
    const { report } = await run(toySetup(recordings, { census, reachableFixtures: true, seen }), { workDir: dir('required-run') });
    return seen.length === 2 && seen.every((list) => !list.includes('toy-sched') && list.includes('toy-reducer')) && report.failures.some((entry) => entry.check === 'waiver-exercised' && entry.family === 'toy-sched');
  }],
  ['family-out', async ({ recordings, dir }) => {
    // --out writes every container, an unstable case marked (with its waiver's reason when one covers it); inside the repository it is refused.
    const out = dir('out-written');
    const census = censusWith(dir('out'), 'unstable', (value) => { value.unstable = [{ file: recordings[0].containers[0].testFile, reason: 'planted waiver' }]; });
    const code = await familyCommand([`--out=${out}`], toySetup(recordings, { census, reachableFixtures: true, change: (recording, index) => { if (index === 2) perturb(recording); } }), { log: () => {}, error: () => {} });
    // Beside the containers, the recording's manifest (manifest.mjs): it lists each of them as written.
    const names = readdirSync(out).filter((name) => name !== MANIFEST_FILE).sort();
    const written = names.map((name) => ({ name, text: readFileSync(path.join(out, name), 'utf8') }));
    const listed = checkManifest(readManifestText(out), written);
    const [marked, ...kept] = readContainer(readFileSync(path.join(out, recordings[0].containers[0].name), 'utf8')).cases;
    const refused = await familyCommand([`--out=${path.join(REPOSITORY_ROOT, 'never-written')}`], toySetup(recordings), { log: () => {}, error: () => {} });
    // The manifest says what the command exited with (manifest version 2, C0g review S3): a failed run's manifest too,
    // and it carries the census items of every family it lists, as the toy map and census give them (pinned).
    const failedOut = dir('out-failed');
    const stale = censusWith(dir('out-stale'), 'stale', (value) => { value.exports.push({ family: 'toy-reducer', export: 'gone', reason: 'planted' }); });
    const failedCode = await familyCommand([`--out=${failedOut}`], toySetup(recordings, { census: stale, reachableFixtures: true }), { log: () => {}, error: () => {} });
    const failedManifest = JSON.parse(readFileSync(path.join(failedOut, MANIFEST_FILE), 'utf8'));
    const items = listed.manifest.items ?? {};
    const itemsPinned = Object.keys(listed.manifest.families).every((family) => items[family]) && JSON.stringify(Object.fromEntries(Object.entries(items).map(([family, entry]) => [family, entry.exports]))) === JSON.stringify(TOY_ITEM_EXPORTS);
    return code === EXIT.pass && names.length === recordings[0].containers.length && names.every((name) => name.endsWith('.ndjson')) && listed.problems.length === 0
      && Object.keys(listed.manifest.containers).length === names.length && listed.manifest.containers[recordings[0].containers[0].name].outcomes.unstable >= 1
      && marked.outcome === 'unstable' && marked.reason.includes('planted waiver')
      && kept.every((record) => record.outcome !== 'unstable') && refused === EXIT.usage
      && listed.manifest.verdict?.code === code && failedCode === EXIT.fail && failedManifest.verdict?.code === failedCode && failedManifest.verdict.failures >= 1 && itemsPinned;
  }],
  ['family-usage', async ({ recordings, dir }) => {
    // A census file that cannot be read, an unknown family, one recording: usage errors (64), never Node's own exit code.
    const broken = path.join(dir('usage'), 'broken.json');
    mkdirSync(path.dirname(broken), { recursive: true });
    writeFileSync(broken, '{ "version": 1, ');
    const quiet = { log: () => {}, error: () => {} };
    const codes = [
      await familyCommand([], toySetup(recordings, { census: broken }), quiet),
      await familyCommand([], toySetup(recordings, { census: censusWith(dir('usage'), 'unknown', (value) => { value.typo = []; }) }), quiet),
      await familyCommand(['--families=nope'], toySetup(recordings), quiet),
      await familyCommand(['--runs=1'], toySetup(recordings), quiet),
      await familyCommand(['--famlies=toy-reducer'], toySetup(recordings), quiet),
    ];
    return codes.every((code) => code === EXIT.usage);
  }],
  ['family-discovery', async ({ dir }) => {
    // End to end on a fixture tree: the discover run finds the test that reaches the family through a re-export, the one
    // through a dynamic import and the one whose only call has no frame, never the one that does not reach it, nor the one
    // whose test code calls it only through engine code; the one that reaches it only through a helper of another name is
    // kept, and the run is inconclusive and names the test file (discovery) and the helper (the recording), nothing else.
    // Each file is run plainly and recorded twice.
    const root = dir('discovery-tree');
    writeFixture(root);
    const setup = { portMapFile: path.join(root, 'map.json'), censusFile: path.join(root, 'census.json'), cwd: path.join(root, 'ui'), root, always: ['src/sync'], search: ['src'], scope: 'ui/src/',
      reachable: () => new Set(['ui/src/sync/m.mjs', 'ui/src/lib/barrel.mjs', 'ui/src/lib/user.mjs']) };
    const { code, report } = await recordFamilies({ setup, workDir: dir('discovery-run'), parallel: 3 });
    const problems = report.incomplete.map((entry) => `${entry.check} ${entry.file}`).sort().join();
    return code === EXIT.inconclusive && problems === 'caller-unclassified ui/src/lib/e.test.mjs,caller-unclassified ui/src/lib/fixtureBuilders.mjs'
      && report.discovery.searched === 6 && report.discovery.found.join() === 'ui/src/lib/a.test.mjs,ui/src/lib/c.test.mjs,ui/src/lib/e.test.mjs,ui/src/lib/g.test.mjs' && report.discovery.missing === 0
      && report.files === 5 && report.cases === 4 && report.outcomes.recorded === 3 && report.outcomes.unrecordable === 1 && report.failures.length === 0;
  }],
]);

/**
 * Runs the family checks (`names` limits them) on `recordings` (two
 * recordings of the toy corpus, record.mjs recordToys), with scratch under
 * `workDir`; returns the failing ones as `{ check, detail }`.
 */
export async function familyChecks({ recordings, workDir, names }) {
  const failures = [];
  let count = 0;
  const dir = (name) => path.join(workDir, `${String((count += 1)).padStart(2, '0')}-${name}`);
  for (const [name, check] of FAMILY_CHECKS) {
    if (names && !names.includes(name)) continue;
    try {
      if (!(await check({ recordings, dir }))) failures.push({ check: name, detail: 'the family command did not do what the fixed input must make it do' });
    } catch (error) {
      failures.push({ check: name, detail: `threw: ${String(error?.stack ?? error).split('\n').slice(0, 4).join(' | ')}` });
    }
  }
  return failures;
}
