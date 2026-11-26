// The closure check over the product recording (docs/TESTING.md, package
// C0d): the product families recorded from the product's own tests (with the
// recording's manifest), every recorded case replayed against the TypeScript
// modules in file order and alone and reproduced exactly, and every planted
// difference in copies of the product modules (replay-product.mjs
// PRODUCT_PLANTS: the design's mutants 1 to 6 and 8 and the harness's own) caught by
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
  'packages/orchestration-runtime/': 'reached through sessionTitles.ts and, since package C0e, through the stores the store families import (the managed orchestration, config and objective verification stores); its reached modules only freeze (checked below), and a write to a frozen value throws in module code, so no recorded (passing) case makes one',
  'packages/shared-runtime/': 'reached through orchestration-runtime and the config store; its reached modules only freeze (helper-model-selection its default selection; checked below), and a write to a frozen value throws in module code, so no recorded case makes one',
});
// Modules of packages/ui the families reach (package C0e) that freeze values, and why that is no difference unseen: a
// write to a frozen value throws in module code (strict mode), so no recorded (passing) case makes one, and the
// content of every such value is compared; a test's own write to one is test code, never replayed.
const FROZEN_IN_UI = Object.freeze({
  'packages/ui/src/sync/session-creation.ts': "freezes an attempt's captured snapshot (and its attachments), which nothing writes after it is taken",
  'packages/ui/src/lib/opencode/runtime-capabilities.ts': 'freezes its own default and computed capability snapshots, never written',
  'packages/ui/src/sync/session-message-loader.ts': 'freezes its empty load-state constant, never written',
  'packages/ui/src/stores/useManagedOrchestrationStore.ts': 'freezes two empty constants (task ids, dispatch wave index), never written',
  'packages/ui/src/sync/message-pagination-store.ts': 'freezes its default pagination constant, never written',
  'packages/ui/src/lib/sessionChangeAttribution.ts': 'freezes its empty attribution constant, never written',
});
// Reached packages whose reached modules may freeze (above) but must not seal, define properties or read attributes.
const FREEZE_ONLY_ELSEWHERE = Object.freeze(['packages/orchestration-runtime/', 'packages/shared-runtime/']);

test('no module a mapped family reaches in packages/ui uses what the codec does not carry', () => {
  const portMap = loadPortMap(PRODUCT_PORT_MAP, { root: REPOSITORY_ROOT });
  const entries = portMap.families.map((family) => family.relModule);
  const { visited } = walkBrowserGraph({ root: REPOSITORY_ROOT, entries });
  const ui = [...visited].filter((file) => file.startsWith('packages/ui/src/'));
  assert.ok(entries.every((file) => ui.includes(file)), 'every family module is reached');
  const using = ui.filter((file) => UNCARRIED.test(readFileSync(path.join(REPOSITORY_ROOT, file), 'utf8')));
  // Only Object.freeze, and only in the modules listed with their reasons; a listed module that no longer does is stale.
  const onlyFreezes = (file) => !readFileSync(path.join(REPOSITORY_ROOT, file), 'utf8').replace(/Object\.freeze\b/g, '').match(UNCARRIED);
  assert.deepEqual(using.filter((file) => !Object.hasOwn(FROZEN_IN_UI, file) || !onlyFreezes(file)), [], 'a module that freezes, seals or defines properties must have its attributes compared, or be listed in NOT_COMPARED with a reason that holds');
  assert.deepEqual(Object.keys(FROZEN_IN_UI).filter((file) => !using.includes(file)), [], 'a module FROZEN_IN_UI lists is reached and freezes');
  const elsewhere = [...visited].filter((file) => !file.startsWith('packages/ui/src/'));
  assert.deepEqual(elsewhere.filter((file) => !Object.keys(REACHED_ELSEWHERE).some((prefix) => file.startsWith(prefix))), [], 'a package reached outside packages/ui needs a reason in REACHED_ELSEWHERE');
  assert.deepEqual(elsewhere.filter((file) => FREEZE_ONLY_ELSEWHERE.some((prefix) => file.startsWith(prefix)) && !onlyFreezes(file)), [], 'a reached module outside packages/ui only freezes');
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
  // A case unstable between the two recordings (waived) is marked unstable in its container, whatever it was recorded as.
  const unstable = listed.reduce((sum, entry) => sum + (entry.outcomes.unstable ?? 0), 0);
  assert.equal(unstable, new Set(recorded.report.unstableCases.map((entry) => `${entry.container}\0${entry.case}`)).size);
  assert.equal(listed.reduce((sum, entry) => sum + (entry.outcomes.recorded ?? 0) + (entry.outcomes.unrecordable ?? 0), 0) + unstable, recorded.report.outcomes.recorded + recorded.report.outcomes.unrecordable);
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
  assert.equal(result.cases.filter((kase) => kase.outcome === 'reproduced').length, listed.reduce((sum, entry) => sum + (entry.outcomes.recorded ?? 0), 0));
  // Design mutants 7 and 10 as written and 9 are open (PRODUCT_PLANTS says why); none is counted under a substitute.
  assert.equal(PRODUCT_PLANTS.filter((plant) => plant.origin.startsWith('design ')).length, 7, 'the design\'s mutants 1 to 6 and 8 (8 on the event pipeline since package C0f)');
  assert.ok(PRODUCT_PLANTS.filter((plant) => plant.origin === 'C0d').length >= 15);
  assert.ok(PRODUCT_PLANTS.filter((plant) => plant.origin === 'C0e').length >= 25, 'package C0e\'s, at least 25, on the store and time-driven families');
  assert.equal(PRODUCT_PLANTS.filter((plant) => plant.origin === 'C0f').length, 10, 'package C0f\'s ten on the transport families (event pipeline, bootstrap), the flush clamp and the swapped cleanup calls among them');
  const plants = await runProductPlants({ directory, workDir: scratch.dir });
  assert.equal(plants.length, PRODUCT_PLANTS.length);
  for (const { plant, caught, differences, inconclusive, error } of plants) {
    assert.equal(error, undefined, `${plant.name}: ${error}`);
    assert.ok(caught, `${plant.name} must be caught by ${plant.expect.check}${plant.expect.kind ? `/${plant.expect.kind}` : ''}${plant.contained ? ' with no case inconclusive' : ''}; differing cases: ${differences.slice(0, 2).join(' || ')}; inconclusive: ${inconclusive.slice(0, 2).join(' || ')}`);
  }
  status = 'passed';
});
