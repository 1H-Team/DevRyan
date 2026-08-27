import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseProductionBotsVisualArguments } from './capture-production-bots-visuals.mjs';

describe('Production Bots visual capture arguments', () => {
  test('parses explicit isolated evidence settings', () => {
    const parsed = parseProductionBotsVisualArguments([
      '--output', '.cache/visual-output',
      '--base-url', 'http://127.0.0.1:4178/',
      '--case', 'agent-opencode-light-r220,runtime-connected-light-r500',
      '--timeout-ms', '60000',
      '--electron-binary', '/Applications/DevRyan.app/Contents/MacOS/DevRyan',
      '--electron-mode', 'packaged',
    ], { outputDirectory: '/tmp/default' });
    assert.equal(parsed.baseUrl, 'http://127.0.0.1:4178/');
    assert.deepEqual(parsed.caseIds, ['agent-opencode-light-r220', 'runtime-connected-light-r500']);
    assert.equal(parsed.timeoutMs, 60_000);
    assert.equal(parsed.electronBinary, '/Applications/DevRyan.app/Contents/MacOS/DevRyan');
    assert.equal(parsed.electronMode, 'packaged');
  });

  test('rejects unknown flags and unbounded short timeouts', () => {
    assert.throws(
      () => parseProductionBotsVisualArguments(['--unknown', 'value']),
      /Unknown visual capture flag/,
    );
    assert.throws(
      () => parseProductionBotsVisualArguments(['--timeout-ms', '10']),
      /at least 1000/,
    );
    assert.throws(
      () => parseProductionBotsVisualArguments(['--electron-mode', 'other']),
      /raw or packaged/,
    );
  });
});
