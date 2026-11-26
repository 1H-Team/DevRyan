// Self-test of the candidate comparer of the client engine conformance harness
// (docs/TESTING.md, package C0g), per push: every named check on one replay
// of the toys by the TypeScript engine (the contract's four rules each bite:
// a group's order, a group's boundary, a test call held in a delivery, the
// clock, identity, pending timers; every compared part; a container of
// another recording version refused, and the recorded order held against the
// recorder's own call and timer counters; the judgement of cases not judged,
// partial runs (part of a recording, some modes only: never exit 0) and the
// exit codes; the census and its pins), the command as a process where the cheap checks cannot reach (the
// TypeScript engine on the toys, exit 0; a usage error, exit 64), and one
// planted fault each in the comparer, the census and the command's judgement
// beside an unchanged copy. Every other command check and planted fault runs
// in the full suite (candidate-planted.full.test.mjs). Its subjects are the
// harness's toys only: no product module or test runs here, and nothing
// depends on how long anything takes (every child has a deadline that names
// it).
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { capture, candidateChecks, commandChecks, FIELD_CHECKS, OUTSIDE_CHECKS, PER_PUSH_COMMANDS } from './candidate-checks.mjs';
import { CONTRACT, FREEDOMS } from './candidate-compare.mjs';
import { EXIT, loadContract } from './candidate-census.mjs';
import { PRODUCT_CONTRACT, TOY_CONTRACT } from './candidate.mjs';
import { CANDIDATE_PLANTS, PER_PUSH_PLANTS, runCandidatePlants } from './candidate-plants.mjs';
import { createScratch, EXIT as TOOL_EXIT } from './record.mjs';
import { recordReplayToys } from './replay.mjs';

// One recording of the replayer's toys and one capture of their replay, shared by the tests.
let shared = null;
let sharedScratch = null;
let sharedStatus = 'failed';
after(() => sharedScratch?.finish(sharedStatus));
const setup = () => {
  if (!shared) {
    sharedScratch = createScratch('client-conformance-candidate-self-test');
    shared = (async () => {
      const recording = await recordReplayToys({ workDir: path.join(sharedScratch.dir, 'record') });
      return { recording, captured: await capture({ recording }) };
    })();
  }
  return shared;
};
const scratchFor = (t, owner) => {
  const scratch = createScratch(owner);
  let status = 'failed';
  t.after(() => scratch.finish(status));
  return { dir: scratch.dir, pass: () => { status = 'passed'; } };
};

describe('client conformance candidate comparer self-test', { concurrency: true }, () => {
  test('the freedoms, the parts compared, the judgement and the census on the toys, each a named check', async () => {
    const { recording, captured } = await setup();
    assert.deepEqual(recording.incomplete, [], 'the replayer\'s toys record cleanly');
    const checks = await candidateChecks({ captured });
    const names = checks.map(([name]) => name);
    for (const item of [...OUTSIDE_CHECKS, ...FIELD_CHECKS]) assert.ok(names.includes(item.name), `${item.name} ran`);
    for (const freedom of FREEDOMS) for (const outside of freedom.outside) assert.ok(names.includes(outside), `${freedom.name}: ${outside} ran`);
    // Each kind of rule bites on the toys: a group's order and boundary, a held later input, the clock, identity, pending timers, exit codes.
    for (const name of ['outside-async-reordered', 'outside-group-leak', 'outside-async-past-later-input', 'groups-cut', 'outside-clock-varying-dropped', 'compared-identity', 'outside-pending-across-group', 'recording-version-refused', 'layout-order-counters', 'judge-difference', 'judge-partial-unasked', 'judge-partial-asked', 'judge-modes-partial', 'census-judged-lost']) assert.ok(names.includes(name), `${name} ran`);
    assert.deepEqual(checks.filter(([, problem]) => problem), []);
    assert.ok(checks.length >= 100, `${checks.length} checks`);
    sharedStatus = 'passed';
  });

  test('the command: the TypeScript engine passes the toys, a usage error exits 64', async (t) => {
    const { dir, pass } = scratchFor(t, 'client-conformance-candidate-command');
    const { recording } = await setup();
    const checks = await commandChecks({ workDir: dir, recording, only: [...PER_PUSH_COMMANDS] });
    assert.deepEqual(checks.map(([name]) => name), [...PER_PUSH_COMMANDS]);
    assert.deepEqual(checks.filter(([, problem]) => problem), []);
    pass();
  });

  test('a planted fault each in the comparer, the census and the command\'s judgement fails the check it names; the unchanged copy fails none', async (t) => {
    const { dir, pass } = scratchFor(t, 'client-conformance-candidate-plants');
    const { recording, captured } = await setup();
    assert.equal(new Set(CANDIDATE_PLANTS.map((plant) => plant.name)).size, CANDIDATE_PLANTS.length);
    for (const name of PER_PUSH_PLANTS) assert.ok(CANDIDATE_PLANTS.some((plant) => plant.name === name && !plant.process), `${name} is a pure plant`);
    assert.deepEqual(PER_PUSH_PLANTS.map((name) => name.slice(0, 3)), ['cc-', 'cn-', 'cm-']);
    const { control, plants } = await runCandidatePlants(dir, { captured, recording, only: [...PER_PUSH_PLANTS] });
    assert.deepEqual(control.filter(([, problem]) => problem), [], 'the unchanged copy passes every check a plant names');
    assert.deepEqual(plants.filter((entry) => !entry.caught).map((entry) => `${entry.plant.name} (${entry.plant.check})${entry.error ? `: ${entry.error.slice(0, 300)}` : ''}`), []);
    pass();
  });

  test('the contracts load, the contract is the four rules, and the exit codes are the harness\'s', () => {
    assert.deepEqual({ ...EXIT }, { ...TOOL_EXIT });
    assert.equal(CONTRACT.length, 4);
    const toy = loadContract(TOY_CONTRACT);
    assert.ok(toy.items.every((item) => item.reason.trim()) && toy.unjudged.every((item) => item.reason.trim()));
    const product = loadContract(PRODUCT_CONTRACT);
    assert.ok(Object.keys(product.judged).length >= 20, 'the product contract pins what is judged');
  });
});
