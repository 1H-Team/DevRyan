import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createQaProfileProjectFixture, assertQaProfileProjectFixtureOwned, finishQaProfileProjectFixture,
  ORIGINAL_PROFILE_QA_USER_TEXT, PROFILE_QA_HELD_OUT_CASES } from './profile-project-fixture.mjs';

async function fixture(t, options = {}) {
  const value = await createQaProfileProjectFixture({ runId: 'profile-contract', ...options });
  t.after(() => fs.rm(value.evidenceDirectory, { recursive: true, force: true }));
  return value;
}

test('profile analogue preserves exact user text, a dirty user note, and the approval boundary', async t => {
  const value = await fixture(t, { outputRoot: '.cache/qa' });
  await assertQaProfileProjectFixtureOwned(value);
  assert.ok(path.isAbsolute(value.fixtureRoot));
  assert.deepEqual(value.seed.protectedPaths, ['docs/user-notes.md', 'AGENTS.md']);
  assert.equal(value.seed.manifest.trackedDirty.length, 1);
  assert.match(value.seed.manifest.trackedDirty[0], /docs\/user-notes\.md/);
  assert.equal(value.attachments.length, 0);
  assert.equal(value.originalUserText, ORIGINAL_PROFILE_QA_USER_TEXT);
  assert.ok(value.prompts.initial.startsWith(ORIGINAL_PROFILE_QA_USER_TEXT + '\n\n'));
  const context = JSON.parse(await fs.readFile(path.join(value.evidenceDirectory, 'input-context.json'), 'utf8'));
  assert.equal(context.originalUserTextSha256, createHash('sha256').update(ORIGINAL_PROFILE_QA_USER_TEXT).digest('hex'));
  assert.equal(context.historicalAssembledPrompt, 'unavailable');
  assert.equal(context.inference, 'not-run');
  assert.equal(context.browserVerification, 'not-run');
  assert.deepEqual(context.requestedSelections, { orchestrator: { model: 'openai/gpt-6-astra', variant: 'medium' },
    explorer: { model: 'cursor-acp/grok-4.6', variant: 'medium' } });
  const instructions = await fs.readFile(path.join(value.fixtureRoot, 'AGENTS.md'), 'utf8');
  assert.match(instructions, /Plan mode permits inspection and owned plan persistence only/);
  assert.match(instructions, /do not edit implementation\/tests before UI approval/);
  assert.match(instructions, /independent actual browser evidence/);
  assert.match(instructions, /do not claim those checks from unit tests/);
  assert.match(value.prompts.continue, /authoritative saved plan, task results and repository state/);
  const before = await fs.readFile(path.join(value.fixtureRoot, 'docs/user-notes.md'));
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const baseline = spawnSync(process.execPath, ['--test', 'test/profile.test.mjs'], { cwd: value.fixtureRoot, env,
    encoding: 'utf8', timeout: 10000 });
  assert.equal(baseline.status, 1);
  assert.match(baseline.stdout, /(?:#|ℹ) fail 5/);
  assert.deepEqual(await fs.readFile(path.join(value.fixtureRoot, 'docs/user-notes.md')), before);
  await finishQaProfileProjectFixture(value, 'passed');
});

test('seed defects and held-out inputs cover browser movement, both themes, public routes and editor', async t => {
  const value = await fixture(t);
  const { profileAppearance } = await import(pathToFileURL(path.join(value.fixtureRoot, 'src/profile-appearance.mjs')).href);
  const [viewport, themes, surfaces] = PROFILE_QA_HELD_OUT_CASES;
  assert.deepEqual(viewport.inputs.map(input => profileAppearance(input).chatBottom), [80, 164, 80]);
  assert.ok(viewport.inputs.every(input => profileAppearance(input).navigationVisible === false));
  assert.equal(profileAppearance(themes.inputs[0]).selectedTabFill, '#ffffff');
  assert.equal(profileAppearance(themes.inputs[0]).qualificationFill, '#19395c');
  assert.equal(profileAppearance(themes.inputs[1]).selectedTabFill, themes.expectedByInput[1].selectedTabFill);
  assert.deepEqual([...new Set(surfaces.inputs.map(input => input.surface))], ['professional', 'clinic', 'service', 'editor']);
  for (const input of surfaces.inputs) assert.equal(profileAppearance(input).headerFill, input.scrolled ? '#101723' : 'transparent');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(value.evidenceDirectory, 'held-out-cases.json'), 'utf8')), PROFILE_QA_HELD_OUT_CASES);
  await finishQaProfileProjectFixture(value, 'passed');
});

test('ownership refuses forged or replaced fixtures, pinned seed tampering, and repeated cleanup', async t => {
  const value = await fixture(t, { keepArtifacts: false });
  await assert.rejects(assertQaProfileProjectFixtureOwned({ ...value }), /qa_profile_fixture_owner_invalid/);
  const original = value.fixtureRoot + '-original';
  await fs.rename(value.fixtureRoot, original); await fs.mkdir(value.fixtureRoot, { mode: 0o700 });
  await assert.rejects(finishQaProfileProjectFixture(value), /qa_profile_fixture_owner_invalid/);
  await fs.rmdir(value.fixtureRoot); await fs.rename(original, value.fixtureRoot);
  const seed = await fs.readFile(value.seedManifestPath);
  await fs.appendFile(value.seedManifestPath, '\n');
  await assert.rejects(assertQaProfileProjectFixtureOwned(value), /qa_live_input_changed/);
  await fs.writeFile(value.seedManifestPath, seed);
  await finishQaProfileProjectFixture(value, 'passed');
  await assert.rejects(fs.lstat(value.fixtureRoot), { code: 'ENOENT' });
  assert.equal((await fs.lstat(value.seedManifestPath)).isFile(), true);
  await assert.rejects(finishQaProfileProjectFixture(value), /qa_profile_fixture_owner_invalid/);
});

test('profile allocation rejects invalid names and non-private roots before creating a project', async () => {
  for (const runId of ['', '../escape', 'a'.repeat(81)]) await assert.rejects(createQaProfileProjectFixture({ runId }), /qa_profile_fixture_input_invalid/);
  await assert.rejects(createQaProfileProjectFixture({ outputRoot: process.cwd() }), /qa_live_private_path_required/);
});
