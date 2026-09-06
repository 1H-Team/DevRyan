import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createQaProjectFixture, createQaProjectPrompts, removeQaProjectFixture } from './project-fixture.mjs';

const repoRoot = fileURLToPath(new URL('../../',import.meta.url));
const fixture = () => createQaProjectFixture({runId:'fixture-contract'});
const dispose = (value) => { removeQaProjectFixture(value); rmSync(value.evidenceDirectory,{recursive:true,force:true}); };

test('fresh fixtures contain reproducible seeds, real PNG requirements, and a preserved dirty user edit', () => {
  const first = fixture(); const second = fixture();
  try {
    assert.notEqual(first.fixtureRoot,second.fixtureRoot);
    assert.equal(first.seedManifestSha256,second.seedManifestSha256);
    assert.equal(first.seed.manifest.trackedDirty.length,1);
    assert.match(first.seed.manifest.trackedDirty[0],/docs\/user-notes.md/);
    const image = readFileSync(first.attachments[1].path);
    assert.deepEqual([...image.subarray(0,8)],[137,80,78,71,13,10,26,10]);
    assert.equal(image.readUInt32BE(16),360); assert.equal(image.readUInt32BE(20),180);
    const testEnv = {...process.env}; delete testEnv.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath,['--test','test/tasks.test.mjs'],{cwd:first.fixtureRoot,encoding:'utf8',timeout:10_000,env:testEnv});
    assert.equal(run.status,1);
    assert.match(run.stdout,/(?:#|ℹ) pass 1/); assert.match(run.stdout,/(?:#|ℹ) fail 2/);
    assert.ok(!first.seedManifestPath.startsWith(first.fixtureRoot + path.sep));
  } finally { dispose(first); dispose(second); }
});

test('prompt stages retain primary-agent identity and orthogonal plan/revision controls', () => {
  const prompts = createQaProjectPrompts({agent:'orchestrator',planMode:true});
  assert.match(prompts.initial,/Delegate independent investigation/);
  assert.match(prompts.initial,/Do not edit implementation or tests before approval/);
  assert.match(prompts.revision,/reject the previously proposed automatic priority sorting/);
  assert.match(prompts.approve,/current revision 2 plan is approved/);
  assert.throws(() => createQaProjectPrompts({agent:'plan'}), /Invalid/);
});

test('project instructions assign executable native checks to agents and browser inspection to independent QA', () => {
  const project = fixture();
  try {
    const instructions = [readFileSync(path.join(project.fixtureRoot, 'AGENTS.md'), 'utf8')];
    for (const agent of ['builder', 'orchestrator']) {
      for (const planMode of [false, true]) {
        const prompts = createQaProjectPrompts({ agent, planMode });
        instructions.push(prompts.initial, prompts.approve, prompts.continue);
      }
    }
    for (const text of instructions) {
      assert.match(text, /native bash for the full test suite, HTTP API checks/);
      assert.match(text, /persistence after stopping and restarting the server/);
      assert.match(text, /independent QA browser will inspect the resulting UI/);
      assert.match(text, /report that browser check as pending/);
      assert.match(text, /Do not discover or install browser tooling/);
      assert.match(text, /request access outside this repository for browser verification/);
      assert.match(text, /node --test test\/tasks\.test\.mjs/);
      assert.match(text, /numeric.*exit status/);
      assert.match(text, /`npm test`/);
      assert.doesNotMatch(text, /exercise the browser UI/);
    }
  } finally { dispose(project); }
});

test('cleanup refuses unowned or replaced directories and leaves sibling fixtures intact', () => {
  const first = fixture(); const second = fixture();
  const displaced = first.fixtureRoot + '-original';
  try {
    assert.throws(() => removeQaProjectFixture({...first}), /ownership/);
    renameSync(first.fixtureRoot,displaced); mkdirSync(first.fixtureRoot);
    assert.throws(() => removeQaProjectFixture(first), /identity changed/);
    rmSync(first.fixtureRoot,{recursive:true}); renameSync(displaced,first.fixtureRoot);
    removeQaProjectFixture(first);
    assert.ok(lstatSync(second.fixtureRoot).isDirectory());
    assert.ok(lstatSync(first.seedManifestPath).isFile());
    assert.throws(() => removeQaProjectFixture(first), /ownership/);
  } finally { rmSync(first.evidenceDirectory,{recursive:true,force:true}); dispose(second); }
});

test('fixture allocation rejects arbitrary roots and symlink escapes before writing', () => {
  assert.throws(() => createQaProjectFixture({outputRoot:repoRoot}), /inside repository .cache/);
  const first = fixture();
  const alias = path.join(first.evidenceDirectory,'escaped');
  try {
    symlinkSync(repoRoot,alias);
    assert.throws(() => createQaProjectFixture({outputRoot:path.join(alias,'never-created')}), /may not escape/);
  } finally { dispose(first); }
});
