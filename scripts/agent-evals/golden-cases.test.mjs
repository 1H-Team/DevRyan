import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { GOLDEN_CASES, GOLDEN_CASE_IDS, executeGoldenCase } from './golden-cases.mjs';
import { buildSchemaV1Report, assertSchemaV1ReportSafe } from './report.mjs';

describe('production-derived golden set', () => {
  test('defines thirty unique bounded cases across the six required areas', () => {
    assert.equal(GOLDEN_CASE_IDS.length, 30);
    assert.equal(new Set(GOLDEN_CASE_IDS).size, 30);
    assert.equal(new Set(GOLDEN_CASES.map((entry) => entry.area)).size, 6);
    assert.ok(GOLDEN_CASES.every((entry) => entry.specs.length > 0 && entry.specs.length <= 3));
  });
  test('retains failed or empty contract selections without making model-success claims', async () => {
    const result = await executeGoldenCase({ caseId: 'golden-image-inspection', repetition: 1, timeoutMs: 5000 }, {
      runContract: async () => ({ passed: false, selected: 0, reason: 'contract_selector_empty' }),
    });
    assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'contract_selector_empty');
    const report = buildSchemaV1Report({ executionMode: 'deterministic', caseResults: [result] });
    assert.equal(report.executionMode, 'deterministic');
    assert.equal(report.runs[0].harness.startFingerprint, null);
    assert.equal(report.runs[0].contract.selected, 0);
    assert.equal(report.aggregates.status, 'failed');
    assertSchemaV1ReportSafe(report);
  });
});
