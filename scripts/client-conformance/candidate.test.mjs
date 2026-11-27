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
// it). It also holds the client-engine vectors' contract (docs/TESTING.md,
// "Client-engine differential and vectors"), which runs no Rust and no
// product TypeScript: the tracked files' format, their inputs against the
// seeded generators, their descriptors against the port map, and no path of
// the machine that wrote them, so a change to the product's sources never
// fails it.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { capture, candidateChecks, commandChecks, FIELD_CHECKS, OUTSIDE_CHECKS, PER_PUSH_COMMANDS } from './candidate-checks.mjs';
import { CONTRACT, FREEDOMS } from './candidate-compare.mjs';
import { EXIT, loadContract } from './candidate-census.mjs';
import { PRODUCT_CONTRACT, TOY_CONTRACT } from './candidate.mjs';
import { CANDIDATE_PLANTS, PER_PUSH_PLANTS, runCandidatePlants } from './candidate-plants.mjs';
import { createScratch, REPOSITORY_ROOT, EXIT as TOOL_EXIT } from './record.mjs';
import { familyDescriptor, recordReplayToys } from './replay.mjs';
import { PORTED_FAMILIES } from './client-differential.mjs';
import { countsOf, FORMAT, inputsDigest, readVectorFile, vectorFile, vectorInputs } from './client-vectors.mjs';
import { loadPortMap } from './port-map.mjs';

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
    for (const name of ['outside-async-reordered', 'outside-group-leak', 'outside-async-past-later-input', 'groups-cut', 'outside-clock-varying-dropped', 'compared-identity', 'outside-pending-across-group', 'recording-version-refused', 'layout-order-counters', 'judge-difference', 'judge-partial-unasked', 'judge-partial-asked', 'judge-modes-partial', 'judge-not-ported-unasked', 'judge-not-ported-asked', 'census-judged-lost']) assert.ok(names.includes(name), `${name} ran`);
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

  test('the client-engine vectors (package C0i\'s fix round): every ported family has a vector file whose inputs are the generators\' and whose descriptor is the port map\'s', async () => {
    const portMap = loadPortMap(path.join(REPOSITORY_ROOT, 'scripts', 'client-conformance', 'product', 'product-port-map.json'), { root: REPOSITORY_ROOT });
    for (const family of PORTED_FAMILIES) {
      const file = vectorFile(family);
      assert.ok(existsSync(file), `${family}: ${path.relative(REPOSITORY_ROOT, file)} is missing (write it with node scripts/client-conformance/client-vectors.mjs)`);
      const { header, lines, text } = readVectorFile(file);
      assert.equal(header.format, FORMAT);
      assert.equal(header.family, family);
      const { witnesses, ...counts } = header.counts;
      assert.deepEqual(counts, countsOf(family), `${family}: counts`);
      assert.equal(lines.filter((line) => line.witness).length, witnesses ?? 0, `${family}: witnesses`);
      assert.match(header.engine, /^Electron .*'s Node v|^this Node v/, `${family}: the answers are V8's (Electron's Node)`);
      const descriptor = familyDescriptor(portMap, family);
      assert.deepEqual(header.descriptor, { ...descriptor, module: path.relative(REPOSITORY_ROOT, descriptor.module).split(path.sep).join('/') }, `${family}: the descriptor is the port map's`);
      const inputs = await vectorInputs(family);
      assert.equal(inputsDigest(inputs), header.inputs, `${family}: the generators give other inputs than the tracked ones (regenerate the vectors)`);
      assert.equal(inputsDigest(lines), header.inputs, `${family}: a line's inputs were changed by hand`);
      for (const [at, line] of lines.entries()) {
        assert.ok(line.record && typeof line.record === 'object' && ('returns' in line.record || 'throws' in line.record), `${family} call ${at + 1}: a record with a result`);
        assert.ok(Array.isArray(line.engineMessages), `${family} call ${at + 1}: engineMessages`);
      }
      for (const local of [REPOSITORY_ROOT, process.env.HOME, process.env.TMPDIR].filter(Boolean)) assert.ok(!text.includes(local), `${family}: the file holds a path of this machine (${local})`);
    }
  });

  test('the sort vectors of the Rust crate are tracked with their generator', () => {
    const dir = path.join(REPOSITORY_ROOT, 'packages', 'native', 'crates', 'client-engine', 'tests');
    const rows = readFileSync(path.join(dir, 'sort-vectors.tsv'), 'utf8').split('\n').filter((line) => line && !line.startsWith('#'));
    assert.ok(rows.length >= 600, `${rows.length} sort rows`);
    assert.ok(existsSync(path.join(dir, 'generate-sort-vectors.mjs')));
  });
});
