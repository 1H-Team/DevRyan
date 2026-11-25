// The pure judgement of a plant run and the pool that bounds the plant
// processes: fixed inputs, no child process.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgePlants } from './closure.mjs';
import { COPY_PLANTS, defaultPlantWorkers, limiter, REPLAYER_PLANTS } from './replay-mutants.mjs';
import { EXIT } from './trace.mjs';

const real = (different) => ({ cases: 49, different, checks: different ? ['order'] : [], first: different ? { case: 'a case', check: 'order' } : null });
const good = () => ({
  unchanged: { cases: 12, reproduced: 12, code: EXIT.pass },
  plants: COPY_PLANTS.map((plant) => ({ name: plant.name, check: plant.check, caught: true })),
  replayer: REPLAYER_PLANTS.map((plant) => ({ name: plant.name, check: plant.check, caught: true, ...(plant.name.startsWith('settle-delivered-') ? { real: real(plant.name.includes('late') ? 3 : 0) } : {}) })),
  delivery: { cases: 12, different: 0, failing: null, delivery: { outcome: 'reproduced' } },
});
const problemsOf = (change, options) => { const plants = good(); change(plants); return judgePlants(plants, options).problems; };

test('a run in which everything holds has no problem and prints the settle plants on real recordings', () => {
  const found = judgePlants(good());
  assert.deepEqual(found.problems, []);
  assert.equal(found.lines.length, 3);
  assert.match(found.lines.join('\n'), /settle-delivered-late-1 on the real recordings: 3 of 49 cases different \(order\)/);
});

test('each thing that must hold is a problem of its own when it does not', () => {
  assert.match(judgePlants({ error: 'the plant tool did not finish' }).problems[0], /did not finish/);
  assert.match(judgePlants(null).problems[0], /no plant result/);
  assert.match(problemsOf((p) => { p.unchanged.reproduced = 11; })[0], /unchanged copy reproduced 11 of 12/);
  assert.match(problemsOf((p) => { p.unchanged.code = EXIT.fail; })[0], /unchanged copy/);
  assert.match(problemsOf((p) => { p.unchanged = { cases: 0, reproduced: 0, code: EXIT.pass }; })[0], /unchanged copy/);
  assert.match(problemsOf((p) => { p.unchanged = { error: 'the copy plants a, b did not finish within 5 ms and was killed' }; })[0], /did not finish within 5 ms/);
  assert.match(problemsOf((p) => { p.plants[0].caught = false; })[0], new RegExp(`planted copy ${COPY_PLANTS[0].name} was not caught`));
  assert.match(problemsOf((p) => { p.plants.pop(); })[0], new RegExp(`${COPY_PLANTS.length - 1} planted copies were judged, ${COPY_PLANTS.length} exist`));
  assert.match(problemsOf((p) => { p.replayer[0].caught = false; })[0], new RegExp(`planted replayer bug ${REPLAYER_PLANTS[0].name} was not caught`));
  assert.match(problemsOf((p) => { p.replayer.shift(); }).join('\n'), /planted replayer bugs were judged/);
  assert.match(problemsOf((p) => { p.delivery.different = 1; })[0], /delivery copy is a difference/);
  assert.match(problemsOf((p) => { p.delivery.failing = { case: 'x' }; })[0], /delivery copy is a difference/);
  assert.match(problemsOf((p) => { p.delivery.delivery = null; })[0], /delivery case is missing/);
  assert.match(problemsOf((p) => { p.delivery = { error: 'the delivery control did not finish' }; })[0], /delivery control/);
});

test('a late settlement delivery must differ on a real recording, unless the corpus holds none', () => {
  const noLate = (p) => { p.replayer.find((entry) => entry.name === 'settle-delivered-late-2').real = real(0); };
  assert.deepEqual(problemsOf(noLate), ['settle-delivered-late-2 differs on no real recording']);
  assert.deepEqual(problemsOf(noLate, { lateOnReal: false }), []);
});

test('the pool runs at most its number at once, in order, and passes results and failures through', async () => {
  const queued = limiter(2);
  let active = 0;
  let most = 0;
  const started = [];
  const job = (name, fail = false) => queued(async () => {
    started.push(name);
    active += 1; most = Math.max(most, active);
    await new Promise((resolve) => { setImmediate(resolve); });
    active -= 1;
    if (fail) throw new Error(name);
    return name;
  });
  const results = await Promise.allSettled([job('a'), job('b'), job('c', true), job('d'), job('e')]);
  assert.equal(most, 2);
  assert.deepEqual(started, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(results.map((result) => result.value ?? `failed ${result.reason.message}`), ['a', 'b', 'failed c', 'd', 'e']);
});

test('the default number of plant processes leaves a core free and never exceeds four', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 8, 64].map((cores) => defaultPlantWorkers(cores)), [1, 1, 2, 3, 4, 4, 4]);
});
