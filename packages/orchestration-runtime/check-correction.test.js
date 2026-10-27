import { describe, expect, it } from 'bun:test';
import { applyCheckCorrection, correctedEdgeCommand, parseVitestEdgeCommand, validateCheckCorrection, validateCheckCorrectionHistory } from './check-correction.js';

const check = { name: 'edge unit tests', command: 'npx vitest run supabase/functions/booking-documents/__tests__ --maxWorkers=2',
  paths: ['supabase/functions/booking-documents'], kind: 'command', purpose: 'integration', prerequisites: ['unit fixture'] };
const receipt = { name: check.name, callId: 'call_failed', messageId: 'msg_failed', exitCode: 1, observedAt: 10, status: 'failed', contentHash: 'a'.repeat(64) };
const correction = () => ({ name: check.name, previousCommand: check.command, command: 'npm run test:edge -- --function booking-documents',
  reason: 'repository_edge_deno_runner', observedAt: 20, previousReceipt: receipt,
  runnerIdentity: { kind: 'edge-deno-function-v1', packagePath: 'package.json', packageSha256: 'b'.repeat(64),
    scriptPath: 'scripts/testing/run-deno-tests.mjs', scriptSha256: 'c'.repeat(64), functionName: 'booking-documents', selector: '--function',
    testPath: 'supabase/functions/booking-documents/__tests__', coverageHash: 'a'.repeat(64), verifiedBy: 'host-policy' } });

describe('audited runner correction', () => {
  it('recognizes only the bounded mistaken Vitest convention', () => {
    expect(parseVitestEdgeCommand(check.command)).toEqual({ functionName: 'booking-documents', testPath: 'supabase/functions/booking-documents/__tests__', functionPath: 'supabase/functions/booking-documents' });
    for (const command of ['true', `${check.command}; true`, 'npx vitest run supabase/functions/../__tests__', 'npx vitest run other.test.ts',
      'npx vitest run supabase/functions/booking-documents/__tests__ --passWithNoTests', 'npm run test:edge']) expect(parseVitestEdgeCommand(command)).toBeNull();
    expect(() => correctedEdgeCommand('a;true')).toThrow();
  });

  it('changes only the command, retains immutable history and requires a new receipt', () => {
    const prior = { ...correction(), name: 'prior edge', previousReceipt: undefined, previousCheck: { ...check, name: 'prior edge' } };
    const input = { checks: [structuredClone(check)], receipts: [structuredClone(receipt)], history: [prior] };
    const before = structuredClone(input), audit = correction();
    const next = applyCheckCorrection(input, audit);
    expect(input).toEqual(before);
    expect(next.checks).toEqual([{ ...check, command: audit.command }]);
    expect(next.receipts).toEqual([]);
    expect(next.history).toEqual([prior, { ...audit, previousCheck: check }]);
    expect(Object.isFrozen(next.history[1].previousCheck.paths)).toBe(true);
    expect(Object.isFrozen(next.history[1].previousReceipt)).toBe(true);
    expect(() => next.checks[0].paths.push('unrelated')).toThrow();
    expect(() => applyCheckCorrection(next, audit)).toThrow('required_check_correction_stale');
    expect(validateCheckCorrectionHistory(next.history)).toEqual(next.history);
  });

  it('refuses unrelated commands, changed selectors, coverage or invented receipt history', () => {
    for (const patch of [{ command: 'true' }, { command: 'npm run test:edge -- --function another' }, { paths: ['unrelated'] },
      { runnerIdentity: { ...correction().runnerIdentity, scriptPath: 'unrelated.mjs' } }, { reason: 'skip failure' }, { observedAt: NaN }]) {
      expect(() => validateCheckCorrection({ ...correction(), ...patch }, check)).toThrow();
    }
    expect(() => validateCheckCorrection(correction(), { ...check, paths: ['unrelated'] })).toThrow();
    expect(() => applyCheckCorrection({ checks: [check], receipts: [], history: [] }, correction())).toThrow('required_check_correction_stale');
    const entry = { ...correction(), previousCheck: check };
    expect(() => applyCheckCorrection({ checks: [check], receipts: [receipt], history: Array(128).fill(entry) }, correction())).toThrow('required_check_correction_history_limit');
    expect(() => validateCheckCorrectionHistory([{ ...entry, command: 'true' }])).toThrow();
    expect(() => applyCheckCorrection({ checks: [check], receipts: [{ ...receipt, exitCode: 2 }], history: [] }, correction())).toThrow('required_check_correction_stale');
  });
});
