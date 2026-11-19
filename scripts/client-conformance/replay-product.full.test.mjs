// The closure check over the product recording (docs/TESTING.md, package
// C0d): the product families recorded from the product's own tests (with the
// recording's manifest), every recorded case replayed against the TypeScript
// modules in file order and alone and reproduced exactly, and every planted
// difference in copies of the product modules (replay-product.mjs
// PRODUCT_PLANTS: the design's mutants 1 to 6 and the harness's own) caught by
// its named check. It also checks that no module a mapped family reaches in
// packages/ui uses what the codec does not carry (replay-compare.mjs
// NOT_COMPARED), and that the closure command interrupted while it records
// stops its `bun test` and leaves no scratch. Its name makes it a full-suite
// test (fast `validate` never runs it). It records the product's tests, so a
// product edit that changes what they do can fail it: that is a finding for
// the harness owners, as for the recording command.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { walkBrowserGraph } from '../check-browser-graph.mjs';
import { loadPortMap } from './port-map.mjs';
import { createScratch, EXIT, HARNESS_DIR, REPOSITORY_ROOT } from './record.mjs';
import { judgeReplay, MODES, planContainers, readRecording, replayPlanned, reportLines } from './replay.mjs';
import { interruptTool } from './replay-mutants.mjs';
import { PRODUCT_PLANTS, recordProduct, requiredFamilies, runProductPlants } from './replay-product.mjs';
import { PRODUCT_PORT_MAP, UI_DIR } from './product.mjs';
import { typescriptEngine } from './engine.mjs';

// What the codec does not carry (replay-compare.mjs NOT_COMPARED): a family module that used it could differ unseen.
const UNCARRIED = /Object\.(?:freeze|seal|preventExtensions|defineProperty|defineProperties|isFrozen|isSealed|isExtensible|getOwnPropertyNames|getOwnPropertyDescriptors?)\b|propertyIsEnumerable|Reflect\.(?:defineProperty|ownKeys|preventExtensions)\b|enumerable\s*:/;
// Packages outside packages/ui that the families reach, and why their code cannot reach a compared value that way.
const REACHED_ELSEWHERE = Object.freeze({
  'packages/orchestration-runtime/': 'reached only through sessionTitles.ts importing isManagedTaskPlaceholderSession, a predicate: the values it freezes are its own constants, never returned to a family',
  'packages/shared-runtime/': 'reached only through orchestration-runtime (above); its modules reached use none of these attributes (checked below)',
});
// Reached packages whose reached modules must not use what the codec does not carry either.
const CLEAN_ELSEWHERE = Object.freeze(['packages/shared-runtime/']);

test('no module a mapped family reaches in packages/ui uses what the codec does not carry', () => {
  const portMap = loadPortMap(PRODUCT_PORT_MAP, { root: REPOSITORY_ROOT });
  const entries = portMap.families.map((family) => family.relModule);
  const { visited } = walkBrowserGraph({ root: REPOSITORY_ROOT, entries });
  const ui = [...visited].filter((file) => file.startsWith('packages/ui/src/'));
  assert.ok(entries.every((file) => ui.includes(file)), 'every family module is reached');
  const using = ui.filter((file) => UNCARRIED.test(readFileSync(path.join(REPOSITORY_ROOT, file), 'utf8')));
  assert.deepEqual(using, [], 'a module that freezes, seals or defines properties must have its attributes compared, or be listed in NOT_COMPARED with a reason that holds');
  const elsewhere = [...visited].filter((file) => !file.startsWith('packages/ui/src/'));
  assert.deepEqual(elsewhere.filter((file) => !Object.keys(REACHED_ELSEWHERE).some((prefix) => file.startsWith(prefix))), [], 'a package reached outside packages/ui needs a reason in REACHED_ELSEWHERE');
  assert.deepEqual(elsewhere.filter((file) => CLEAN_ELSEWHERE.some((prefix) => file.startsWith(prefix)) && UNCARRIED.test(readFileSync(path.join(REPOSITORY_ROOT, file), 'utf8'))), []);
});

test('the closure command interrupted while it records stops its bun test and leaves no scratch (SIGINT, SIGHUP)', async () => {
  const runs = await Promise.all([
    interruptTool([path.join(HARNESS_DIR, 'replay-product.mjs'), '--families=tool-status'], 'SIGINT'),
    interruptTool([path.join(HARNESS_DIR, 'product.mjs'), '--families=tool-status'], 'SIGHUP'),
  ]);
  assert.deepEqual(runs.map((run) => run.code), [130, 129]);
  for (const run of runs) {
    assert.equal(run.rootLeft, false, 'the run root is removed');
    assert.deepEqual(run.running, [], 'no process the tool started still runs');
  }
});

// Two recordings of the product and the replays can outlast the suite's default per-test limit under load: a deadline of its own.
test('every recorded product case is reproduced, and every planted difference is caught by its named check', { timeout: 40 * 60 * 1000 }, async (t) => {
  const scratch = createScratch('client-conformance-replay-product');
  let status = 'failed';
  t.after(() => scratch.finish(status));
  const directory = path.join(scratch.dir, 'containers');
  const recorded = await recordProduct({ workDir: path.join(scratch.dir, 'record'), out: directory });
  assert.equal(recorded.code, EXIT.pass, `the product recording exited ${recorded.code}: ${JSON.stringify([...recorded.report.incomplete, ...recorded.report.failures].slice(0, 3))}`);
  const portMap = loadPortMap(PRODUCT_PORT_MAP, { root: REPOSITORY_ROOT });
  // The recording's manifest lists every container written, every family of the map and the counts the recording reported.
  const recording = readRecording(directory, portMap);
  assert.deepEqual(recording.problems, []);
  assert.deepEqual(Object.keys(recording.manifest.families).sort(), portMap.families.map((family) => family.name).sort());
  const listed = Object.values(recording.manifest.containers);
  assert.equal(listed.length, recorded.report.containers);
  assert.equal(listed.reduce((sum, entry) => sum + entry.cases, 0), recorded.report.cases);
  assert.equal(listed.reduce((sum, entry) => sum + (entry.outcomes.recorded ?? 0), 0), recorded.report.outcomes.recorded);
  assert.equal(listed.reduce((sum, entry) => sum + (entry.outcomes.unrecordable ?? 0), 0), recorded.report.outcomes.unrecordable);
  const planned = planContainers(recording.list, portMap);
  assert.deepEqual(planned.problems, []);
  const result = await replayPlanned(planned, { engine: typescriptEngine({ cwd: UI_DIR }), modes: MODES });
  const required = [...new Set([...requiredFamilies(portMap), ...recording.requireFamilies])].sort();
  const verdict = judgeReplay(result, { modes: MODES, requireFamilies: required });
  assert.equal(requiredFamilies(portMap).length, portMap.families.length, 'no product family is waived as untested today');
  assert.equal(verdict.code, EXIT.pass, [...verdict.inconclusive, ...verdict.failures, ...reportLines(result, verdict)].slice(0, 12).join('\n'));
  // The families the map maps today are all replayable by this package: none is left to a later one.
  assert.deepEqual(result.cases.filter((kase) => kase.outcome === 'not-replayable').map((kase) => kase.id), []);
  // Every case the manifest lists as recorded was judged and reproduced, in both modes.
  assert.equal(result.cases.filter((kase) => kase.outcome === 'reproduced').length, recorded.report.outcomes.recorded);
  assert.equal(PRODUCT_PLANTS.filter((plant) => plant.origin.startsWith('design ')).length, 6, 'the design\'s mutants 1 to 6');
  assert.ok(PRODUCT_PLANTS.filter((plant) => plant.origin === 'C0d').length >= 15);
  const plants = await runProductPlants({ directory, workDir: scratch.dir });
  assert.equal(plants.length, PRODUCT_PLANTS.length);
  for (const { plant, caught, differences, inconclusive, error } of plants) {
    assert.equal(error, undefined, `${plant.name}: ${error}`);
    assert.ok(caught, `${plant.name} must be caught by ${plant.expect.check}${plant.expect.kind ? `/${plant.expect.kind}` : ''}${plant.contained ? ' with no case inconclusive' : ''}; differing cases: ${differences.slice(0, 2).join(' || ')}; inconclusive: ${inconclusive.slice(0, 2).join(' || ')}`);
  }
  status = 'passed';
});
