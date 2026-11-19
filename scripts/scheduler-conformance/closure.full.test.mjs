// The closure check over every recording source (design file 30 §4.3, package
// O0c), in the full suite only: the 21 scheduler test files, the package's
// other test files that build a scheduler and the whole scenario corpus, each
// recorded twice, replayed against a second copy of the package; then every
// planted difference and replayer bug of replay-mutants.mjs against the whole
// corpus (the scenarios, every test recording and the awaiting shapes of
// shapes.toy.mjs, which the flush plants are judged on). Minutes, not seconds.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { recordQuick, runClosure } from './closure.mjs';
import { createScratch, REPOSITORY_ROOT } from './record.mjs';
import { COPY_PLANTS, REPLAYER_PLANTS } from './replay-mutants.mjs';
import { EXIT } from './trace.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const scratch = createScratch('scheduler-conformance-closure-full');
let passed = 0;
after(() => { scratch.finish(passed === 2 ? 'passed' : 'failed'); });

let closure;
test('every recording of the three sources is reproduced or classified by its marks, nothing differs', { timeout: 1_800_000 }, async () => {
  closure = await runClosure({ workDir: scratch.dir });
  const { judged } = closure;
  assert.equal(judged.code, EXIT.pass, JSON.stringify(judged.problems.slice(0, 5)));
  assert.equal(judged.counts.different, 0);
  // Every scenario whole; every case a recording marks with no busy input reproduced whole, the others up to their first busy input.
  assert.equal(judged.table.scenarios.reproduced, judged.cases.filter((entry) => entry.source === 'scenarios').length);
  assert.ok(judged.table.tests.reproduced > 0 && judged.table.package.reproduced > 0);
  for (const entry of judged.cases.filter((item) => ['partial', 'crossed', 'unrecordable'].includes(item.outcome))) assert.ok(entry.detail || entry.reason, entry.id);
  passed += 1;
});

test('every planted difference and replayer bug is reported by its own check on the whole corpus', { timeout: 1_800_000 }, async () => {
  assert.ok(closure, 'the closure ran');
  const [scenarios] = closure.containers.scenarios;
  const shapes = await recordQuick({ workDir: path.join(scratch.dir, 'shapes'), tests: ['../../scripts/scheduler-conformance/shapes.toy.mjs'] });
  assert.deepEqual([shapes.problems, shapes.tests.length], [[], 1]);
  const tests = [...closure.containers.tests, ...closure.containers.package, ...shapes.tests];
  const plants = await new Promise((resolve) => {
    const child = spawn('bun', [path.join(HERE, 'replay-mutants.mjs'), `--scenarios=${scenarios}`, `--tests=${tests.join(',')}`, `--root=${scratch.dir}`], { cwd: REPOSITORY_ROOT, env: { ...process.env, TZ: 'UTC', LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('close', () => { try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch (error) { resolve({ error: error.message }); } });
  });
  assert.equal(plants.error, undefined, plants.error);
  assert.deepEqual([plants.unchanged.reproduced, plants.unchanged.code], [plants.unchanged.cases, EXIT.pass]);
  assert.deepEqual(plants.plants.filter((entry) => !entry.caught).map((entry) => `${entry.name}: ${entry.outcome} ${entry.found?.check ?? ''} exit ${entry.code}`), []);
  assert.equal(plants.plants.length, COPY_PLANTS.length);
  assert.deepEqual(plants.replayer.filter((entry) => !entry.caught).map((entry) => entry.name), []);
  assert.equal(plants.replayer.length, REPLAYER_PLANTS.length);
  // The delivery copy is no difference over the whole corpus; the settle-delivery plants against the unchanged copy
  // on the real recordings (O0c review 3, S1), printed with their counts.
  assert.deepEqual([plants.delivery.different, plants.delivery.failing, plants.delivery.delivery?.outcome], [0, null, 'reproduced']);
  for (const entry of plants.replayer.filter((item) => item.name.startsWith('settle-delivered-'))) {
    console.log(`${entry.name} on the real recordings: ${entry.real.different} of ${entry.real.cases} cases different (${entry.real.checks.join(', ') || 'none'})${entry.real.first ? `, first ${entry.real.first.case} [${entry.real.first.check}]` : ''}`);
  }
  // A late delivery is told apart by real recordings too (the scheduler's own next job writes an event the input
  // came before); an early one by none (no recorded job between a settlement and its continuation changes state
  // silently), only by the delivery copy above.
  for (const name of ['settle-delivered-late-1', 'settle-delivered-late-2']) assert.ok(plants.replayer.find((item) => item.name === name).real.different > 0, name);
  passed += 1;
});
