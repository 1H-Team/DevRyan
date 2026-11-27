// The Rust candidate's wiring into the harness (BH6), without Rust: the
// command line names it, its build inputs and their digest, the plants table
// against the crate's switch list, each plant's scenario and step, and the
// crate's table of Node's file-system error texts against the running Node.
// The real reference-against-Rust run and the plants are commands (docs/TESTING.md).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import util from 'node:util';
import { CANDIDATES, parseArguments } from './conformance-run.mjs';
import { REPOSITORY_ROOT } from './edge.mjs';
import { NATIVE_DIR, RUST_GROUPS, binaryPath, buildCommand, buildInputs, crateDir, inputsDigest } from './rust-candidate.mjs';
import { RUST_PLANTS_BY_GROUP } from './rust-plants.mjs';
import { createSuppliedValues } from './scenario.mjs';
import { CANDIDATE_COMMANDS, SCENARIOS_BY_GROUP } from './scenario-rows.mjs';

const SHARED_DIR = path.join(NATIVE_DIR, 'crates', 'route-common');
const sourceIn = (dir, name) => fs.readFileSync(path.join(dir, 'src', name), 'utf8');
const sources = (dir) => fs.readdirSync(path.join(dir, 'src')).filter((name) => name.endsWith('.rs') && name !== 'plant.rs').map((name) => sourceIn(dir, name)).join('\n');
/** A plant table's ids and enum names: `("id", Plant::Name),` lines. */
const switchesOf = (dir) => [...sourceIn(dir, 'plant.rs').matchAll(/^\s+\("([a-z0-9-]+)", Plant::([A-Za-z0-9]+)\),$/gm)].map((match) => ({ id: match[1], name: match[2] }));

describe('the Rust candidate on the command line', () => {
  test('--candidate names a known candidate of the group, once', () => {
    assert.equal(parseArguments(['--group=magic-prompts', '--candidate=rust']).options.candidate, 'rust');
    assert.equal(parseArguments(['--group=magic-prompts']).options.candidate, null);
    assert.match(parseArguments(['--group=magic-prompts', '--candidate=go']).error, /unknown candidate go/);
    assert.match(parseArguments(['--group=magic-prompts', '--candidate=rust', '--candidate=rust']).error, /given twice/);
    assert.deepEqual(Object.keys(CANDIDATE_COMMANDS['magic-prompts']), [...CANDIDATES['magic-prompts']]);
    assert.deepEqual(RUST_GROUPS, ['magic-prompts', 'session-folders']);
    for (const group of RUST_GROUPS) assert.deepEqual(Object.keys(CANDIDATE_COMMANDS[group]), [...CANDIDATES[group]]);
    assert.equal(parseArguments(['--group=session-folders', '--candidate=rust']).options.candidate, 'rust');
  });

  test('the binary lives in the workspace build folder, and its digest covers its inputs and features', () => {
    for (const group of RUST_GROUPS) {
      assert.ok(binaryPath({ group }).startsWith(path.join(REPOSITORY_ROOT, 'packages', 'native', 'target')));
      assert.notEqual(binaryPath({ plants: true, group }), binaryPath({ group }));
      for (const input of buildInputs(group)) assert.ok(fs.existsSync(path.join(REPOSITORY_ROOT, input)), `${input} exists`);
      assert.ok(buildInputs(group).includes('packages/native/crates/route-common'), 'the shared crate is an input');
      assert.equal(inputsDigest({ group }), inputsDigest({ group }));
      assert.notEqual(inputsDigest({ plants: true, group }), inputsDigest({ group }));
    }
    assert.notEqual(inputsDigest({ group: 'session-folders' }), inputsDigest({ group: 'magic-prompts' }));
    assert.match(buildCommand({ plants: true }), /--plants$/);
  });
});

describe('the Rust plants', () => {
  for (const group of RUST_GROUPS) {
    test(`${group}: the table names exactly the switches its binary has (the group's and the shared ones)`, () => {
      const switches = [...switchesOf(crateDir(group)), ...switchesOf(SHARED_DIR)].map((entry) => entry.id);
      assert.ok(switches.length >= 30, `${switches.length} switches`);
      assert.deepEqual([...RUST_PLANTS_BY_GROUP[group].map((plant) => plant.id)].sort(), [...switches].sort());
    });

    test(`${group}: every switch is used outside its own declaration`, () => {
      for (const [dir, label] of [[crateDir(group), 'Plant'], [SHARED_DIR, 'Plant']]) {
        const code = sources(dir);
        // A group's switch is used as Plant::<name> in its own crate, or (the review's rv-* plants of the shared path)
        // by its id where the shared crate implements it: plant::named("<id>").
        const shared = sources(SHARED_DIR);
        for (const { id, name } of switchesOf(dir)) assert.ok(new RegExp(`${label}::${name}\\b`).test(code) || (dir !== SHARED_DIR && shared.includes(`plant::named("${id}")`)), `${path.basename(dir)}: Plant::${name} (${id}) has a site`);
      }
    });

    test(`${group}: every plant names a scenario of the group and, where it says one, a step of it`, () => {
      const scenarios = SCENARIOS_BY_GROUP[group];
      for (const plant of RUST_PLANTS_BY_GROUP[group]) {
        const scenario = scenarios.find((item) => item.id === plant.scenario);
        assert.ok(scenario, `${plant.id}: scenario ${plant.scenario}`);
        if (plant.expect === 'caught') assert.ok(plant.fault || (plant.component && plant.rule), `${plant.id} names what catches it`);
        else assert.ok(plant.why, `${plant.id} says why it escapes`);
        if (plant.step) {
          const ids = scenario.steps(createSuppliedValues(scenario.id)).map((step) => step.id);
          assert.ok(ids.includes(plant.step), `${plant.id}: step ${plant.step} of ${plant.scenario}`);
        }
      }
    });
  }
});

describe('Node\'s file-system error texts', () => {
  test('the crate\'s table is libuv\'s as this Node gives it, for every name this platform has', () => {
    const table = fs.readFileSync(path.join(SHARED_DIR, 'src', 'uv-errors.tsv'), 'utf8').split('\n').filter((line) => line && !line.startsWith('#')).map((line) => line.split('\t'));
    const node = new Map([...util.getSystemErrorMap().values()].map(([name, message]) => [name, message]));
    let compared = 0;
    for (const [name, message] of table) {
      if (!node.has(name)) continue;
      assert.equal(message, node.get(name), name);
      compared += 1;
    }
    assert.ok(compared >= 60, `${compared} names compared`);
    // Every name the crate maps from an error number has a message in the table.
    const mapped = [...sourceIn(SHARED_DIR, 'uv.rs').matchAll(/\(libc::E[A-Z0-9]+, "(E[A-Z0-9]+)"\)/g)].map((match) => match[1]);
    for (const name of mapped) assert.ok(table.some(([entry]) => entry === name), `${name} is in uv-errors.tsv`);
    for (const name of ['EISDIR', 'EACCES', 'ELOOP', 'ENOENT', 'ENOTDIR', 'ENOSPC']) assert.ok(mapped.includes(name), name);
  });
});
