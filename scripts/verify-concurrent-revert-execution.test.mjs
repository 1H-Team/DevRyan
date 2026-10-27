import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { parseNativeExecutionAcceptanceArguments } from './verify-concurrent-revert-execution.mjs';
test('native acceptance command requires an explicit owned v2 artifact root and refuses retired binary selection', () => {
  const artifactRoot = path.resolve('.cache/native-contract-only');
  assert.deepEqual(parseNativeExecutionAcceptanceArguments(['--artifact-root', artifactRoot], {}), { artifactRoot });
  assert.deepEqual(parseNativeExecutionAcceptanceArguments([], { DEVRYAN_TEST_NATIVE_ARTIFACT_ROOT: artifactRoot }), { artifactRoot });
  assert.throws(() => parseNativeExecutionAcceptanceArguments([], {}), /Explicit/);
  assert.throws(() => parseNativeExecutionAcceptanceArguments(['--artifact-root', artifactRoot], { DEVRYAN_TEST_OPENCODE_BINARY: '/unowned/not-to-be-read' }), /retired/);
  assert.throws(() => parseNativeExecutionAcceptanceArguments(['--artifact-root', '/unowned/not-to-be-read'], {}), /repository/);
  for (const args of [['--binary', artifactRoot], ['--artifact-root'], ['--artifact-root', artifactRoot, '--preflight']]) assert.throws(() => parseNativeExecutionAcceptanceArguments(args, {}), /Usage/);
});
