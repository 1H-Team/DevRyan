import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCacheSerializerProbe, gradeSerializedPrefix } from './cache-serializer-probe.mjs';
import { runDuplicateSerializerProbe, inspectDuplicateRequest } from './duplicate-serializer-probe.mjs';
import { probeProviderDefault } from './provider-default-probe.mjs';
import { prepareClaudeQuotaRuntime } from './claude-quota-runtime.mjs';
import { prepareQaProfile } from './profile-preparation.mjs';
import { verifyRevertUi } from './revert-ui.mjs';

test('historical v1 launch entrypoints reject before inspecting supplied executable/profile inputs', async () => {
  const input = new Proxy({}, { get: () => assert.fail('Retired launch path inspected runtime inputs') });
  for (const launch of [runCacheSerializerProbe, runDuplicateSerializerProbe, probeProviderDefault, prepareClaudeQuotaRuntime, prepareQaProfile, verifyRevertUi]) {
    await assert.rejects(launch(input), { code: 'qa_native_diagnostic_unavailable' });
  }
});

test('historical serializer data remains inspectable without enabling a runtime', () => {
  const first = { instructions: ['same'], tools: ['read'], history: ['prior'], cacheParametersHash: 'same' };
  assert.deepEqual(gradeSerializedPrefix(first, { ...first, history: ['prior', 'later'] }), {
    instructionsStable: true, toolsStable: true, priorHistoryStable: true, cacheParametersStable: true,
  });
  const projection = inspectDuplicateRequest({ input: [{ type: 'function_call', call_id: 'call_1' },
    { type: 'function_call_output', call_id: 'call_1', output: 'retained' }] }, '{}');
  assert.equal(projection.callPairsIntact, true);
  assert.equal(projection.bytes, 2);
});
