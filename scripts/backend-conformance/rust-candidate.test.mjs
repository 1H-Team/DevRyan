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
import { BUILD_INPUTS, CRATE_DIR, binaryPath, buildCommand, inputsDigest } from './rust-candidate.mjs';
import { RUST_PLANTS } from './rust-plants.mjs';
import { createSuppliedValues } from './scenario.mjs';
import { CANDIDATE_COMMANDS } from './scenario-rows.mjs';
import { SCENARIOS } from './scenarios/magic-prompts.mjs';

const source = (name) => fs.readFileSync(path.join(CRATE_DIR, 'src', name), 'utf8');

describe('the Rust candidate on the command line', () => {
  test('--candidate names a known candidate of the group, once', () => {
    assert.equal(parseArguments(['--group=magic-prompts', '--candidate=rust']).options.candidate, 'rust');
    assert.equal(parseArguments(['--group=magic-prompts']).options.candidate, null);
    assert.match(parseArguments(['--group=magic-prompts', '--candidate=go']).error, /unknown candidate go/);
    assert.match(parseArguments(['--group=magic-prompts', '--candidate=rust', '--candidate=rust']).error, /given twice/);
    assert.deepEqual(Object.keys(CANDIDATE_COMMANDS['magic-prompts']), [...CANDIDATES['magic-prompts']]);
  });

  test('the binary lives in the workspace build folder, and its digest covers its inputs and features', () => {
    assert.ok(binaryPath().startsWith(path.join(REPOSITORY_ROOT, 'packages', 'native', 'target')));
    assert.notEqual(binaryPath({ plants: true }), binaryPath());
    for (const input of BUILD_INPUTS) assert.ok(fs.existsSync(path.join(REPOSITORY_ROOT, input)), `${input} exists`);
    assert.equal(inputsDigest(), inputsDigest());
    assert.notEqual(inputsDigest({ plants: true }), inputsDigest());
    assert.match(buildCommand({ plants: true }), /--plants$/);
  });
});

describe('the Rust plants', () => {
  test('the table names exactly the crate\'s switches', () => {
    const switches = [...source('plant.rs').matchAll(/^\s+\("([a-z0-9-]+)", Plant::[A-Za-z0-9]+\),$/gm)].map((match) => match[1]);
    assert.ok(switches.length >= 15, `${switches.length} switches`);
    assert.deepEqual([...RUST_PLANTS.map((plant) => plant.id)].sort(), [...switches].sort());
  });

  test('every switch is used by the crate outside its own declaration', () => {
    const declared = [...source('plant.rs').matchAll(/^\s+\("[a-z0-9-]+", Plant::([A-Za-z0-9]+)\),$/gm)].map((match) => match[1]);
    const code = fs.readdirSync(path.join(CRATE_DIR, 'src')).filter((name) => name.endsWith('.rs') && name !== 'plant.rs').map(source).join('\n');
    for (const name of declared) assert.match(code, new RegExp(`Plant::${name}\\b`), `Plant::${name} has a site`);
  });

  test('every plant names a scenario of the pilot and, where it says one, a step of it', () => {
    for (const plant of RUST_PLANTS) {
      const scenario = SCENARIOS.find((item) => item.id === plant.scenario);
      assert.ok(scenario, `${plant.id}: scenario ${plant.scenario}`);
      if (plant.expect === 'caught') assert.ok(plant.fault || (plant.component && plant.rule), `${plant.id} names what catches it`);
      else assert.ok(plant.why, `${plant.id} says why it escapes`);
      if (plant.step) {
        const ids = scenario.steps(createSuppliedValues(scenario.id)).map((step) => step.id);
        assert.ok(ids.includes(plant.step), `${plant.id}: step ${plant.step} of ${plant.scenario}`);
      }
    }
  });
});

describe('Node\'s file-system error texts', () => {
  test('the crate\'s table is libuv\'s as this Node gives it, for every name this platform has', () => {
    const table = fs.readFileSync(path.join(CRATE_DIR, 'src', 'uv-errors.tsv'), 'utf8').split('\n').filter((line) => line && !line.startsWith('#')).map((line) => line.split('\t'));
    const node = new Map([...util.getSystemErrorMap().values()].map(([name, message]) => [name, message]));
    let compared = 0;
    for (const [name, message] of table) {
      if (!node.has(name)) continue;
      assert.equal(message, node.get(name), name);
      compared += 1;
    }
    assert.ok(compared >= 60, `${compared} names compared`);
    // Every name the crate maps from an error number has a message in the table.
    const mapped = [...source('uv.rs').matchAll(/\(libc::E[A-Z0-9]+, "(E[A-Z0-9]+)"\)/g)].map((match) => match[1]);
    for (const name of mapped) assert.ok(table.some(([entry]) => entry === name), `${name} is in uv-errors.tsv`);
    for (const name of ['EISDIR', 'EACCES', 'ELOOP', 'ENOENT', 'ENOTDIR', 'ENOSPC']) assert.ok(mapped.includes(name), name);
  });
});
