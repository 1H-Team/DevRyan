import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveQaTargetOpenCodeVersion, TARGET_OPENCODE_VERSION } from '../../packages/web/server/lib/opencode/version-policy.js';
import { assertQaCandidateRuntimeVersion, qaPluginSdkVersionForRuntime, resolveQaFixtureGeneration } from './runtime-target.mjs';

const pin = { version: TARGET_OPENCODE_VERSION, source: 'host-pin' };
const candidate = { version: '2.0.20', source: 'DEVRYAN_QA_OPENCODE_VERSION' };

test('fixture generation follows the exact QA target and rejects unknown transport versions or explicit generations', () => {
  assert.equal(resolveQaFixtureGeneration(undefined, pin), 2);
  assert.equal(resolveQaFixtureGeneration(undefined, candidate), 2);
  for (const generation of [2, '2']) assert.equal(resolveQaFixtureGeneration(generation), Number(generation));
  for (const generation of [1, '1', null, '', ' 2 ', '2.0.20', 0, 3, true]) assert.throws(() => resolveQaFixtureGeneration(generation), /generation/);
  for (const version of ['1.18.33', '2.0.21', '3.0.0', 'latest', undefined]) assert.throws(() => resolveQaFixtureGeneration(undefined, { version }), /verified/);
});

test('the host pin is the default target and records its source', () => {
  assert.deepEqual(resolveQaTargetOpenCodeVersion({}), pin);
  assert.deepEqual(resolveQaTargetOpenCodeVersion({ DEVRYAN_QA_OPENCODE_VERSION: '  ' }), pin);
  assert.deepEqual(assertQaCandidateRuntimeVersion(TARGET_OPENCODE_VERSION, pin), pin);
  // The shipped companion runtime is the targeted release plus DevRyan's execution patch.
  assert.deepEqual(assertQaCandidateRuntimeVersion(`${TARGET_OPENCODE_VERSION}-devryan.4`, pin), pin);
});

test('without an explicit target the check follows the environment override', () => {
  const previous = process.env.DEVRYAN_QA_OPENCODE_VERSION;
  try {
    delete process.env.DEVRYAN_QA_OPENCODE_VERSION;
    assert.deepEqual(assertQaCandidateRuntimeVersion(`${TARGET_OPENCODE_VERSION}-devryan.4`), pin);
    process.env.DEVRYAN_QA_OPENCODE_VERSION = '2.0.20';
    assert.deepEqual(assertQaCandidateRuntimeVersion('2.0.20-devryan.1'), candidate);
    assert.throws(() => assertQaCandidateRuntimeVersion('1.18.33'), /does not match the DEVRYAN_QA_OPENCODE_VERSION candidate/);
    process.env.DEVRYAN_QA_OPENCODE_VERSION = 'latest';
    assert.throws(() => assertQaCandidateRuntimeVersion('2.0.20'), /DEVRYAN_QA_OPENCODE_VERSION must be an exact OpenCode version/);
  } finally {
    if (previous === undefined) delete process.env.DEVRYAN_QA_OPENCODE_VERSION;
    else process.env.DEVRYAN_QA_OPENCODE_VERSION = previous;
  }
});

test('an explicit candidate override is honoured and never mistaken for the pin', () => {
  const resolved = resolveQaTargetOpenCodeVersion({ DEVRYAN_QA_OPENCODE_VERSION: '2.0.20' });
  assert.deepEqual(resolved, candidate);
  assert.deepEqual(assertQaCandidateRuntimeVersion('2.0.20', resolved), candidate);
  assert.deepEqual(assertQaCandidateRuntimeVersion('2.0.20-devryan.1', resolved), candidate);
  assert.throws(() => assertQaCandidateRuntimeVersion('1.18.33', resolved), new RegExp(`"1\\.18\\.33" does not match the DEVRYAN_QA_OPENCODE_VERSION candidate 2\\.0\\.20`));
  assert.throws(() => resolveQaTargetOpenCodeVersion({ DEVRYAN_QA_OPENCODE_VERSION: 'latest' }), /exact OpenCode version/);
  assert.throws(() => resolveQaTargetOpenCodeVersion({ DEVRYAN_QA_OPENCODE_VERSION: '2.0' }), /exact OpenCode version/);
});

test('mismatched, prerelease and missing runtime versions fail with expected versus observed', () => {
  assert.throws(() => assertQaCandidateRuntimeVersion('1.18.27', pin), new RegExp(`"1\\.18\\.27" does not match the pinned runtime ${TARGET_OPENCODE_VERSION.replaceAll('.', '\\.')}`));
  assert.throws(() => assertQaCandidateRuntimeVersion('1.18.27-devryan.3', pin), /does not match the pinned runtime/);
  assert.throws(() => assertQaCandidateRuntimeVersion(`${TARGET_OPENCODE_VERSION}-beta.1`, pin), /does not match the pinned runtime/);
  assert.throws(() => assertQaCandidateRuntimeVersion(undefined, pin), /is unavailable; expected the pinned runtime/);
  assert.throws(() => assertQaCandidateRuntimeVersion('', candidate), /is unavailable; expected the DEVRYAN_QA_OPENCODE_VERSION candidate 2\.0\.20/);
  assert.throws(() => assertQaCandidateRuntimeVersion(TARGET_OPENCODE_VERSION, { version: '', source: 'host-pin' }), /exact version and its source/);
  assert.throws(() => assertQaCandidateRuntimeVersion(TARGET_OPENCODE_VERSION, { version: TARGET_OPENCODE_VERSION }), /exact version and its source/);
});

test('the fixture plugin SDK retains the manifest compatibility pin for v2', () => {
  assert.equal(qaPluginSdkVersionForRuntime(TARGET_OPENCODE_VERSION), '1.18.33');
  assert.equal(qaPluginSdkVersionForRuntime(`${TARGET_OPENCODE_VERSION}-devryan.2`), '1.18.33');
  assert.equal(qaPluginSdkVersionForRuntime('2.0.20'), '1.18.33');
  for (const invalid of ['1.18.33', '', 'latest', '2.0', undefined, 42]) assert.throws(() => qaPluginSdkVersionForRuntime(invalid), /exact OpenCode version/);
});
