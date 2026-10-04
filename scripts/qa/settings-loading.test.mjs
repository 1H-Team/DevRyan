import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSettingsLoadingArguments } from './settings-loading.mjs';

test('settings runner selects the v2 fixture without loading an app or installed state', () => {
  for (const generation of [2]) {
    assert.deepEqual(parseSettingsLoadingArguments(['--generation', String(generation)]), { generation });
    assert.deepEqual(parseSettingsLoadingArguments(['--electron', '.cache/qa/synthetic', '--generation', String(generation)]),
      { electron: '.cache/qa/synthetic', generation });
  }
});

test('settings runner rejects ambiguous, malformed and conflicting generation/artifact flags before launch', () => {
  for (const args of [['--generation'], ['--generation', '1'], ['--generation', 'latest'], ['--generation', '3'], ['--generation', '2suffix'],
    ['--generation', '1', '--generation', '2'], ['--baseline', '.cache/qa/before', '--electron', '.cache/qa/app'],
    ['--unknown', '1']]) assert.throws(() => parseSettingsLoadingArguments(args));
});
